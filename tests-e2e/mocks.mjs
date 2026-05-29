// Shared harness setup: in-browser init script (no-op EventSource + first-launch
// suppression) and a stateful page.route backend that mirrors the real API
// contracts. State lives in this Node-side closure, so it survives page.reload()
// — which is what makes the settings persistence round-trip test work.
import {
  USER, SERVERS, SETTINGS, HEALTH, ACCOUNTS_ALL, SESSIONS_INITIAL,
  launchSuccessBody, LAUNCH_403, LAUNCH_428,
} from "./fixtures.mjs";

function computeAccounts(state) {
  const keep = new Set(state.sessions.map((s) => s.accountId));
  const showAll = state.settings.showAllAccounts === true;
  let hiddenNonSupport = 0;
  const accounts = [];
  for (const a of ACCOUNTS_ALL) {
    if (showAll || a.isSupport === true || keep.has(a.id)) accounts.push(a);
    else hiddenNonSupport++;
  }
  return { accounts, showAllAccounts: showAll, hiddenNonSupport };
}

/**
 * Install the harness on a page. Call BEFORE page.goto("/").
 * @param {import('@playwright/test').Page} page
 * @param {{ launch?: "success" | "support_only" | "account_type_unknown", launchDelayMs?: number }} [opts]
 */
export async function setupHarness(page, opts = {}) {
  const launchMode = opts.launch || "success";
  const launchDelayMs = opts.launchDelayMs || 0;

  // Per-test mutable backend state.
  const state = {
    settings: { ...SETTINGS },
    sessions: SESSIONS_INITIAL.map((s) => ({ ...s })),
  };

  // Runs in the page before any app code: suppress the one-time first-launch
  // modal and replace EventSource with a deterministic no-op (launch/cli SSE).
  await page.addInitScript(() => {
    try { window.localStorage.setItem("dr-first-launch-v1:anon", "1970-01-01T00:00:00.000Z"); } catch (_e) { /* ignore */ }
    class FakeEventSource {
      constructor(url) { this.url = url; this.readyState = 1; this.onmessage = null; this.onerror = null; this.onopen = null; this._listeners = {}; }
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
      removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
      close() { this.readyState = 2; }
    }
    window.EventSource = FakeEventSource;
  });

  const json = (route, obj, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const method = req.method();
    const pathname = new URL(req.url()).pathname;

    // GET endpoints
    if (method === "GET") {
      switch (pathname) {
        case "/api/auth/status": return json(route, { configured: true, authenticated: true, user: USER });
        case "/api/sync/status": return json(route, { lastSyncedAt: null, dirty: false, cloudAvailable: false, error: null });
        case "/api/servers":     return json(route, { servers: SERVERS });
        case "/api/settings":    return json(route, state.settings);
        case "/api/health":      return json(route, HEALTH);
        case "/api/recents":     return json(route, { recents: [] });
        case "/api/sessions":    return json(route, { sessions: state.sessions });
        case "/api/sessions/health": return json(route, { ok: true, sessions: state.sessions });
        case "/api/agents":      return json(route, { agents: [] });
        case "/api/accounts":    return json(route, computeAccounts(state));
        default: return json(route, {});
      }
    }

    // POST/PUT endpoints
    if (pathname === "/api/sync/init") return json(route, { ok: true, preferences: { theme: "warm" } });

    if (pathname === "/api/settings" && (method === "POST" || method === "PUT")) {
      const patch = req.postDataJSON() || {};
      Object.assign(state.settings, patch);
      return json(route, state.settings);
    }

    if (pathname === "/api/launch" && method === "POST") {
      if (launchMode === "support_only")        return json(route, LAUNCH_403, 403);
      if (launchMode === "account_type_unknown") return json(route, LAUNCH_428, 428);
      // Optional delay so a spec can observe the transient "launching" row state.
      if (launchDelayMs) await new Promise((r) => setTimeout(r, launchDelayMs));
      // success: register a live session for the launched account so the
      // post-launch fetchSessions() flips the row to "active".
      const body = req.postDataJSON() || {};
      if (body.id && !state.sessions.some((s) => s.accountId === body.id)) {
        state.sessions.push({
          sessionId: `sess-${body.id}`, accountId: body.id, email: body.email,
          serverKey: body.serverKey, orgDomain: body.orgDomain, orgId: body.orgId ?? null,
          status: "active", chromePid: 4242, chromeProfilePath: "C:\\p", chromeHwnds: [1],
          terminalPid: 5252, terminalHwnds: [2], desktopName: null, desktopCreated: false,
          workspacePath: "C:\\Workspaces\\DR\\x", launchedAt: "2026-05-29T10:31:00.000Z",
          chromeOk: true, terminalOk: true, agentId: null, agentName: null,
        });
      }
      return json(route, launchSuccessBody());
    }

    return json(route, {});
  });

  return state;
}
