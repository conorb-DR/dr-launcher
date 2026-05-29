const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { customerSlug } = require("../lib/slug");
const workspace = require("../lib/workspace");
const chrome = require("../lib/chrome");

describe("customerSlug — per-account AND per-org", () => {
  const A = ["US2", 552, "ai.exercise.shachar.com", "user@ai.exercise.shachar.com"];
  const B = ["US2", 552, "ai.exercise.shachar.com", "support@ai.exercise.shachar.com"];

  it("two accounts in the SAME org are distinct", () => {
    assert.notEqual(customerSlug(...A), customerSlug(...B));
  });

  it("the SAME email across TWO orgs is distinct (the multi-org case)", () => {
    const o1 = customerSlug("US2", 552, "ai.exercise.shachar.com", "support@datarails.com");
    const o2 = customerSlug("US2", 999, "other.example.com", "support@datarails.com");
    assert.notEqual(o1, o2);
  });

  it("is stable for identical inputs", () => {
    assert.equal(customerSlug(...A), customerSlug(...A));
  });

  it("is filesystem-safe (lowercase, [a-z0-9-] only)", () => {
    assert.match(customerSlug(...A), /^[a-z0-9-]+$/);
  });
});

// Path-level regression: distinct RESOLVED workspace + profile paths, not just
// slug strings — catches missed call-site plumbing in workspace.js / chrome.js.
describe("resolved workspace + profile paths are per-(org,account) distinct", () => {
  const A = { serverKey: "US2", orgId: 552, orgDomain: "ai.exercise.shachar.com", email: "user@ai.exercise.shachar.com" };
  const B = { serverKey: "US2", orgId: 552, orgDomain: "ai.exercise.shachar.com", email: "support@ai.exercise.shachar.com" };

  it("two same-org accounts → distinct workspace slug AND chrome profile path", () => {
    const wsA = workspace.customerSlug(A.serverKey, A.orgId, A.orgDomain, A.email);
    const wsB = workspace.customerSlug(B.serverKey, B.orgId, B.orgDomain, B.email);
    assert.notEqual(wsA, wsB, "workspace slugs must differ");

    const pA = chrome.profilePath(A.serverKey, A.orgId, A.orgDomain, A.email);
    const pB = chrome.profilePath(B.serverKey, B.orgId, B.orgDomain, B.email);
    assert.notEqual(pA, pB, "chrome profile paths must differ");
  });

  it("same email across two orgs → distinct workspace slug AND profile path", () => {
    const wsX = workspace.customerSlug("US2", 1, "a.example.com", "support@datarails.com");
    const wsY = workspace.customerSlug("US2", 2, "b.example.com", "support@datarails.com");
    assert.notEqual(wsX, wsY);

    const pX = chrome.profilePath("US2", 1, "a.example.com", "support@datarails.com");
    const pY = chrome.profilePath("US2", 2, "b.example.com", "support@datarails.com");
    assert.notEqual(pX, pY);
  });

  it("workspace and chrome agree on the slug for the same identity (shared helper)", () => {
    const ws = workspace.customerSlug(A.serverKey, A.orgId, A.orgDomain, A.email);
    const prof = chrome.profilePath(A.serverKey, A.orgId, A.orgDomain, A.email);
    assert.ok(prof.endsWith(ws), "profile dir name should equal the workspace slug");
  });
});
