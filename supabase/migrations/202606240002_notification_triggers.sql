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
    select * from public.users
    where household_id = new.household_id
      and (
        coalesce(new.assigned_to, 'Shared') = 'Shared'
        or new.assigned_to = users.role
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
create trigger queue_task_notification after insert or update of due_date, due_time, assigned_to on public.tasks
for each row when (new.completed = false) execute procedure public.queue_due_notification();

drop trigger if exists queue_reminder_notification on public.reminders;
create trigger queue_reminder_notification after insert or update of reminder_date, reminder_time, assigned_to on public.reminders
for each row when (new.completed = false) execute procedure public.queue_due_notification();

drop trigger if exists queue_event_notification on public.events;
create trigger queue_event_notification after insert or update of event_date, start_time, assigned_to on public.events
for each row when (new.completed = false) execute procedure public.queue_due_notification();

drop trigger if exists queue_bill_notification on public.bills;
create trigger queue_bill_notification after insert or update of due_date, assigned_to on public.bills
for each row when (new.status = 'unpaid') execute procedure public.queue_due_notification();

create or replace function public.clear_completed_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_table_name = 'bills' and new.status = 'paid')
    or (tg_table_name <> 'bills' and new.completed = true) then
    delete from public.notifications
    where related_item_type = tg_table_name
      and related_item_id = new.id
      and status = 'pending';
  end if;
  return new;
end;
$$;

create trigger clear_task_notifications after update of completed on public.tasks
for each row execute procedure public.clear_completed_notifications();
create trigger clear_reminder_notifications after update of completed on public.reminders
for each row execute procedure public.clear_completed_notifications();
create trigger clear_event_notifications after update of completed on public.events
for each row execute procedure public.clear_completed_notifications();
create trigger clear_bill_notifications after update of status on public.bills
for each row execute procedure public.clear_completed_notifications();
