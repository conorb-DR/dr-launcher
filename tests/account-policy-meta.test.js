const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate LOCALAPPDATA before requiring settings/preferences (paths captured at load).
const TMP = path.join(os.tmpdir(), `dr-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.LOCALAPPDATA = TMP;

const { parseIsSupport } = require("../lib/dr-cli");
const preferences = require("../lib/preferences");
const settings = require("../lib/settings");

describe("parseIsSupport (tolerant is_support claim)", () => {
  it("true for the confirmed boolean true and defensive truthy forms", () => {
    for (const v of [true, "true", 1, "1"]) assert.equal(parseIsSupport(v), true, JSON.stringify(v));
  });
  it("false for boolean false, other values, and missing", () => {
    for (const v of [false, "false", 0, "", null, undefined, "SUPER_ADMIN"]) {
      assert.equal(parseIsSupport(v), false, JSON.stringify(v));
    }
  });
});

describe("showAllAccounts is machine-local (feature contract)", () => {
  it("is NOT in preferences.SYNCABLE_KEYS", () => {
    assert.ok(!preferences.SYNCABLE_KEYS.includes("showAllAccounts"),
      "showAllAccounts must not sync across devices");
  });
  it("defaults to false in settings", () => {
    assert.equal(settings.getSettings().showAllAccounts, false);
  });
});
