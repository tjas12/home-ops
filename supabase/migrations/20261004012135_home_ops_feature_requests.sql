begin;

alter table public.tasks add column if not exists reminder_minutes integer;
alter table public.events add column if not exists reminder_minutes integer;
alter table public.events add column if not exists end_date date;
-- Push was deployed separately from the original checked-in schema.
alter table public.notifications drop constraint if exists notifications_delivery_method_check;
alter table public.notifications add constraint notifications_delivery_method_check check (delivery_method in ('in_app','email','sms','push'));
alter table public.tasks add constraint tasks_reminder_minutes_check check (reminder_minutes is null or reminder_minutes in (5,30,60));
alter table public.events add constraint events_reminder_minutes_check check (reminder_minutes is null or reminder_minutes in (5,30,60));
alter table public.events add constraint events_end_date_check check (end_date is null or end_date >= event_date);

-- Composite references prevent a valid UUID from linking across households.
alter table public.weekly_plans add constraint weekly_plans_id_household_unique unique (id, household_id);
create table public.weekly_plan_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  weekly_plan_id uuid,
  item_type text not null check (item_type in ('priority','chore','bill','meal','appointment','shopping','note')),
  title text not null check (length(btrim(title)) > 0),
  scheduled_date date,
  scheduled_time time,
  assigned_user_id uuid,
  completed boolean not null default false,
  completed_by uuid references public.users(id) on delete set null,
  completed_at timestamptz,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (weekly_plan_id,household_id) references public.weekly_plans(id,household_id) on delete cascade,
  foreign key (household_id,assigned_user_id) references public.household_members(household_id,user_id) on delete set null (assigned_user_id),
  check (scheduled_time is null or scheduled_date is not null)
);
alter table public.weekly_plan_items enable row level security;
revoke all on public.weekly_plan_items from anon;
grant select,insert,update,delete on public.weekly_plan_items to authenticated;
create policy "members select weekly items" on public.weekly_plan_items for select to authenticated using (public.is_household_member(household_id));
create policy "members insert weekly items" on public.weekly_plan_items for insert to authenticated with check (public.is_household_member(household_id) and created_by = (select auth.uid()));
create policy "members update weekly items" on public.weekly_plan_items for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy "members delete weekly items" on public.weekly_plan_items for delete to authenticated using (public.is_household_member(household_id));
create index weekly_plan_items_household_date_idx on public.weekly_plan_items(household_id,scheduled_date,scheduled_time);
create index events_household_span_idx on public.events(household_id,event_date,end_date);

create function public.touch_weekly_plan_item() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if new.completed then
    new.completed_at := coalesce(new.completed_at,now());
    new.completed_by := coalesce(new.completed_by,auth.uid());
  else
    new.completed_at := null;
    new.completed_by := null;
  end if;
  return new;
end $$;
create trigger touch_weekly_plan_item before insert or update on public.weekly_plan_items for each row execute function public.touch_weekly_plan_item();

-- Postgres resolves Chicago wall-clock times with its timezone database, including DST.
-- Only the existing privileged scheduler can enumerate reminders across households.
create function public.home_ops_due_push_items(p_now timestamptz default now()) returns table (
  source_type text, item jsonb, occurrence_key text
) language sql stable set search_path = public as $$
  select 'task',to_jsonb(t),concat(t.due_date,'T',t.due_time,':',t.reminder_minutes)
  from public.tasks t
  where not t.completed and t.reminder_minutes in (5,30,60) and t.due_time is not null
    and ((t.due_date + t.due_time) at time zone 'America/Chicago') - make_interval(mins => t.reminder_minutes) between p_now - interval '5 minutes' and p_now
  union all
  select 'event',to_jsonb(e),concat(e.event_date,'T',e.start_time,':',e.reminder_minutes)
  from public.events e
  where not e.completed and e.status <> 'cancelled' and e.reminder_minutes in (5,30,60) and e.start_time is not null
    and ((e.event_date + e.start_time) at time zone 'America/Chicago') - make_interval(mins => e.reminder_minutes) between p_now - interval '5 minutes' and p_now;
$$;
revoke all on function public.home_ops_due_push_items(timestamptz) from public,anon,authenticated;
grant execute on function public.home_ops_due_push_items(timestamptz) to service_role;

create function public.home_ops_chicago_day_start(p_date date) returns timestamptz language sql stable as $$
  select (p_date + time '00:00') at time zone 'America/Chicago';
$$;
revoke all on function public.home_ops_chicago_day_start(date) from public,anon,authenticated;
grant execute on function public.home_ops_chicago_day_start(date) to service_role;

delete from public.notifications n where n.status = 'pending' and (
  (n.type = 'tasks_due' and exists (select 1 from public.tasks t where t.id = n.related_item_id and t.household_id = n.household_id and t.reminder_minutes is null))
  or (n.type = 'events_due' and exists (select 1 from public.events e where e.id = n.related_item_id and e.household_id = n.household_id and e.reminder_minutes is null))
);

-- Respect the selected lead time in the existing email queue as well.
-- Unrelated reminder, bill and overdue behavior is retained.
create or replace function public.queue_due_notification()
returns trigger language plpgsql security definer set search_path = public as $$
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
    notify_message := coalesce(new.description,new.title);
    if new.reminder_minutes is not null and new.due_time is not null then
      notify_when := ((new.due_date + new.due_time) at time zone 'America/Chicago') - make_interval(mins => new.reminder_minutes);
    end if;
    followup_type := 'task_overdue';
    followup_title := 'Task overdue: ' || new.title;
    followup_when := (new.due_date + 1 + time '09:00') at time zone 'America/Chicago';
  elsif tg_table_name = 'events' then
    notify_title := 'Event: ' || new.title;
    notify_message := coalesce(new.location,new.title);
    if new.reminder_minutes is not null and new.start_time is not null and new.status <> 'cancelled' then
      notify_when := ((new.event_date + new.start_time) at time zone 'America/Chicago') - make_interval(mins => new.reminder_minutes);
    end if;
  elsif tg_table_name = 'reminders' then
    notify_title := 'Reminder: ' || new.title;
    notify_message := coalesce(new.notes,new.title);
    notify_when := (new.reminder_date + coalesce(new.reminder_time,time '09:00')) at time zone 'America/Chicago';
  elsif tg_table_name = 'bills' then
    notify_title := 'Bill due: ' || new.name;
    notify_message := new.name || ' is due soon.';
    notify_when := (new.due_date - 3 + time '09:00') at time zone 'America/Chicago';
    followup_type := 'bill_overdue';
    followup_title := 'Bill overdue: ' || new.name;
    followup_when := (new.due_date + 1 + time '09:00') at time zone 'America/Chicago';
  else return new;
  end if;
  delete from public.notifications where related_item_type = tg_table_name and related_item_id = new.id and status = 'pending';
  for household_user in
    select u.* from public.users u join public.household_members hm on hm.user_id = u.id
    where hm.household_id = new.household_id and (new.assigned_user_id is null or new.assigned_user_id = u.id)
  loop
    if notify_when is not null then
      insert into public.notifications (household_id,user_id,type,title,message,recipient,related_item_type,related_item_id,scheduled_for,delivery_method)
      values (new.household_id,household_user.id,tg_table_name || '_due',notify_title,notify_message,household_user.email,tg_table_name,new.id,notify_when,'email');
    end if;
    if followup_when is not null then
      insert into public.notifications (household_id,user_id,type,title,message,recipient,related_item_type,related_item_id,scheduled_for,delivery_method)
      values (new.household_id,household_user.id,followup_type,followup_title,notify_message,household_user.email,tg_table_name,new.id,followup_when,'email');
    end if;
  end loop;
  return new;
end $$;
drop trigger queue_task_notification on public.tasks;
create trigger queue_task_notification after insert or update of due_date,due_time,assigned_to,assigned_user_id,reminder_minutes on public.tasks for each row when (new.completed = false) execute function public.queue_due_notification();
drop trigger queue_event_notification on public.events;
create trigger queue_event_notification after insert or update of event_date,start_time,assigned_to,assigned_user_id,reminder_minutes,status on public.events for each row when (new.completed = false) execute function public.queue_due_notification();
commit;
