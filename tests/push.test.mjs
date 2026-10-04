import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

test("push dispatch: assigned user, Everyone, opt-out, atomic duplicates, completion, payload and authorization",async()=>{
  const sent=[],rows={
    household_members:[{household_id:"h1",user_id:"u1"},{household_id:"h1",user_id:"u2"},{household_id:"h2",user_id:"u3"}],
    users:[{id:"u1",email:"a@test",role:"owner"},{id:"u2",email:"b@test",role:"member"},{id:"u3",email:"c@test",role:"owner"}],
    notification_settings:[],user_notification_settings:[],
    push_subscriptions:[{id:"s1",household_id:"h1",user_id:"u1",endpoint:"https://test/1",p256dh:"key",auth:"auth"},{id:"s2",household_id:"h1",user_id:"u2",endpoint:"https://test/2",p256dh:"key",auth:"auth"}],
    push_reminder_dispatches:[],notifications:[],
    tasks:[{id:"t1",household_id:"h1",title:"task",due_date:"2026-10-10",due_time:"15:00:00",reminder_minutes:30,completed:false}],
    push_config:[{id:"default",public_key:"public",private_key:"private",subject:"mailto:test@test",cron_secret:"secret"}],
  };
  let id=0;
  const admin={auth:{getUser:async()=>({data:{user:null},error:null})},from(table){
    const filters=[];let mode="select",payload,one=false;
    const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},is(k,v){filters.push(r=>(r[k]??null)===v);return q;},lte(){return q;},single(){one=true;return q;},maybeSingle(){one=true;return q;},insert(v){mode="insert";payload=v;return q;},update(v){mode="update";payload=v;return q;},delete(){mode="delete";return q;},then(resolve){
      const list=rows[table] ||= [];let found=list.filter(r=>filters.every(f=>f(r)));
      if(mode==="insert"){
        if(table==="push_reminder_dispatches" && list.some(r=>["user_id","source_type","source_id","occurrence_key"].every(k=>r[k]===payload[k])))return resolve({data:null,error:{code:"23505"}});
        found=[{...payload,id:`id${++id}`,read_at:null}];list.push(...found);
      }else if(mode==="update")found.forEach(r=>Object.assign(r,payload));else if(mode==="delete")rows[table]=list.filter(r=>!found.includes(r));
      resolve({data:one?(found[0]||null):found,count:found.length,error:null});
    }};return q;
  }};
  let handler;
  const context=vm.createContext({createClient:()=>admin,webpush:{setVapidDetails(){},sendNotification:async(sub,payload)=>sent.push({sub,payload:JSON.parse(payload)})},Deno:{env:{get:()=>"test"},serve:fn=>handler=fn},console,Intl,Date,JSON,Response,Number,Error});
  let source=await readFile(new URL("../supabase/functions/send-home-ops-push/index.ts",import.meta.url),"utf8");
  source=stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm,""));
  vm.runInContext(source,context);
  const run=item=>{context.testItem=item;return vm.runInContext("processItem(testItem)",context);};
  const item={household_id:"h1",source_type:"task",source_id:"t1",occurrence_key:"2026-10-10T15:00:00:30",title:"Reminder",body:"task",url:"./?tab=tasks",assigned_to:"Shared"};
  await Promise.all([run(item),run(item)]);
  assert.equal(sent.length,2,"Everyone receives one push each, despite concurrent calls");
  assert.equal(rows.push_reminder_dispatches.length,2);
  assert.ok(sent.every(s=>s.payload.notificationId && s.payload.sourceId==="t1" && s.payload.unreadCount===1));
  rows.tasks[0].reminder_minutes=5;
  const assigned={...item,occurrence_key:"2026-10-10T15:00:00:5",assigned_user_id:"u1"};
  rows.tasks[0].assigned_user_id="u1";
  await run(assigned);assert.equal(sent.length,3);assert.equal(sent.at(-1).payload.userId,"u1");
  rows.user_notification_settings.push({user_id:"u1",push_enabled:false});rows.tasks[0].reminder_minutes=60;
  await run({...assigned,occurrence_key:"2026-10-10T15:00:00:60"});assert.equal(sent.length,3);
  rows.user_notification_settings=[];rows.tasks[0].completed=true;
  await run({...assigned,occurrence_key:"2026-10-10T15:00:00:60"});assert.equal(sent.length,3);
  assert.equal((await handler(new Request("https://test",{method:"POST",body:'{"mode":"test"}'}))).status,401);
  assert.equal((await handler(new Request("https://test",{method:"POST",body:'{"mode":"scheduled"}'}))).status,401);
});
