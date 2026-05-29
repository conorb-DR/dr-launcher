const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const servers = require("../lib/servers");
const { resolveLaunchIdentity } = require("../lib/launch-identity");

describe("resolveLaunchIdentity (P1-2)", () => {
  it("computes canonical serverHost and accountId", () => {
    const id = resolveLaunchIdentity({
      serverKey: "UK",
      email: "support@acme.co.uk",
      orgDomain: "acme.co.uk",
    });
    assert.equal(id.serverKey, "UK");
    assert.equal(id.serverHost, servers.serverHost("UK"));
    assert.equal(id.accountId, "UK:support@acme.co.uk");
  });

  it("uppercases / normalises the server key", () => {
    const id = resolveLaunchIdentity({ serverKey: "us2", email: "a@b.com", orgDomain: "b.com" });
    assert.equal(id.serverKey, "US2");
    assert.equal(id.serverHost, servers.serverHost("US2"));
  });

  it("ignores any client-supplied serverHost (not even read)", () => {
    const id = resolveLaunchIdentity({
      serverKey: "US",
      email: "a@b.com",
      orgDomain: "b.com",
      // an attacker-controlled value — must have no effect
      serverHost: "https://evil.example.com",
    });
    assert.equal(id.serverHost, servers.serverHost("US"));
    assert.notEqual(id.serverHost, "https://evil.example.com");
  });

  it("throws on an unknown server key", () => {
    assert.throws(() => resolveLaunchIdentity({ serverKey: "ZZ", email: "a@b.com" }), /Unknown server/);
  });

  it("throws on a malformed email", () => {
    assert.throws(() => resolveLaunchIdentity({ serverKey: "US", email: "not-an-email" }), /Invalid email/);
    assert.throws(() => resolveLaunchIdentity({ serverKey: "US", email: "" }), /Invalid email/);
    assert.throws(() => resolveLaunchIdentity({ serverKey: "US" }), /Invalid email/);
  });

  it("flags a domain mismatch but preserves the discovered orgDomain", () => {
    const id = resolveLaunchIdentity({
      serverKey: "US",
      email: "consultant@datarails.com",
      orgDomain: "customer-corp.com",
    });
    assert.equal(id.domainMismatch, true);
    assert.equal(id.orgDomain, "customer-corp.com", "orgDomain must NOT be rewritten");
    assert.equal(id.emailDomain, "datarails.com");
  });

  it("does not flag when email domain matches orgDomain (case-insensitive)", () => {
    const id = resolveLaunchIdentity({
      serverKey: "US",
      email: "user@Acme.COM",
      orgDomain: "acme.com",
    });
    assert.equal(id.domainMismatch, false);
  });
});
