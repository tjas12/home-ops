import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const entries = [
  "index.html",
  "styles.css",
  "app.js",
  "push.js",
  "config.js",
  "manifest.webmanifest",
  "sw.js",
  "assets",
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of entries) {
  await cp(path.join(root, entry), path.join(dist, entry), { recursive: true });
}

console.log("Static Home Ops site built in dist/");
