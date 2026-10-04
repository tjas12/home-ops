import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundles } from "./build-bundles.mjs";

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
  ...Array.from({ length: 10 }, (_, i) => `app.bundle.${String(i + 1).padStart(3, "0")}.b64`),
];

await buildBundles();
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of entries) {
  await cp(path.join(root, entry), path.join(dist, entry), { recursive: true });
}

console.log("Static Home Ops site built in dist/");
