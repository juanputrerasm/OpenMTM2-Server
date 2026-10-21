#!/usr/bin/env node
/*
  Copy the protocol modules into a client, as OpenPhotex's vendor step does:

      node tools/vendor.mjs ~/dev/OpenMTM2/src/net/vendor/mtmnet

  The copy is generated: change the files here, never there. Each copied file gets a first line
  saying so. Only protocol/ is copied; it must stay free of Node built-ins so it runs in a browser.
*/
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) {
  console.error("usage: node tools/vendor.mjs <target folder>");
  process.exit(2);
}
const out = resolve(target);
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(join(ROOT, "protocol")).filter((f) => f.endsWith(".js")).sort();
for (const f of files) {
  const text = readFileSync(join(ROOT, "protocol", f), "utf8");
  if (/from\s+["']node:/.test(text)) throw new Error(`${f} imports a Node built-in; protocol/ must run in a browser`);
  writeFileSync(join(out, f), `// Generated from openmtm2-server ${version} protocol/${f}. Do not edit; run its tools/vendor.mjs.\n${text}`);
}
console.log(`vendored ${files.length} files into ${out}`);
