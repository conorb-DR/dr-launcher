const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const drCli = require("../lib/dr-cli");

// P3-7: pure parsing helpers in dr-cli.

describe("parseMultiAccountList", () => {
  it("parses the multi-account stderr block", () => {
    const text = [
      "error: multiple accounts stored for US2. specify --account <email>:",
      "  - support@ai.exercise.shachar.com (last used 2026-05-18)",
      "  - support@ai-exercise.johnstanton.com (last used 2026-05-17)",
    ].join("\n");
    const accounts = drCli.parseMultiAccountList(text);
    assert.deepEqual(accounts, [
      { email: "support@ai.exercise.shachar.com", lastUsed: "2026-05-18" },
      { email: "support@ai-exercise.johnstanton.com", lastUsed: "2026-05-17" },
    ]);
  });

  it("returns [] when there is no list", () => {
    assert.deepEqual(drCli.parseMultiAccountList("not logged in"), []);
    assert.deepEqual(drCli.parseMultiAccountList(""), []);
  });
});

describe("extractDomain", () => {
  it("extracts the domain from a well-formed email", () => {
    assert.equal(drCli.extractDomain("support@ai.exercise.shachar.com"), "ai.exercise.shachar.com");
  });

  it("returns the input unchanged when there is no single @", () => {
    assert.equal(drCli.extractDomain("noatsign"), "noatsign");
    assert.equal(drCli.extractDomain("a@b@c"), "a@b@c");
  });

  it("handles empty/falsey input", () => {
    assert.equal(drCli.extractDomain(""), "");
  });
});
