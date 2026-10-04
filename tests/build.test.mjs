import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildBundles } from "../build-bundles.mjs";

test("ten generated chunks reproduce source and rebuild deterministically",async()=>{
  const files=Array.from({length:10},(_,i)=>new URL(`../app.bundle.${String(i+1).padStart(3,"0")}.b64`,import.meta.url));
  const before=await Promise.all(files.map(f=>readFile(f,"utf8")));
  const canonical=(await readFile(new URL("../src/app.js",import.meta.url),"utf8")).replace(/\r?\n/g,"\r\n").trimEnd()+"\r\n";
  assert.equal(Buffer.from(before.join(""),"base64").toString(),canonical);
  await buildBundles();
  assert.deepEqual(await Promise.all(files.map(f=>readFile(f,"utf8"))),before);
  for(let i=0;i<10;i++)assert.equal(await readFile(new URL(`../dist/app.bundle.${String(i+1).padStart(3,"0")}.b64`,import.meta.url),"utf8"),before[i]);
});
