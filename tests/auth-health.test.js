const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate registry/log writes to a temp LOCALAPPDATA BEFORE requiring modules.
const TMP = path.join(os.tmpdir(), `dr-authhealth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.LOCALAPPDATA = TMP;

const authHealth = require("../lib/auth-health");
const drCli = require("../lib/dr-cli");

const REGISTRY_PATH = path.join(TMP, "DR Launcher", "auth-registry.json");
function writeRegistry(entries) {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2), "utf8");
}
function readRegistry() { return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")); }
function rmRegistry() { try { fs.rmSync(REGISTRY_PATH, { force: true }); } catch { /* ignore */ } }

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// The real CLI death signal (a pre-flight JWT refresh failure).
const REFRESH_DEAD_STDERR =
  "dr: JWT auto-refresh failed (pre-flight): US2:x (refresh failed: jwt refresh: HTTP 401)";

// --- classifyProbeResult: classifies a REAL liveness probe (detail only) ---

describe("classifyProbeResult (real-probe detail)", () => {
  it("exit 0 ⇒ 'ok' (pre-flight refresh succeeded)", () => {
    assert.equal(authHealth.classifyProbeResult({ exitCode: 0, stdout: "[]", stderr: "" }), "ok");
  });

  it("non-zero + refresh-death signal ⇒ 'auth-failure'", () => {
    assert.equal(authHealth.classifyProbeResult({ exitCode: 1, stdout: "", stderr: REFRESH_DEAD_STDERR }), "auth-failure");
  });

  it("'not logged in' ⇒ 'auth-failure'", () => {
    assert.equal(authHealth.classifyProbeResult({ exitCode: 1, stdout: "", stderr: "error: not logged in" }), "auth-failure");
  });

  it("timeout ⇒ 'timeout'", () => {
    assert.equal(authHealth.classifyProbeResult({ timedOut: true, exitCode: null }), "timeout");
  });

  it("non-zero PERMISSION/other error (no refresh-death, no data) ⇒ 'error' (NOT auth-failure)", () => {
    // A post-refresh 403/permission error on a LIVE session must not be mistaken
    // for expiry — only a refresh death counts.
    assert.equal(authHealth.classifyProbeResult({ exitCode: 1, stdout: "", stderr: "HTTP 403: forbidden" }), "error");
    assert.equal(authHealth.classifyProbeResult({ exitCode: 1, stdout: "", stderr: "unexpected server error" }), "error");
  });

  it("non-zero exit but JSON data returned ⇒ 'ok' (refresh succeeded, data fetched)", () => {
    // e.g. `dr templates list` returns the array but exits non-zero on a warning.
    assert.equal(authHealth.classifyProbeResult({ exitCode: 1, stdout: '[{"id":1}]', stderr: "warning: deprecated flag" }), "ok");
    assert.equal(authHealth.classifyProbeResult({ exitCode: 1, stdout: '{"templates":[]}', stderr: "" }), "ok");
  });

  it("refresh-death STILL wins even if some text is present (death is authoritative)", () => {
    assert.equal(authHealth.classifyProbeResult({ exitCode: 1, stdout: "", stderr: REFRESH_DEAD_STDERR }), "auth-failure");
  });
});

// --- classifyLiveness: probe outcome → status ---

describe("classifyLiveness", () => {
  it("ok ⇒ active", () => assert.equal(authHealth.classifyLiveness("ok"), "active"));
  it("auth-failure ⇒ expired", () => assert.equal(authHealth.classifyLiveness("auth-failure"), "expired"));
  it("timeout ⇒ unchanged (no false badge on a blip)", () => assert.equal(authHealth.classifyLiveness("timeout"), "unchanged"));
  it("error ⇒ unchanged (post-refresh permission error ≠ expired)", () => assert.equal(authHealth.classifyLiveness("error"), "unchanged"));
});

// --- mergeWithDiscovered ---

describe("mergeWithDiscovered", () => {
  beforeEach(rmRegistry);

  it("overlays registry 'expired' onto a discovered account (does NOT clear it on whoami discovery)", () => {
    writeRegistry([{ id: "US2:dead@x.com", email: "dead@x.com", serverKey: "US2", orgDomain: "x.com", cliAuthStatus: "expired" }]);
    const out = authHealth.mergeWithDiscovered([
      { id: "US2:dead@x.com", email: "dead@x.com", serverKey: "US2", orgDomain: "x.com", cliAuthStatus: "active" },
    ]);
    assert.equal(out.find((r) => r.id === "US2:dead@x.com").cliAuthStatus, "expired");
  });

  it("leaves a discovered account alone when the registry is not expired", () => {
    writeRegistry([{ id: "US2:ok@x.com", email: "ok@x.com", serverKey: "US2", orgDomain: "x.com", cliAuthStatus: "active" }]);
    const out = authHealth.mergeWithDiscovered([
      { id: "US2:ok@x.com", email: "ok@x.com", serverKey: "US2", orgDomain: "x.com", cliAuthStatus: "active" },
    ]);
    assert.equal(out.find((r) => r.id === "US2:ok@x.com").cliAuthStatus, "active");
  });

  it("appends a registry-only expired account that dropped out of discovery", () => {
    writeRegistry([{ id: "US2:gone@x.com", email: "gone@x.com", serverKey: "US2", orgDomain: "x.com", cliAuthStatus: "expired" }]);
    const out = authHealth.mergeWithDiscovered([]);
    const row = out.find((r) => r.id === "US2:gone@x.com");
    assert.ok(row && row.cliAuthStatus === "expired" && row._fromRegistry === true);
  });
});

// --- _runCheckImpl: real liveness probe drives status ---

describe("_runCheckImpl (real-probe integration)", () => {
  beforeEach(rmRegistry);

  it("a dead account (refresh-death probe) ⇒ expired; a live account (exit 0) ⇒ active; both are real-probed", async () => {
    const origDiscover = drCli.discoverAccounts;
    const origProbeLiveness = drCli.probeLiveness;
    const origProbeWhoami = drCli.probeWhoami;
    const probed = [];
    let whoamiProbes = 0;

    drCli.discoverAccounts = async () => [
      { id: "US2:dead@x.com", email: "dead@x.com", serverKey: "US2", serverHost: "h", orgDomain: "x.com", orgId: 1, userId: null, jwtExp: 0, cliAuthStatus: "active" },
      { id: "US2:live@x.com", email: "live@x.com", serverKey: "US2", serverHost: "h", orgDomain: "x.com", orgId: 2, userId: null, jwtExp: 0, cliAuthStatus: "active" },
    ];
    drCli.probeLiveness = async (server, email) => {
      probed.push(email);
      return email === "dead@x.com"
        ? { exitCode: 1, stdout: "", stderr: REFRESH_DEAD_STDERR }
        : { exitCode: 0, stdout: "[]", stderr: "" };
    };
    drCli.probeWhoami = async () => { whoamiProbes++; return { exitCode: 0, stdout: "{}", stderr: "" }; };

    try {
      await authHealth.runCheck();
    } finally {
      drCli.discoverAccounts = origDiscover;
      drCli.probeLiveness = origProbeLiveness;
      drCli.probeWhoami = origProbeWhoami;
    }

    const reg = readRegistry();
    assert.equal(reg.find((r) => r.id === "US2:dead@x.com").cliAuthStatus, "expired", "dead ⇒ expired");
    assert.equal(reg.find((r) => r.id === "US2:live@x.com").cliAuthStatus, "active", "live ⇒ active");
    assert.deepEqual(probed.sort(), ["dead@x.com", "live@x.com"], "both accounts real-probed");
    assert.equal(whoamiProbes, 0, "liveness must NOT use the offline whoami");
  });
});

// --- probeAccountNow: on-demand (launch / manual refresh) ---

describe("probeAccountNow", () => {
  beforeEach(rmRegistry);

  it("detects a dead session on demand and persists 'expired'", async () => {
    writeRegistry([{ id: "US2:dead@x.com", email: "dead@x.com", serverKey: "US2", orgDomain: "x.com", cliAuthStatus: "unknown", lastLivenessProbeAt: null }]);
    const orig = drCli.probeLiveness;
    drCli.probeLiveness = async () => ({ exitCode: 1, stdout: "", stderr: REFRESH_DEAD_STDERR });
    try {
      const status = await authHealth.probeAccountNow("US2:dead@x.com");
      assert.equal(status, "expired");
    } finally { drCli.probeLiveness = orig; }
    assert.equal(readRegistry().find((r) => r.id === "US2:dead@x.com").cliAuthStatus, "expired");
  });
});

// --- isSupport persistence + launch-policy resolution ---

describe("isSupportAccount", () => {
  beforeEach(rmRegistry);
  it("returns the stored boolean, or null when unknown/absent", () => {
    writeRegistry([
      { id: "US2:s@x.com", isSupport: true },
      { id: "US2:u@x.com", isSupport: false },
      { id: "US2:q@x.com" }, // no isSupport field
    ]);
    assert.equal(authHealth.isSupportAccount("US2:s@x.com"), true);
    assert.equal(authHealth.isSupportAccount("US2:u@x.com"), false);
    assert.equal(authHealth.isSupportAccount("US2:q@x.com"), null);
    assert.equal(authHealth.isSupportAccount("US2:missing@x.com"), null);
  });
});

describe("resolveIsSupport (fail-closed)", () => {
  beforeEach(rmRegistry);

  it("returns the known value from the registry WITHOUT a lookup", async () => {
    writeRegistry([{ id: "US2:s@x.com", isSupport: true }]);
    const orig = drCli.getAccountDetails;
    let called = false;
    drCli.getAccountDetails = async () => { called = true; return null; };
    try {
      assert.equal(await authHealth.resolveIsSupport("US2:s@x.com", { serverKey: "US2", email: "s@x.com" }), true);
    } finally { drCli.getAccountDetails = orig; }
    assert.equal(called, false, "must not look up when the registry already knows");
  });

  it("looks up + persists when unknown", async () => {
    writeRegistry([{ id: "US2:q@x.com" }]);
    const orig = drCli.getAccountDetails;
    drCli.getAccountDetails = async () => ({ isSupport: false });
    try {
      assert.equal(await authHealth.resolveIsSupport("US2:q@x.com", { serverKey: "US2", email: "q@x.com" }), false);
    } finally { drCli.getAccountDetails = orig; }
    assert.equal(readRegistry().find((r) => r.id === "US2:q@x.com").isSupport, false, "must persist the resolved value");
  });

  it("returns null (caller refuses) when the lookup can't confirm", async () => {
    writeRegistry([{ id: "US2:q@x.com" }]);
    const orig = drCli.getAccountDetails;
    drCli.getAccountDetails = async () => null;
    try {
      assert.equal(await authHealth.resolveIsSupport("US2:q@x.com", { serverKey: "US2", email: "q@x.com" }), null);
    } finally { drCli.getAccountDetails = orig; }
  });
});

describe("recordDiscoveredMeta", () => {
  beforeEach(rmRegistry);
  it("persists isSupport from a discovery result immediately", () => {
    authHealth.recordDiscoveredMeta([
      { id: "US2:s@x.com", email: "s@x.com", serverKey: "US2", orgDomain: "x.com", isSupport: true },
    ]);
    assert.equal(authHealth.isSupportAccount("US2:s@x.com"), true);
  });
});
