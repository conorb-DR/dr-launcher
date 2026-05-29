const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { parseCookie, readApiToken, TOKEN_COOKIE } = require("../lib/cookie");

describe("parseCookie", () => {
  it("parses multiple cookies", () => {
    const c = parseCookie(`a=1; ${TOKEN_COOKIE}=abc123; b=two`);
    assert.equal(c.a, "1");
    assert.equal(c[TOKEN_COOKIE], "abc123");
    assert.equal(c.b, "two");
  });
  it("returns {} for missing/garbage headers", () => {
    assert.deepEqual(parseCookie(undefined), {});
    assert.deepEqual(parseCookie(""), {});
    assert.deepEqual(parseCookie("nonsense"), {});
  });
});

describe("readApiToken", () => {
  it("reads the token from the cookie header", () => {
    const req = { headers: { cookie: `${TOKEN_COOKIE}=tok-xyz` } };
    assert.equal(readApiToken(req), "tok-xyz");
  });

  it("returns undefined when there is no cookie (request is rejected)", () => {
    assert.equal(readApiToken({ headers: {} }), undefined);
    assert.equal(readApiToken({}), undefined);
  });

  it("IGNORES a query-string token — the old SSE leak path no longer authenticates", () => {
    // Even if a caller appends ?token=..., readApiToken only consults the cookie.
    const req = { query: { token: "tok-from-query" }, headers: {} };
    assert.equal(readApiToken(req), undefined);
  });

  it("IGNORES an X-DR-Launcher-Token header — token is cookie-only now", () => {
    const req = { headers: { "x-dr-launcher-token": "tok-from-header" } };
    assert.equal(readApiToken(req), undefined);
  });
});
