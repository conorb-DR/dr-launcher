// Minimal cookie parsing — avoids a cookie-parser dependency. The launcher sets
// the API token as an HttpOnly, SameSite=Strict, host-only cookie; this reads it
// back. The token is read ONLY from the cookie — never the query string or a
// JS-set header — which closes the old page-source leak and the SSE query-token
// path.

const TOKEN_COOKIE = "dr_launcher_token";

function parseCookie(header) {
  const out = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* leave raw */ }
    out[k] = v;
  }
  return out;
}

// Read the API token from the request's Cookie header only.
function readApiToken(req) {
  return parseCookie(req && req.headers && req.headers.cookie)[TOKEN_COOKIE];
}

module.exports = { TOKEN_COOKIE, parseCookie, readApiToken };
