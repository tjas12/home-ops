import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

test("worker badges use numeric unread count, zero clears and unsupported API is safe",async()=>{
  const callbacks={},calls=[];
  const context=vm.createContext({
    self:{addEventListener:(name,fn)=>callbacks[name]=fn,registration:{
      showNotification:async(title,options)=>calls.push({title,options}),
      setAppBadge:async n=>calls.push(n),clearAppBadge:async()=>calls.push(0),
    }},
    clients:{matchAll:async()=>[]},Number,Promise,
  });
  vm.runInContext(await readFile(new URL("../sw.js",import.meta.url),"utf8"),context);
  let pending;
  callbacks.push({data:{json:()=>({title:"Task",unreadCount:3,notificationId:"n1"})},waitUntil:p=>pending=p});await pending;
  assert.ok(calls.includes(3));
  assert.equal(calls[0].options.tag,"n1");
  callbacks.message({data:{type:"HOME_OPS_BADGE",count:0},waitUntil:p=>pending=p});await pending;
  assert.equal(calls.at(-1),0);
  delete context.self.registration.setAppBadge;delete context.self.registration.clearAppBadge;
  callbacks.message({data:{type:"HOME_OPS_BADGE",count:1},waitUntil:p=>pending=p});await pending;
});
