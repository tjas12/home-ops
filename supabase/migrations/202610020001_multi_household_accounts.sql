create extension if not exists pgcrypto;

alter table public.households
  add column if not exists created_by uuid references public.users(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

alter table public.users
  add column if not exists display_name text,
  alter column household_id drop not null;

alter table public.users
  drop constraint if exists users_role_check;

alter table public.users
  alter column role drop not null,
  alter column role set default 'member';

update public.users
set display_name = coalesce(display_name, nullif(name, ''), email),
    role = case when role in ('Husband', 'Wife') then role else coalesce(role, 'member') end;

create table if not exists public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  unique (household_id, user_id)
);

insert into public.household_members (household_id, user_id, role, joined_at)
select household_id, id,
  case when role = 'Husband' then 'owner' else 'member' end,
  created_at
from public.users
where household_id is not null
on conflict (household_id, user_id) do nothing;

update public.households h
set created_by = coalesce(
  h.created_by,
  (
    select hm.user_id
    from public.household_members hm
    where hm.household_id = h.id
    order by case when hm.role = 'owner' then 0 else 1 end, hm.joined_at
    limit 1
  )
)
where h.created_by is null;

create table if not exists public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  invited_email text,
  invite_token text not null unique default encode(gen_random_bytes(32), 'hex'),
  invited_by uuid not null references public.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create index if not exists household_members_household_idx on public.household_members (household_id);
create index if not exists household_members_user_idx on public.household_members (user_id);
create index if not exists household_invites_token_idx on public.household_invites (invite_token);
create index if not exists household_invites_household_idx on public.household_invites (household_id);

alter table public.tasks add column if not exists assigned_user_id uuid references public.users(id) on delete set null;
alter table public.reminders add column if not exists assigned_user_id uuid references public.users(id) on delete set null;
alter table public.events add column if not exists assigned_user_id uuid references public.users(id) on delete set null;
alter table public.bills add column if not exists assigned_user_id uuid references public.users(id) on delete set null;
alter table public.routines add column if not exists assigned_user_id uuid references public.users(id) on delete set null;

alter table public.tasks drop constraint if exists tasks_assigned_to_check;
alter table public.reminders drop constraint if exists reminders_assigned_to_check;
alter table public.events drop constraint if exists events_assigned_to_check;
alter table public.bills drop constraint if exists bills_assigned_to_check;
alter table public.routines drop constraint if exists routines_assigned_to_check;

create table if not exists public.user_notification_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  push_enabled boolean not null default true,
  email_enabled boolean not null default true,
  sms_enabled boolean not null default false,
  quiet_hours_start time,
  quiet_hours_end time,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.queue_due_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  household_user public.users%rowtype;
  notify_title text;
  notify_message text;
  notify_when timestamptz;
  followup_type text;
  followup_title text;
  followup_when timestamptz;
begin
  if tg_table_name = 'tasks' then
    notify_title := 'Task due: ' || new.title;
    notify_message := coalesce(new.description, new.title);
    notify_when := ((new.due_date + coalesce(new.due_time, time '09:00')) at time zone 'America/Chicago') - interval '1 hour';
    followup_type := 'task_overdue';
    followup_title := 'Task overdue: ' || new.title;
    followup_when := ((new.due_date + 1 + time '09:00') at time zone 'America/Chicago');
  elsif tg_table_name = 'reminders' then
    notify_title := 'Reminder: ' || new.title;
    notify_message := coalesce(new.notes, new.title);
    notify_when := (new.reminder_date + coalesce(new.reminder_time, time '09:00')) at time zone 'America/Chicago';
  elsif tg_table_name = 'events' then
    notify_title := 'Event: ' || new.title;
    notify_message := coalesce(new.location, new.title);
    notify_when := ((new.event_date + coalesce(new.start_time, time '09:00')) at time zone 'America/Chicago') - interval '30 minutes';
  elsif tg_table_name = 'bills' then
    notify_title := 'Bill due: ' || new.name;
    notify_message := new.name || ' is due soon.';
    notify_when := ((new.due_date - 3) + time '09:00') at time zone 'America/Chicago';
    followup_type := 'bill_overdue';
    followup_title := 'Bill overdue: ' || new.name;
    followup_when := ((new.due_date + 1 + time '09:00') at time zone 'America/Chicago');
  else
    return new;
  end if;

  delete from public.notifications
  where related_item_type = tg_table_name
    and related_item_id = new.id
    and status = 'pending';

  for household_user in
    select u.*
    from public.users u
    join public.household_members hm on hm.user_id = u.id
    where hm.household_id = new.household_id
      and (
        new.assigned_user_id is null
        or new.assigned_user_id = u.id
      )
  loop
    insert into public.notifications (
      household_id, user_id, type, title, message, recipient,
      related_item_type, related_item_id, scheduled_for, delivery_method
    ) values (
      new.household_id, household_user.id, tg_table_name || '_due', notify_title, notify_message, household_user.email,
      tg_table_name, new.id, notify_when, 'email'
    );
    if followup_when is not null then
      insert into public.notifications (
        household_id, user_id, type, title, message, recipient,
        related_item_type, related_item_id, scheduled_for, delivery_method
      ) values (
        new.household_id, household_user.id, followup_type, followup_title, notify_message, household_user.email,
        tg_table_name, new.id, followup_when, 'email'
      );
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists queue_task_notification on public.tasks;
create trigger queue_task_notification after insert or update of due_date, due_time, assigned_to, assigned_user_id on public.tasks
for each row when (new.completed = false) execute procedure public.queue_due_notification();

drop trigger if exists queue_reminder_notification on public.reminders;
create trigger queue_reminder_notification after insert or update of reminder_date, reminder_time, assigned_to, assigned_user_id on public.reminders
for each row when (new.completed = false) execute procedure public.queue_due_notification();

drop trigger if exists queue_event_notification on public.events;
create trigger queue_event_notification after insert or update of event_date, start_time, assigned_to, assigned_user_id on public.events
for each row when (new.completed = false) execute procedure public.queue_due_notification();

drop trigger if exists queue_bill_notification on public.bills;
create trigger queue_bill_notification after insert or update of due_date, assigned_to, assigned_user_id on public.bills
for each row when (new.status = 'unpaid') execute procedure public.queue_due_notification();

create or replace function public.is_household_member(household_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members hm
    where hm.household_id = household_uuid
      and hm.user_id = (select auth.uid())
  )
$$;

create or replace function public.is_household_owner(household_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members hm
    where hm.household_id = household_uuid
      and hm.user_id = (select auth.uid())
      and hm.role = 'owner'
  )
$$;

create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select u.household_id from public.users u where u.id = (select auth.uid()) and u.household_id is not null),
    (select hm.household_id from public.household_members hm where hm.user_id = (select auth.uid()) order by hm.joined_at limit 1)
  )
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.approved_access%rowtype;
  profile_name text;
begin
  profile_name := coalesce(
    nullif(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    split_part(lower(new.email), '@', 1)
  );

  select * into access_row
  from public.approved_access
  where email = lower(new.email);

  if found then
    insert into public.users (id, email, name, display_name, role, household_id)
    values (new.id, lower(new.email), access_row.name, access_row.name, access_row.role, access_row.household_id)
    on conflict (id) do update set
      email = excluded.email,
      name = excluded.name,
      display_name = excluded.display_name,
      role = excluded.role,
      household_id = excluded.household_id;

    insert into public.household_members (household_id, user_id, role)
    values (
      access_row.household_id,
      new.id,
      case when access_row.role = 'Husband' then 'owner' else 'member' end
    )
    on conflict (household_id, user_id) do nothing;
  else
    insert into public.users (id, email, name, display_name, role, household_id)
    values (new.id, lower(new.email), profile_name, profile_name, 'member', null)
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

create or replace function public.accept_household_invite(invite_token_text text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_row public.household_invites%rowtype;
  auth_user_id uuid := (select auth.uid());
begin
  if auth_user_id is null then
    raise exception 'You must be signed in to accept an invitation.';
  end if;

  select * into invite_row
  from public.household_invites
  where invite_token = invite_token_text
  for update;

  if not found then
    raise exception 'This invitation is invalid.';
  end if;

  if invite_row.status <> 'pending' then
    raise exception 'This invitation has already been used or revoked.';
  end if;

  if invite_row.expires_at <= now() then
    update public.household_invites
    set status = 'expired'
    where id = invite_row.id;
    raise exception 'This invitation has expired.';
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (invite_row.household_id, auth_user_id, 'member')
  on conflict (household_id, user_id) do nothing;

  update public.users
  set household_id = coalesce(household_id, invite_row.household_id)
  where id = auth_user_id;

  update public.household_invites
  set status = 'accepted',
      accepted_at = now()
  where id = invite_row.id;

  return invite_row.household_id;
end;
$$;

create or replace function public.remove_household_member(member_row_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  member_row public.household_members%rowtype;
  auth_user_id uuid := (select auth.uid());
  owner_count integer;
begin
  if auth_user_id is null then
    raise exception 'You must be signed in.';
  end if;

  select * into member_row
  from public.household_members
  where id = member_row_id
  for update;

  if not found then
    raise exception 'Household member not found.';
  end if;

  if not public.is_household_owner(member_row.household_id) then
    raise exception 'Only household owners can remove members.';
  end if;

  if member_row.user_id = auth_user_id then
    raise exception 'You cannot remove yourself from the household.';
  end if;

  if member_row.role = 'owner' then
    select count(*) into owner_count
    from public.household_members
    where household_id = member_row.household_id
      and role = 'owner';

    if owner_count <= 1 then
      raise exception 'You cannot remove the final household owner.';
    end if;
  end if;

  delete from public.household_members where id = member_row.id;

  update public.users
  set household_id = (
    select hm.household_id
    from public.household_members hm
    where hm.user_id = member_row.user_id
    order by hm.joined_at
    limit 1
  )
  where id = member_row.user_id
    and household_id = member_row.household_id;
end;
$$;

alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.user_notification_settings enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "household members can read household" on public.households;
drop policy if exists "household members can read profiles" on public.users;
drop policy if exists "household members can update own profile" on public.users;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['tasks','reminders','events','bills','routines','weekly_plans','notification_settings','notifications']
  loop
    execute format('drop policy if exists "household access" on public.%I', table_name);
  end loop;
end $$;

drop policy if exists "household access to routine items" on public.routine_items;
drop policy if exists "household access to routine completions" on public.routine_completions;

create policy "members can read households"
on public.households for select
to authenticated
using (public.is_household_member(id));

create policy "users can create households"
on public.households for insert
to authenticated
with check (created_by = (select auth.uid()));

create policy "owners can update households"
on public.households for update
to authenticated
using (public.is_household_owner(id))
with check (public.is_household_owner(id));

create policy "members can read household profiles"
on public.users for select
to authenticated
using (
  id = (select auth.uid())
  or exists (
    select 1
    from public.household_members mine
    join public.household_members theirs on theirs.household_id = mine.household_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = users.id
  )
);

create policy "users can update own profile"
on public.users for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy "users can insert own profile"
on public.users for insert
to authenticated
with check (id = (select auth.uid()));

create policy "members can read household memberships"
on public.household_members for select
to authenticated
using (public.is_household_member(household_id));

create policy "users can join household they created"
on public.household_members for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (
    public.is_household_owner(household_id)
    or exists (
      select 1 from public.households h
      where h.id = household_id
        and h.created_by = (select auth.uid())
    )
  )
);

create policy "owners can manage household memberships"
on public.household_members for update
to authenticated
using (public.is_household_owner(household_id))
with check (public.is_household_owner(household_id));

create policy "owners can delete household memberships"
on public.household_members for delete
to authenticated
using (public.is_household_owner(household_id));

create policy "owners can manage invites"
on public.household_invites for all
to authenticated
using (public.is_household_owner(household_id))
with check (public.is_household_owner(household_id) and invited_by = (select auth.uid()));

do $$
declare
  table_name text;
begin
  foreach table_name in array array['tasks','reminders','events','bills','routines','weekly_plans','notification_settings','notifications']
  loop
    execute format(
      'create policy "household member access" on public.%I for all to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))',
      table_name
    );
  end loop;
end $$;

create policy "household member access to routine items"
on public.routine_items for all
to authenticated
using (exists (
  select 1 from public.routines
  where routines.id = routine_items.routine_id
    and public.is_household_member(routines.household_id)
))
with check (exists (
  select 1 from public.routines
  where routines.id = routine_items.routine_id
    and public.is_household_member(routines.household_id)
));

create policy "household member access to routine completions"
on public.routine_completions for all
to authenticated
using (exists (
  select 1 from public.routines
  where routines.id = routine_completions.routine_id
    and public.is_household_member(routines.household_id)
))
with check (exists (
  select 1 from public.routines
  where routines.id = routine_completions.routine_id
    and public.is_household_member(routines.household_id)
));

create policy "users can manage own notification settings"
on public.user_notification_settings for all
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "users can manage own push subscriptions"
on public.push_subscriptions for all
to authenticated
using (user_id = (select auth.uid()) and public.is_household_member(household_id))
with check (user_id = (select auth.uid()) and public.is_household_member(household_id));

grant select, insert, update, delete on public.household_members to authenticated;
grant select, insert, update, delete on public.household_invites to authenticated;
grant select, insert, update, delete on public.user_notification_settings to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant execute on function public.accept_household_invite(text) to authenticated;
grant execute on function public.remove_household_member(uuid) to authenticated;