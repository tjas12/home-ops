import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("incremental migrations, signup, household RLS, schedules and notification cleanup", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users (id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;`);
    // PGlite omits pgcrypto. This fixture supplies random bytes only for invite defaults.
    await db.exec(`create function public.gen_random_bytes(n integer) returns bytea language sql as $$ select decode(string_agg(md5(random()::text),''),'hex') from generate_series(1,ceil(n/16.0)::int) $$;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()) await db.exec((await readFile(new URL(file,dir),"utf8")).replace(/create extension if not exists pgcrypto;/g,""));
    await db.exec(`grant select,insert,update,delete on all tables in schema public to authenticated,service_role;
      insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000001','a@example.test'),('00000000-0000-0000-0000-000000000002','b@example.test'),('00000000-0000-0000-0000-000000000003','invite@example.test');`);
    assert.equal((await db.query("select count(*)::int as n from users where household_id is null")).rows[0].n,3,"signup creates profiles without whitelist");
    const a="10000000-0000-0000-0000-000000000001", b="10000000-0000-0000-0000-000000000002";
    await db.exec(`insert into households(id,name) values ('${a}','A'),('${b}','B');
      insert into household_members(household_id,user_id,role) values ('${a}','00000000-0000-0000-0000-000000000001','owner'),('${b}','00000000-0000-0000-0000-000000000002','owner');
      insert into weekly_plans(household_id,week_start_date,notes) values ('${a}','2026-10-04','preserved freeform'),('${b}','2026-10-04','private B');`);
    const asUser=async (id) => db.exec(`reset role; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000${id}',false); set role authenticated;`);
    await asUser(1);
    assert.equal((await db.query("select count(*)::int n from households")).rows[0].n,1);
    await db.query(`insert into weekly_plan_items(household_id,weekly_plan_id,item_type,title,created_by) select '${a}',id,'priority','A item',auth.uid() from weekly_plans`);
    await assert.rejects(db.query(`update weekly_plan_items set household_id='${b}'`),/row-level security/);
    await assert.rejects(db.query(`insert into weekly_plan_items(household_id,item_type,title,created_by) values ('${b}','note','intrusion',auth.uid())`),/row-level security/);
    assert.equal((await db.query(`update weekly_plans set notes='intrusion' where household_id='${b}' returning id`)).rows.length,0);
    await asUser(2);
    assert.equal((await db.query("select * from weekly_plan_items")).rows.length,0);
    assert.equal((await db.query("update weekly_plan_items set title='intrusion' returning id")).rows.length,0);
    assert.equal((await db.query("delete from weekly_plan_items returning id")).rows.length,0);
    await assert.rejects(db.query(`insert into weekly_plan_items(household_id,item_type,title,created_by) values ('${a}','note','intrusion',auth.uid())`),/row-level security/);
    await db.exec("reset role");
    await db.query(`insert into household_invites(household_id,invited_by,invite_token) values ('${a}','00000000-0000-0000-0000-000000000001','test-invite')`);
    await asUser(3);
    assert.equal((await db.query("select accept_household_invite('test-invite') as id")).rows[0].id,a);
    assert.equal((await db.query("select count(*)::int n from weekly_plan_items")).rows[0].n,1);
    await assert.rejects(db.query("select accept_household_invite('test-invite')"),/already been used/);
    await asUser(1);
    await assert.rejects(db.query(`insert into weekly_plan_items(household_id,item_type,title,created_by,assigned_user_id) values ('${a}','note','foreign assignee',auth.uid(),'00000000-0000-0000-0000-000000000002')`),/foreign key/);
    await db.query("update weekly_plan_items set title='edited',completed=true,completed_by=auth.uid()");
    assert.equal((await db.query("select completed_at is not null as done from weekly_plan_items")).rows[0].done,true);
    await db.query("delete from weekly_plan_items");
    await db.exec("reset role");
    const task=(date,time,minutes,title="scheduled") => db.query(`insert into tasks(household_id,title,due_date,due_time,reminder_minutes,created_by) values ($1,$2,$3,$4,$5,'00000000-0000-0000-0000-000000000001') returning id`,[a,title,date,time,minutes]);
    for (const minutes of [5,30,60]) {
      const row=(await task("2026-10-10","15:00",minutes)).rows[0];
      const when=new Date(Date.UTC(2026,9,10,20,-minutes)).toISOString();
      const due=await db.query("select * from home_ops_due_push_items($1)",[when]);
      assert.ok(due.rows.some((r)=>r.item.id===row.id),`${minutes} minute reminder`);
    }
    const none=(await task("2026-10-10","15:00",null,"none")).rows[0];
    assert.ok(!(await db.query("select * from home_ops_due_push_items('2026-10-10T20:00:00Z')")).rows.some((r)=>r.item.id===none.id));
    await assert.rejects(task("2026-10-10","15:00",10),/reminder_minutes_check/);
    for (const [date,utc] of [["2026-01-10","2026-01-10T20:30:00Z"],["2026-07-10","2026-07-10T19:30:00Z"],["2026-03-08","2026-03-08T07:30:00Z"],["2026-11-01","2026-11-01T08:30:00Z"]]) {
      const row=(await task(date,date.endsWith("08") || date.endsWith("01") ? "03:00" : "15:00",30,"DST")).rows[0];
      assert.ok((await db.query("select * from home_ops_due_push_items($1)",[utc])).rows.some(r=>r.item.id===row.id),date);
    }
    const midnight=(await task("2026-10-11","00:15",30,"midnight")).rows[0];
    assert.ok((await db.query("select * from home_ops_due_push_items('2026-10-11T04:45:00Z')")).rows.some(r=>r.item.id===midnight.id));
    await assert.rejects(db.query(`insert into events(household_id,title,event_date,end_date,created_by) values ('${a}','invalid','2026-10-17','2026-10-10','00000000-0000-0000-0000-000000000001')`),/end_date_check/);
    await db.query(`insert into notifications(household_id,user_id,type,title,message,recipient,related_item_type,related_item_id,status,delivery_method) values ($1,'00000000-0000-0000-0000-000000000001','reminder','test','test','a@example.test','task',$2,'sent','push')`,[a,midnight.id]);
    await db.query("update tasks set completed=true where id=$1",[midnight.id]);
    assert.equal((await db.query("select count(*)::int n from notifications where related_item_id=$1 and read_at is null",[midnight.id])).rows[0].n,0);
    assert.ok(!(await db.query("select * from home_ops_due_push_items('2026-10-11T04:45:00Z')")).rows.some(r=>r.item.id===midnight.id));
    for (const minutes of [5,30,60]) {
      const event=(await db.query(`insert into events(household_id,title,event_date,end_date,start_time,reminder_minutes,created_by) values ($1,'multi-day','2026-10-10','2026-10-17','15:00',$2,'00000000-0000-0000-0000-000000000001') returning id`,[a,minutes])).rows[0];
      const when=new Date(Date.UTC(2026,9,10,20,-minutes)).toISOString();
      assert.ok((await db.query("select * from home_ops_due_push_items($1)",[when])).rows.some(r=>r.source_type==="event" && r.item.id===event.id));
      await db.query("update events set completed=true,status='completed' where id=$1",[event.id]);
      assert.ok(!(await db.query("select * from home_ops_due_push_items($1)",[when])).rows.some(r=>r.item.id===event.id));
    }
    const reminder=(await db.query(`insert into reminders(household_id,title,reminder_date,created_by) values ($1,'standalone','2026-10-10','00000000-0000-0000-0000-000000000001') returning id`,[a])).rows[0];
    assert.ok((await db.query("select * from notifications where related_item_id=$1 and status='pending'",[reminder.id])).rows.length>0,"standalone scheduling retained");
    await db.query(`insert into notifications(household_id,user_id,type,title,message,recipient,status,delivery_method,related_item_type,related_item_id) values ($1,'00000000-0000-0000-0000-000000000001','reminder','sent reminder','test','a@example.test','sent','push','reminder',$2)`,[a,reminder.id]);
    await db.query("update reminders set completed=true where id=$1",[reminder.id]);
    assert.equal((await db.query("select count(*)::int n from notifications where related_item_id=$1 and read_at is null",[reminder.id])).rows[0].n,0);
    await asUser(1);
    await assert.rejects(db.query("select * from home_ops_due_push_items()"),/permission denied/);
    await db.exec("reset role; set role anon");
    await assert.rejects(db.query("select * from weekly_plan_items"),/permission denied/);
  } finally { await db.close(); }
});
