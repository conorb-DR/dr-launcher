const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const auth = require("../lib/auth");

// P3-1: isUserAuthorized is the pure predicate behind the requireAuthenticated
// route gate.

describe("isUserAuthorized (P3-1)", () => {
  it("rejects a null/absent user", () => {
    assert.equal(auth.isUserAuthorized(null), false);
    assert.equal(auth.isUserAuthorized(undefined), false);
  });

  it("authorizes a dev-mode session", () => {
    assert.equal(auth.isUserAuthorized({ devMode: true }), true);
    // dev mode wins even if a tokenExpired flag is somehow present
    assert.equal(auth.isUserAuthorized({ devMode: true, tokenExpired: true }), true);
  });

  it("authorizes a real user with a live token", () => {
    assert.equal(auth.isUserAuthorized({ email: "a@b.com" }), true);
    assert.equal(auth.isUserAuthorized({ email: "a@b.com", tokenExpired: false }), true);
  });

  it("rejects a real user with an expired token", () => {
    assert.equal(auth.isUserAuthorized({ email: "a@b.com", tokenExpired: true }), false);
  });
});
