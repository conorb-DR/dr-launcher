#!/usr/bin/env node
"use strict";
// Reliable ESM syntax gate for the browser modules. `node --check` on a raw
// .js glob is unreliable in a CommonJS repo (Node may parse it as CJS); running
// it per-file on .mjs parses each as ESM by extension, with no execution (so
// browser globals like `document` never run). Replaces the fragile
// `node --check public/js/**/*.js` from the original plan.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "public", "js");

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // public/js/ doesn't exist yet (pre-5b) — nothing to check.
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.isFile() && e.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
if (files.length === 0) {
  console.log("check-frontend: no public/js/**/*.mjs modules yet — nothing to check.");
  process.exit(0);
}

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (err) {
    failed++;
    const msg = (err.stderr && err.stderr.toString()) || err.message;
    console.error(`✗ ${path.relative(process.cwd(), f)}\n${msg}`);
  }
}

if (failed > 0) {
  console.error(`check-frontend: ${failed} module(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`check-frontend: ${files.length} module(s) OK.`);
