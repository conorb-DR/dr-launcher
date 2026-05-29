#!/usr/bin/env node
//
// gen-server-maps.js — generate each agent's `server-urls.generated.json` from the
// single source of truth (lib/servers.js BUNDLED_DEFAULTS), so the agent scripts
// never hand-maintain (and drift from) the canonical server→host map.
//
//   node scripts/gen-server-maps.js           write the JSON files
//   node scripts/gen-server-maps.js --check    fail (exit 1) if any file is stale
//
// `--check` is part of the standard gate; the build does NOT regenerate in place,
// so a server-list edit without `npm run gen:server-maps` fails fast instead of
// silently dirtying the working tree.

const fs = require("fs");
const path = require("path");
const { BUNDLED_DEFAULTS } = require("../lib/servers");

// server key -> base URL, in BUNDLED_DEFAULTS order (deterministic output).
function buildMap() {
  const map = {};
  for (const s of BUNDLED_DEFAULTS) map[s.key] = s.host;
  return map;
}

// Agent script dirs that consume the map. The scaffold's copyDirs carries the
// JSON into every customer workspace alongside the scripts that require it.
const TARGETS = [
  path.join(__dirname, "..", "agents", "dashboard-agent", "scripts", "server-urls.generated.json"),
  path.join(__dirname, "..", "agents", "datamapper-agent", "scripts", "server-urls.generated.json"),
];

function content() {
  return JSON.stringify(buildMap(), null, 2) + "\n";
}

function main() {
  const check = process.argv.includes("--check");
  const expected = content();
  let drift = false;

  for (const target of TARGETS) {
    const rel = path.relative(process.cwd(), target);
    if (check) {
      let actual = null;
      try { actual = fs.readFileSync(target, "utf8"); } catch { /* missing */ }
      if (actual !== expected) {
        drift = true;
        console.error(`server-maps: stale or missing — ${rel}`);
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, expected, "utf8");
      console.log(`server-maps: wrote ${rel}`);
    }
  }

  if (check) {
    if (drift) {
      console.error("Run `npm run gen:server-maps` and commit the result.");
      process.exit(1);
    }
    console.log("server-maps: up to date.");
  }
}

main();
