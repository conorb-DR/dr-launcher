// Lightweight static server for the Playwright harness. Serves the REAL
// public/ tree and applies the same minimal index.html templating the
// production `/` route does — WITHOUT any of server.js's boot side-effects
// (no PID write, no previous-server kill, no auth-health timers / `dr` calls,
// no tray, no auto-open). The API is stubbed in-browser by Playwright
// page.route, so this server never needs API routes.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");
const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 3457;

const app = express();

// Mirror the production `/` route's placeholder substitution so the page boots
// cleanly. (Real route also sets an HttpOnly cookie, but app.js never reads it
// and all /api/* calls are stubbed, so no cookie is needed here.)
function serveIndex(_req, res) {
  let html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  html = html
    .replace(/__THEME__/g, "warm")
    .replace(/__USER_NAME__/g, "")
    .replace(/__USER_INITIALS__/g, "");
  res.type("html").send(html);
}
app.get("/", serveIndex);
app.get("/index.html", serveIndex);

// Static assets at /static (mirrors server.js:198). Force text/javascript for
// .mjs so Chrome will execute the ES modules introduced in Phase 5b (a wrong
// MIME silently blocks module execution).
app.use("/static", express.static(PUBLIC, {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".mjs")) {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    }
  },
}));

app.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[e2e] static server on http://127.0.0.1:${PORT}`);
});
