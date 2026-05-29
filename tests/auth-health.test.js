const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const authHealth = require("../lib/auth-health");

// P3-7: classifyProbeResult is the pure decision function behind auth-health.

describe("classifyProbeResult", () => {
  it("treats a timeout as unchanged", () => {
    assert.equal(authHealth.classifyProbeResult({ timedOut: true, exitCode: null }), "unchanged");
  });

  it("returns active for a future JWT exp", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600; // 1h out
    const r = { exitCode: 0, stdout: JSON.stringify({ claims: { exp } }), stderr: "" };
    assert.equal(authHealth.classifyProbeResult(r), "active");
  });

  it("returns expired for a past JWT exp", () => {
    const exp = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const r = { exitCode: 0, stdout: JSON.stringify({ claims: { exp } }), stderr: "" };
    assert.equal(authHealth.classifyProbeResult(r), "expired");
  });

  it("returns unchanged on exit 0 with unparseable stdout", () => {
    assert.equal(authHealth.classifyProbeResult({ exitCode: 0, stdout: "not json", stderr: "" }), "unchanged");
  });

  it("returns expired when stderr matches an auth-failure pattern", () => {
    const r = { exitCode: 1, stdout: "", stderr: "error: not logged in" };
    assert.equal(authHealth.classifyProbeResult(r), "expired");
  });

  it("returns unchanged for a non-auth non-zero exit", () => {
    const r = { exitCode: 1, stdout: "", stderr: "some transient network blip" };
    assert.equal(authHealth.classifyProbeResult(r), "unchanged");
  });
});
