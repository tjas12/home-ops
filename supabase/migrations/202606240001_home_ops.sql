create extension if not exists pgcrypto;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Seed this table from the Supabase SQL editor before inviting the two users.
-- It is intentionally not readable from the browser.
create table public.approved_access (
  email text primary key check (email = lower(email)),
  name text not null,
  role text not null check (role in ('Husband', 'Wife')),
  household_id uuid not null references public.households(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  role text not null check (role in ('Husband', 'Wife')),
  household_id uuid not null references public.households(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.approved_access%rowtype;
begin
  select * into access_row
  from public.approved_access
  where email = lower(new.email);

  if not found then
    raise exception 'This Home Ops dashboard is private.';
  end if;

  insert into public.users (id, email, name, role, household_id)
  values (new.id, lower(new.email), access_row.name, access_row.role, access_row.household_id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from public.users where id = auth.uid()
$$;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  description text,
  assigned_to text not null default 'Shared' check (assigned_to in ('Husband', 'Wife', 'Shared')),
  due_date date,
  due_time time,
  category text,
  priority text not null default 'Medium' check (priority in ('Low', 'Medium', 'High')),
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed')),
  repeat text not null default 'none' check (repeat in ('none', 'daily', 'weekly', 'monthly')),
  completed boolean not null default false,
  completed_by uuid references public.users(id) on delete set null,
  completed_at timestamptz,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  assigned_to text not null default 'Shared' check (assigned_to in ('Husband', 'Wife', 'Shared')),
  reminder_date date not null,
  reminder_time time,
  priority text not null default 'Medium' check (priority in ('Low', 'Medium', 'High')),
  notes text,
  completed boolean not null default false,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed')),
  completed_by uuid references public.users(id) on delete set null,
  completed_at timestamptz,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  event_date date not null,
  start_time time,
  end_time time,
  assigned_to text not null default 'Shared' check (assigned_to in ('Husband', 'Wife', 'Shared')),
  location text,
  notes text,
  category text,
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled')),
  completed boolean not null default false,
  completed_by uuid references public.users(id) on delete set null,
  completed_at timestamptz,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  amount numeric(12,2),
  due_date date not null,
  assigned_to text not null default 'Shared' check (assigned_to in ('Husband', 'Wife', 'Shared')),
  autopay boolean not null default false,
  repeat text not null default 'none' check (repeat in ('none', 'weekly', 'monthly', 'yearly')),
  notes text,
  status text not null default 'unpaid' check (status in ('unpaid', 'paid')),
  paid_at timestamptz,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.routines (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  assigned_to text not null default 'Shared' check (assigned_to in ('Husband', 'Wife', 'Shared')),
  days_of_week text[] not null default '{}',
  time time,
  category text,
  active boolean not null default true,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.routine_items (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routines(id) on delete cascade,
  title text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.routine_completions (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routines(id) on delete cascade,
  routine_item_id uuid not null references public.routine_items(id) on delete cascade,
  completed_date date not null,
  completed_by uuid not null references public.users(id),
  completed_at timestamptz not null default now(),
  unique (routine_item_id, completed_date)
);

create table public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  week_start_date date not null,
  top_priorities text,
  chores text,
  bills_due text,
  meal_plan text,
  appointments text,
  shopping_list text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, week_start_date)
);

create table public.notification_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  in_app_enabled boolean not null default true,
  email_enabled boolean not null default true,
  sms_enabled boolean not null default false,
  husband_email text,
  wife_email text,
  husband_phone text,
  wife_phone text,
  quiet_hours_start time,
  quiet_hours_end time,
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid references public.users(id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  recipient text,
  related_item_type text,
  related_item_id uuid,
  scheduled_for timestamptz not null default now(),
  delivery_method text not null check (delivery_method in ('in_app', 'email', 'sms')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  sent_at timestamptz,
  read_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

create index tasks_household_due_idx on public.tasks (household_id, due_date);
create index reminders_household_due_idx on public.reminders (household_id, reminder_date);
create index events_household_date_idx on public.events (household_id, event_date);
create index bills_household_due_idx on public.bills (household_id, due_date);
create index routines_household_idx on public.routines (household_id);
create index notifications_pending_idx on public.notifications (status, scheduled_for) where status = 'pending';

alter table public.households enable row level security;
alter table public.approved_access enable row level security;
alter table public.users enable row level security;
alter table public.tasks enable row level security;
alter table public.reminders enable row level security;
alter table public.events enable row level security;
alter table public.bills enable row level security;
alter table public.routines enable row level security;
alter table public.routine_items enable row level security;
alter table public.routine_completions enable row level security;
alter table public.weekly_plans enable row level security;
alter table public.notification_settings enable row level security;
alter table public.notifications enable row level security;

create policy "household members can read household"
on public.households for select
using (id = public.current_household_id());

create policy "household members can read profiles"
on public.users for select
using (household_id = public.current_household_id());

create policy "household members can update own profile"
on public.users for update
using (id = auth.uid())
with check (id = auth.uid() and household_id = public.current_household_id());

do $$
declare
  table_name text;
begin
  foreach table_name in array array['tasks','reminders','events','bills','routines','weekly_plans','notification_settings','notifications']
  loop
    execute format(
      'create policy "household access" on public.%I for all using (household_id = public.current_household_id()) with check (household_id = public.current_household_id())',
      table_name
    );
  end loop;
end $$;

create policy "household access to routine items"
on public.routine_items for all
using (exists (
  select 1 from public.routines
  where routines.id = routine_items.routine_id
    and routines.household_id = public.current_household_id()
))
with check (exists (
  select 1 from public.routines
  where routines.id = routine_items.routine_id
    and routines.household_id = public.current_household_id()
));

create policy "household access to routine completions"
on public.routine_completions for all
using (exists (
  select 1 from public.routines
  where routines.id = routine_completions.routine_id
    and routines.household_id = public.current_household_id()
))
with check (exists (
  select 1 from public.routines
  where routines.id = routine_completions.routine_id
    and routines.household_id = public.current_household_id()
));

-- No browser policies are created for approved_access. It remains server/admin only.
