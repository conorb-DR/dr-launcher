const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// P1-3 / P2-1: agent scripts must use the canonical server hosts (single
// source of truth = lib/servers.js BUNDLED_DEFAULTS), and the CJS-converted
// grid-engine must actually run on the dev Node.
const servers = require("../lib/servers");
const apiPutWidget = require("../agents/dashboard-agent/scripts/api-put-widget.js");
const downloadFilebox = require("../agents/datamapper-agent/scripts/download-filebox.js");

const GRID_ENGINE = path.join(
  __dirname, "..", "agents", "dashboard-agent", "scripts", "grid-engine.js"
);

// Canonical map from the exported constant (not serverHost(), which could be
// shadowed by a local servers.json override on the dev machine).
const CANON = {};
for (const s of servers.BUNDLED_DEFAULTS) CANON[s.key] = s.host;

describe("server registry single-source-of-truth (P1-3)", () => {
  // SERVER_FALLBACK moved from public/app.js to the ES module public/js/servers.mjs.
  let SERVER_FALLBACK;
  before(async () => { ({ SERVER_FALLBACK } = await import("../public/js/servers.mjs")); });

  it("api-put-widget.js SERVER_URLS match canonical hosts", () => {
    for (const [key, host] of Object.entries(apiPutWidget.SERVER_URLS)) {
      assert.equal(host, CANON[key], `api-put-widget ${key} host mismatch`);
    }
  });

  it("download-filebox.js SERVER_URLS match canonical hosts", () => {
    for (const [key, host] of Object.entries(downloadFilebox.SERVER_URLS)) {
      assert.equal(host, CANON[key], `download-filebox ${key} host mismatch`);
    }
  });

  it("download-filebox.js drops the invented EU key", () => {
    assert.ok(!("EU" in downloadFilebox.SERVER_URLS), "EU is not a real Datarails server");
  });

  it("servers.mjs SERVER_FALLBACK hosts match canonical hosts", () => {
    for (const entry of SERVER_FALLBACK) {
      assert.ok(entry.host, `fallback entry ${entry.key} must have a host`);
      assert.equal(entry.host, CANON[entry.key], `servers.mjs fallback ${entry.key} host mismatch`);
    }
  });
});

describe("grid-engine runs as CommonJS on this Node (P2-1)", () => {
  it("exits 0 on a minimal valid spec with --json", () => {
    const spec = {
      meta: { stage: "draft", server: "US2" },
      dashboard: { name: "Registry Test" },
      widgets: [
        { id_local: "w1", type: "kpi", name: "Revenue", data: { template_id: "123", value_field: "Amount" } },
      ],
    };
    const specPath = path.join(os.tmpdir(), `ge-spec-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");
    try {
      const r = spawnSync(process.execPath, [GRID_ENGINE, specPath, "--json"], { encoding: "utf8" });
      assert.equal(r.status, 0, `grid-engine exited ${r.status}: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.ok(out.widgets[0].layout, "grid-engine should assign a layout");
    } finally {
      try { fs.unlinkSync(specPath); } catch { /* ignore */ }
    }
  });
});
