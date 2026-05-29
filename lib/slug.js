const crypto = require("crypto");

// Collapse runs of non-alphanumerics to single hyphens, trim, lowercase.
function sanitize(s) {
  return String(s || "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

// Per-(org, account) slug shared by BOTH the workspace folder and the Chrome
// profile dir, so they can never drift. Encodes BOTH org identity AND account
// identity: the same support/admin email can span multiple orgs, so org alone
// (the old behavior) collides across accounts, and account alone collides across
// orgs. The 10-char hash over serverKey:orgId:orgDomain:email makes collisions
// negligibly unlikely; the readable prefix is for humans only.
function customerSlug(serverKey, orgId, orgDomain, email) {
  const key = String(serverKey || "").toLowerCase();
  const org = `${orgId || "0"}-${sanitize(orgDomain).slice(0, 40)}`;
  const acct = sanitize(String(email || "").split("@")[0]).slice(0, 24);
  const hash = crypto
    .createHash("sha256")
    .update(`${key}:${orgId || ""}:${String(orgDomain || "").toLowerCase()}:${String(email || "").toLowerCase()}`)
    .digest("hex")
    .slice(0, 10);
  return `${key}-${org}-${acct}-${hash}`.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

module.exports = { customerSlug, sanitize };
