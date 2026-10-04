import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function buildBundles() {
  const source = (await readFile(new URL("./src/app.js", import.meta.url), "utf8")).replace(/\r?\n/g, "\r\n").trimEnd() + "\r\n";
  const encoded = Buffer.from(source).toString("base64");
  // Preserve the known-good loader's ten filenames and concatenate in order.
  const size = Math.ceil(encoded.length / 10 / 4) * 4;
  for (let i = 0; i < 10; i++) {
    await writeFile(new URL(`./app.bundle.${String(i + 1).padStart(3, "0")}.b64`, import.meta.url), encoded.slice(i * size, (i + 1) * size));
  }
  console.log(`Application SHA-256: ${createHash("sha256").update(source).digest("hex")}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:///").href) await buildBundles();
