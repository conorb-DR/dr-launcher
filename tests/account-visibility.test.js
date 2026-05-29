const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { filterByVisibility } = require("../lib/account-visibility");

const support = { id: "US2:support@x.com", isSupport: true };
const user = { id: "US2:user@x.com", isSupport: false };
const unknown = { id: "US2:who@x.com" }; // no isSupport field

describe("filterByVisibility", () => {
  it("support-only default: keeps support, drops non-support + unknown, counts hidden", () => {
    const { accounts, hiddenNonSupport } = filterByVisibility([support, user, unknown], { showAll: false });
    assert.deepEqual(accounts.map((a) => a.id), [support.id]);
    assert.equal(hiddenNonSupport, 2);
  });

  it("showAll: keeps everything, hiddenNonSupport = 0", () => {
    const { accounts, hiddenNonSupport } = filterByVisibility([support, user, unknown], { showAll: true });
    assert.equal(accounts.length, 3);
    assert.equal(hiddenNonSupport, 0);
  });

  it("a non-support account with an ACTIVE session stays visible and is NOT counted hidden", () => {
    const keep = new Set([user.id]); // user has a running session
    const { accounts, hiddenNonSupport } = filterByVisibility([support, user, unknown], {
      showAll: false,
      keepAccountIds: keep,
    });
    assert.deepEqual(accounts.map((a) => a.id).sort(), [support.id, user.id].sort());
    assert.equal(hiddenNonSupport, 1); // only `unknown` hidden
  });

  it("accepts keepAccountIds as an array too", () => {
    const { accounts } = filterByVisibility([user], { showAll: false, keepAccountIds: [user.id] });
    assert.equal(accounts.length, 1);
  });

  it("handles empty / missing input", () => {
    assert.deepEqual(filterByVisibility(undefined, { showAll: false }), { accounts: [], hiddenNonSupport: 0 });
  });
});
