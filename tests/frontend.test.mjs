import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { installMock } from "./mock-client.mjs";

const require=createRequire(import.meta.url);
const { chromium } = process.env.HOME_OPS_PLAYWRIGHT ? require(process.env.HOME_OPS_PLAYWRIGHT) : require("playwright");

test("generated app: auth, navigation, date ranges, CRUD, badge and mobile layout",async()=>{
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.url==="/worker-test") {res.setHeader("content-type","text/html");res.end("<!doctype html><title>Worker test</title>");return;}
      const file=path.join(process.cwd(),"dist",new URL(req.url,"http://local").pathname);
      const target=req.url==="/"?path.join(process.cwd(),"dist/index.html"):file;
      res.setHeader("content-type",target.endsWith(".js")?"text/javascript":target.endsWith(".css")?"text/css":target.endsWith(".b64")?"text/plain":"text/html");
      res.end(await readFile(target));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const browser=await chromium.launch({channel:process.env.HOME_OPS_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),headless:true});
  try {
    for(const viewport of [{width:390,height:844},{width:412,height:915},{width:1440,height:1000}]){
      const context=await browser.newContext({viewport,timezoneId:"America/Chicago",serviceWorkers:"block"});
      await context.addInitScript(installMock,{});
      await context.route("https://cdn.jsdelivr.net/**",route=>route.fulfill({contentType:"text/javascript",body:"export function createClient(){return window.__mockClient;}"}));
      const page=await context.newPage();
      const errors=[];page.on("pageerror",e=>errors.push(e.message));
      await page.clock.install({time:new Date("2026-10-03T12:00:00-05:00")});
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator("#login-email").fill("tester@example.test");
      await page.locator("#login-password").fill("testpassword");
      await page.locator("#login-form button[type=submit]").click();
      await page.locator("#shell:not(.hidden)").waitFor();
      await page.getByText("Future appointment",{exact:true}).waitFor();
      assert.equal(await page.getByText("Month event",{exact:true}).count(),0);
      assert.equal(await page.getByText("Completed hidden",{exact:true}).count(),0);
      await page.locator("#upcoming-range").selectOption("month");
      await page.getByText("Month event",{exact:true}).waitFor();
      await page.locator('[data-tab="calendar"]').click();
      await page.locator('.day[data-date="2026-10-10"]').click();
      await page.getByText("Vacation",{exact:true}).waitFor();
      await page.locator('[data-tab="weekly"]').click();
      assert.equal(await page.locator("#week-notes").inputValue(),"Old freeform notes");
      await page.locator('.js-add[data-type="weeklyItem"]').click();
      await page.locator('[name="title"]').fill("Scheduled appointment");
      await page.locator('[name="item_type"]').selectOption("appointment");
      await page.locator('[name="scheduled_date"]').fill("2026-10-03");
      await page.locator("#modal-save").click();
      await page.getByText("Scheduled appointment",{exact:true}).waitFor();
      await page.locator('[data-tab="today"]').click();
      await page.getByText("Scheduled appointment",{exact:true}).waitFor();
      await page.locator('.js-toggle[data-id="wi1"]').click();
      assert.equal(await page.locator('.js-toggle[data-id="wi1"].checked').count(),1);
      await page.locator('.js-add[data-type="task"]').first().click();
      await page.locator('[name="title"]').fill("Test task");
      await page.locator('[name="due_time"]').fill("08:00");
      await page.locator('[name="reminder_minutes"]').selectOption("60");
      await page.locator("#modal-save").click();
      await page.getByText("Test task",{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.__rows.tasks[0].reminder_minutes),60);
      const taskId=await page.evaluate(()=>window.__rows.tasks[0].id);
      await page.locator(`.js-edit[data-id="${taskId}"]`).click();
      await page.locator('[name="reminder_minutes"]').selectOption("");
      await page.locator("#modal-save").click();
      await page.waitForFunction(()=>window.__rows.tasks[0].reminder_minutes===null);
      await page.evaluate(()=>window.__rows.notifications.push({id:"n1",household_id:"h1",user_id:"u1",related_item_id:window.__rows.tasks[0].id,status:"sent",scheduled_for:"2026-10-03T12:00:00Z",read_at:null}));
      await page.locator(`.js-toggle[data-id="${taskId}"]`).click();
      await page.waitForFunction(()=>window.__badgeCalls.at(-1)===0 && window.__rows.notifications[0].read_at);
      await page.locator('[data-tab="calendar"]').click();
      await page.locator('.js-add[data-type="event"]').first().click();
      await page.locator('[name="title"]').fill("New vacation");
      await page.locator('[name="event_date"]').fill("2026-10-10");
      await page.locator('[name="end_date"]').fill("2026-10-17");
      await page.locator("#modal-save").click();
      await page.locator('.day[data-date="2026-10-15"]').click();
      await page.getByText("New vacation",{exact:true}).waitFor();
      const eventId=await page.evaluate(()=>window.__rows.events.find(r=>r.title==="New vacation").id);
      await page.locator(`.js-edit[data-id="${eventId}"]`).click();
      assert.equal(await page.locator('[name="end_date"]').inputValue(),"2026-10-17");
      await page.locator('[name="title"]').fill("Edited vacation");
      await page.locator("#modal-save").click();
      await page.getByText("Edited vacation",{exact:true}).waitFor();
      await page.locator(`.js-toggle[data-id="${eventId}"]`).click();
      await page.waitForFunction(id=>window.__rows.events.find(r=>r.id===id).completed,eventId);
      page.once("dialog",dialog=>dialog.accept());
      await page.locator(`.js-delete[data-id="${eventId}"]`).click();
      await page.waitForFunction(id=>!window.__rows.events.find(r=>r.id===id),eventId);
      for(const tab of ["routines","tasks","settings","today"]){await page.locator(`[data-tab="${tab}"]`).click();assert.ok(await page.locator("#page").innerHTML());}
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false,"no horizontal overflow");
      await mkdir("test-artifacts",{recursive:true});
      await page.clock.runFor(4000);
      await page.screenshot({path:`test-artifacts/today-${viewport.width}.png`,fullPage:true});
      assert.deepEqual(errors,[]);
      await page.locator('[data-tab="settings"]').click();
      await page.locator("#logout").click();
      await page.locator("#auth-view:not(.hidden)").waitFor();
      assert.equal(await page.evaluate(()=>window.__badgeCalls.at(-1)),0);
      await page.locator("#auth-mode-signup").click();
      await page.locator("#signup-name").fill("New user");
      await page.locator("#login-form button[type=submit]").click();
      await page.waitForFunction(()=>window.__signupCalls===1);
      await context.close();
    }
    for(const action of ["create","join"]){
      const context=await browser.newContext({serviceWorkers:"block"});
      await context.addInitScript(installMock,{onboarding:true});
      await context.route("https://cdn.jsdelivr.net/**",route=>route.fulfill({contentType:"text/javascript",body:"export function createClient(){return window.__mockClient;}"}));
      const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator("#login-email").fill("tester@example.test");await page.locator("#login-password").fill("testpassword");await page.locator("#login-form button[type=submit]").click();
      await page.locator(`#${action==="create"?"create":"join"}-household-form`).waitFor();
      if(action==="create")await page.locator('[name="household_name"]').fill("New Home");else await page.locator('[name="invite_token"]').fill("test-invite");
      await page.locator(`#${action}-household-form button[type=submit]`).click();
      await page.waitForFunction(()=>document.querySelector("#page-title").textContent==="Today");await context.close();
    }
    const pwa=await browser.newContext();
    const workerPage=await pwa.newPage();
    await workerPage.goto(`http://127.0.0.1:${server.address().port}/worker-test`);
    await workerPage.evaluate(async()=>{
      await caches.open("home-ops-v5");
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await workerPage.waitForFunction(()=>navigator.serviceWorker.controller);
    assert.deepEqual(await workerPage.evaluate(()=>caches.keys()),["home-ops-v6"]);
    const chunkCount=await workerPage.evaluate(async()=>{
      const cache=await caches.open("home-ops-v6");
      return (await cache.keys()).filter(request=>/app\.bundle\.\d+\.b64/.test(request.url)).length;
    });
    assert.equal(chunkCount,10,"all ten bundle chunks are precached");
    await pwa.setOffline(true);
    assert.ok((await workerPage.evaluate(async()=>{const response=await fetch("/app.bundle.001.b64");return response.ok && (await response.text()).length>0;})),"offline bundle uses cache");
    await pwa.close();
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
