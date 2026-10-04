begin;
alter table public.notifications add column if not exists read_at timestamptz;
create index if not exists notifications_user_unread_idx on public.notifications(user_id,scheduled_for) where read_at is null and status = 'sent';

-- Keep pending cancellation and additionally retire delivered alerts for completed items.
create or replace function public.clear_completed_notifications()
returns trigger language plpgsql security definer set search_path = public as $$
declare item_completed boolean;
begin
  if tg_op = 'DELETE' then
    delete from public.notifications where household_id = old.household_id and related_item_type in (tg_table_name,rtrim(tg_table_name,'s')) and related_item_id = old.id and status = 'pending';
    update public.notifications set read_at = coalesce(read_at,now()) where household_id = old.household_id and related_item_type in (tg_table_name,rtrim(tg_table_name,'s')) and related_item_id = old.id and read_at is null;
    return old;
  end if;
  if tg_table_name = 'bills' then item_completed := new.status = 'paid';
  elsif tg_table_name = 'events' then item_completed := new.completed or new.status = 'cancelled';
  else item_completed := new.completed;
  end if;
  if item_completed then
    delete from public.notifications where household_id = new.household_id and related_item_type in (tg_table_name,rtrim(tg_table_name,'s')) and related_item_id = new.id and status = 'pending';
    update public.notifications set read_at = coalesce(read_at,now())
    where household_id = new.household_id and related_item_type in (tg_table_name,rtrim(tg_table_name,'s')) and related_item_id = new.id and read_at is null;
  end if;
  return new;
end $$;
create trigger clear_weekly_item_notifications after update of completed on public.weekly_plan_items for each row execute function public.clear_completed_notifications();
create trigger clear_deleted_task_notifications after delete on public.tasks for each row execute function public.clear_completed_notifications();
create trigger clear_deleted_event_notifications after delete on public.events for each row execute function public.clear_completed_notifications();
create trigger clear_deleted_reminder_notifications after delete on public.reminders for each row execute function public.clear_completed_notifications();
create trigger clear_deleted_weekly_item_notifications after delete on public.weekly_plan_items for each row execute function public.clear_completed_notifications();
create trigger clear_cancelled_event_notifications after update of status on public.events for each row when (new.status = 'cancelled') execute function public.clear_completed_notifications();

-- Repair stale completed-item notifications, leaving unrelated users' alerts untouched.
update public.notifications n set read_at = now()
where n.read_at is null and (
  exists (select 1 from public.tasks t where n.related_item_type in ('task','tasks') and n.related_item_id = t.id and n.household_id = t.household_id and t.completed)
  or exists (select 1 from public.events e where n.related_item_type in ('event','events') and n.related_item_id = e.id and n.household_id = e.household_id and (e.completed or e.status = 'cancelled'))
  or exists (select 1 from public.reminders r where n.related_item_type in ('reminder','reminders') and n.related_item_id = r.id and n.household_id = r.household_id and r.completed)
);
delete from public.notifications where status = 'pending' and read_at is not null;

-- A late scheduler insert must not revive a notification for a completed/deleted item.
create function public.retire_inactive_notification() returns trigger language plpgsql security definer set search_path = public as $$
declare active boolean;
begin
  if new.related_item_type in ('task','tasks') then
    select not completed into active from public.tasks where id = new.related_item_id and household_id = new.household_id;
  elsif new.related_item_type in ('event','events') then
    select not completed and status <> 'cancelled' into active from public.events where id = new.related_item_id and household_id = new.household_id;
  elsif new.related_item_type in ('reminder','reminders') then
    select not completed into active from public.reminders where id = new.related_item_id and household_id = new.household_id;
  else return new;
  end if;
  if active is distinct from true then new.read_at := now(); end if;
  return new;
end $$;
create trigger retire_inactive_notification before insert on public.notifications for each row execute function public.retire_inactive_notification();
revoke all on function public.retire_inactive_notification() from public,anon,authenticated;
commit;
