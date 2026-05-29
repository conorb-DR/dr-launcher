const servers = require("./servers");

// Resolve a trusted launch identity from the (untrusted) client payload.
//
// The browser sends serverKey, email, orgDomain, orgId — and historically also
// a serverHost, which /api/launch used directly for the Chrome URL and CLAUDE.md.
// That let the client decide where the launcher pointed Chrome. This function
// recomputes the authoritative values server-side:
//   - serverHost is ALWAYS servers.serverHost(key) (the client value is ignored)
//   - accountId is canonicalised to `${KEY}:${email}`
//
// orgDomain is a *discovered* value (workspace slug, CLAUDE.md). It is preserved
// verbatim — NOT rewritten — because a tenant's org domain may legitimately
// differ from the email domain. A mismatch is surfaced as `domainMismatch` for
// the caller to log, not corrected silently.
//
// Throws on an unknown server key or a malformed email.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function resolveLaunchIdentity({ serverKey, email, orgDomain, orgId } = {}) {
  const key = servers.validateKey(serverKey); // throws on unknown server

  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    throw new Error(`Invalid email for launch identity: ${email}`);
  }

  const serverHost = servers.serverHost(key); // canonical — client serverHost ignored
  const accountId = `${key}:${email}`;
  const emailDomain = email.split("@")[1] || "";
  const domainMismatch = !!(
    orgDomain &&
    emailDomain &&
    emailDomain.toLowerCase() !== String(orgDomain).toLowerCase()
  );

  return {
    serverKey: key,
    serverHost,
    accountId,
    email,
    orgDomain: orgDomain || null, // preserved, never rewritten
    orgId: orgId || null,
    emailDomain,
    domainMismatch,
  };
}

module.exports = { resolveLaunchIdentity };
