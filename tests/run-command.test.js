const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { runNoShell } = require("../lib/run-command");

// P3-2: prove that the no-shell spawn form (the one runDr uses for the JS/exe
// entry) passes argument values verbatim — shell metacharacters have no
// special meaning. We use `node -e <echo>` as a stand-in for dr. A leading
// "--" terminates node's own option parsing (so flag-looking values aren't
// eaten by node); node consumes the "--", leaving argv[1..] = our values.
const ECHO = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

describe("runNoShell argument safety (P3-2)", () => {
  it("round-trips adversarial values unchanged", async () => {
    const vals = [
      "a&b",
      "a|b",
      "a<b",
      "a>b",
      'a"b',
      "a%PATH%b",
      "a!b!",
      "two words here",
      "a^b",
      "semi;colon",
      "back\\slash",
      "$(whoami)",
      "`whoami`",
      "plain-value",
    ];
    const r = await runNoShell(process.execPath, ["-e", ECHO, "--", ...vals]);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), vals);
  });

  it("preserves a value that looks like a flag", async () => {
    const vals = ["--server", "US2", "--account", "a@b.com"];
    const r = await runNoShell(process.execPath, ["-e", ECHO, "--", ...vals]);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.stdout), vals);
  });

  it("returns enriched result shape", async () => {
    const r = await runNoShell(process.execPath, ["-e", "process.exit(3)"]);
    assert.equal(r.exitCode, 3);
    assert.equal(typeof r.timedOut, "boolean");
    assert.equal("signal" in r, true);
  });
});
