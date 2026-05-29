// ───────────────────────────────────────────────────────────────
// DR Launcher · app.js (Studio design system)
// ───────────────────────────────────────────────────────────────

const API_TOKEN = (typeof window !== "undefined") ? window.__DR_TOKEN__ : null;

const headers = {
  "Content-Type": "application/json",
  "X-DR-Launcher-Token": API_TOKEN,
};

// ── State ─────────────────────────────────────────────────────────
let accounts = [];
let loading = true;
let userSettings = { useVirtualDesktops: false };
let vdAvailable = null;
let launchInProgress = false;
let activeLaunch = null;
let launchingAccountId = null; // id of the account currently launching (row-level "launching" badge keys off this, not orgDomain)
let recentLaunches = [];
let filterServer = null;
let selectedIds = new Set();
let batchOrder = [];
let batchQueue = null;
let searchQuery = "";
let launchSSE = null;
let viewMode = "all";
let favoriteIds = new Set();
let collapsedServers = new Set();
let syncStatus = { lastSyncedAt: null, dirty: false, cloudAvailable: false, error: null };
let dragIdx = null;
let activeSessions = [];
let healthChecks = null;
let prereqWarningDismissed = false;
let batchCloseInProgress = false;
let batchCloseProgress = null;
let authState = { configured: false, authenticated: false, user: null };
let launchErrors = [];
let sortMode = "lastUsed";
let lastRefreshedAt = null;
let statusFilter = "all"; // "all" | "active" | "stale" | "reauth" | "idle"
let agentCatalog = [];
let _prevExpiredIds = null;

// ── Server metadata ──────────────────────────────────────────────
// Fallback used until /api/servers responds. `host` mirrors the canonical
// hosts in lib/servers.js BUNDLED_DEFAULTS — keep them in sync (enforced by
// tests/server-registry.test.js). Build URLs from `.host`, never `.label`.
let serverList = [
  { key: "US",  host: "https://app.datarails.com",   label: "app.datarails.com",      color: "#4646CE", soft: "#DFD9FF", text: "#25258C", region: "United States" },
  { key: "US2", host: "https://us-2.datarails.com",  label: "us-2.datarails.com",     color: "#7B61FF", soft: "#F0EEFF", text: "#5D45D6", region: "United States (instance 2)" },
  { key: "UK",  host: "https://ukapp.datarails.com", label: "ukapp.datarails.com",    color: "#03A678", soft: "#ECFAE4", text: "#037C5A", region: "United Kingdom" },
  { key: "CA",  host: "https://caapp.datarails.com", label: "caapp.datarails.com",    color: "#FFA310", soft: "#FFF4D4", text: "#9E5F00", region: "Canada" },
];
function serverInfo(key) {
  return serverList.find((s) => s.key === key) || { key, host: "", label: "", color: "#9EA1AA", soft: "#F0F1F4", text: "#4E566C", region: key };
}
async function fetchServers() {
  try {
    const res = await fetch("/api/servers", { headers });
    const data = await res.json();
    if (Array.isArray(data.servers) && data.servers.length > 0) {
      serverList = data.servers;
    }
  } catch { /* keep fallback */ }
}

// ── Row state derivation ─────────────────────────────────────────
function rowState(account) {
  const session = activeSessions.find((s) => s.accountId === account.id);
  const queued = selectedIds.has(account.id) && batchQueue;
  if (queued) return "queued";
  if (launchInProgress && launchingAccountId === account.id) return "launching";
  if (session) {
    if (session.status === "stale") return "stale";
    if (account.cliAuthStatus === "expired") return "active-reauth";
    return "active";
  }
  if (account.cliAuthStatus === "expired") return "reauth";
  const err = launchErrors.find((e) => e.accountId === account.id);
  if (err) return "failed";
  return "idle";
}

const ST_STATE_LABELS = {
  active: "Active",
  "active-reauth": "Active · re-auth needed",
  stale: "Stale",
  reauth: "Needs re-auth",
  failed: "Partial launch",
  queued: "Queued",
  launching: "Launching",
};

// ── Auth API ─────────────────────────────────────────────────────
async function fetchAuthStatus() {
  try {
    const res = await fetch("/api/auth/status", { headers });
    authState = await res.json();
  } catch {
    authState = { configured: false, authenticated: false, user: null };
  }
  updateUserUI();
}

let authPollTimer = null;

async function triggerLogin() {
  try {
    const statusEl = document.getElementById("login-status");
    const btnEl = document.getElementById("login-btn");
    if (btnEl) btnEl.disabled = true;
    if (statusEl) statusEl.innerHTML = '<div class="spinner"></div> Waiting for Microsoft sign-in…';

    const res = await fetch("/api/auth/login", { method: "POST", headers });
    const data = await res.json();
    if (data.error) {
      if (statusEl) statusEl.textContent = data.error;
      if (btnEl) btnEl.disabled = false;
      return;
    }

    startAuthPolling();
  } catch (err) {
    const statusEl = document.getElementById("login-status");
    if (statusEl) statusEl.textContent = "Failed to start sign-in: " + err.message;
    const btnEl = document.getElementById("login-btn");
    if (btnEl) btnEl.disabled = false;
  }
}

function startAuthPolling() {
  if (authPollTimer) return;
  let attempts = 0;
  authPollTimer = setInterval(async () => {
    attempts++;
    await fetchAuthStatus();
    if (authState.authenticated) {
      clearInterval(authPollTimer);
      authPollTimer = null;
      transitionToApp();
    } else if (attempts >= 60) {
      clearInterval(authPollTimer);
      authPollTimer = null;
      const statusEl = document.getElementById("login-status");
      if (statusEl) statusEl.textContent = "Sign-in timed out. Click the button to try again.";
      const btnEl = document.getElementById("login-btn");
      if (btnEl) btnEl.disabled = false;
    }
  }, 2000);
}

async function transitionToApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app-shell").style.display = "";
  try {
    const res = await fetch("/api/sync/init", { method: "POST", headers });
    const data = await res.json();
    if (data.ok && data.preferences) {
      applyTheme(data.preferences.theme || "warm");
    }
    await fetchSyncStatus();
  } catch { /* sync is best-effort */ }
  await initApp();
}

async function fetchSyncStatus() {
  try {
    const res = await fetch("/api/sync/status", { headers });
    syncStatus = await res.json();
  } catch { /* best-effort */ }
}

async function triggerSync() {
  try {
    const res = await fetch("/api/sync", { method: "POST", headers });
    const data = await res.json();
    if (data.ok) {
      if (data.preferences) applyTheme(data.preferences.theme || "warm");
      await Promise.all([fetchSettings(), fetchRecents()]);
      favoriteIds = new Set(userSettings.favoriteIds || []);
      collapsedServers = new Set(userSettings.collapsedServers || []);
      render();
      showToast("Sync complete.");
    } else {
      showToast("Sync failed: " + (data.error || "unknown"), "error");
    }
    await fetchSyncStatus();
  } catch (err) {
    showToast("Sync failed: " + err.message, "error");
  }
}

async function triggerLogout() {
  try {
    await fetch("/api/auth/logout", { method: "POST", headers });
    authState = { configured: false, authenticated: false, user: null };
    updateUserUI();
    showToast("Signed out", "info");
  } catch (err) {
    showToast("Failed to sign out: " + err.message, "error");
  }
}

function updateUserUI() {
  // Reveal the correct login block FIRST — this must run even on the login
  // screen, where the app topbar (and #user-pill) hasn't been rendered yet.
  // (Previously the early-return below skipped it, leaving a logged-out user
  // stranded on the brand-only card with no way to sign in.)
  const msPanel = document.getElementById("login-microsoft");
  const devPanel = document.getElementById("login-dev");
  if (msPanel) msPanel.style.display = authState.configured ? "" : "none";
  if (devPanel) devPanel.style.display = authState.configured ? "none" : "";

  const pill = document.getElementById("user-pill");
  if (!pill) return;
  if (authState.authenticated && authState.user) {
    const u = authState.user;
    pill.innerHTML = `
      <span class="user-pill__avatar" style="background:linear-gradient(135deg, #F93576, #BE1E52)">
        ${esc(u.initials || "?")}
        <span class="user-pill__sync-dot${syncStatus.error ? " user-pill__sync-dot--error" : ""}"></span>
      </span>
      <span class="user-pill__info">
        <span class="user-pill__name">${esc(u.name || "User")}</span>
        <span class="user-pill__status" style="color:var(--st-state-active-fg)">● synced ${syncStatus.lastSyncedAt ? new Date(syncStatus.lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
      </span>
      <svg class="user-pill__caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    `;
  } else {
    pill.innerHTML = `
      <span class="user-pill__avatar">?</span>
      <span class="user-pill__info"><span class="user-pill__name">Sign in</span></span>
    `;
  }
}

async function triggerDevLogin() {
  const password = document.getElementById("dev-password")?.value;
  const name = document.getElementById("dev-name")?.value?.trim();
  const statusEl = document.getElementById("login-status");

  if (!password) {
    if (statusEl) statusEl.textContent = "Please enter the password.";
    return;
  }

  try {
    const res = await fetch("/api/auth/dev-login", {
      method: "POST",
      headers,
      body: JSON.stringify({ password, name: name || undefined }),
    });
    const data = await res.json();
    if (data.error) {
      if (statusEl) statusEl.textContent = data.error;
      return;
    }
    authState = { configured: false, authenticated: true, user: data.user };
    updateUserUI();
    transitionToApp();
  } catch (err) {
    if (statusEl) statusEl.textContent = "Login failed: " + err.message;
  }
}

// ── API calls ────────────────────────────────────────────────────
async function fetchAccounts(force) {
  loading = accounts.length === 0;
  if (loading) render();
  try {
    const url = force ? "/api/accounts?force=1" : "/api/accounts";
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (accounts.length === 0) showToast("Failed to load accounts (server returned " + res.status + ")", "error");
      loading = false;
      render();
      return;
    }
    const data = await res.json();
    accounts = data.accounts || [];
  } catch (err) {
    if (accounts.length === 0) showToast("Failed to load accounts: " + err.message, "error");
  }
  loading = false;
  lastRefreshedAt = new Date();
  render();
}

async function fetchSettings() {
  try {
    const res = await fetch("/api/settings", { headers });
    userSettings = await res.json();
  } catch { /* defaults */ }
}

async function fetchHealth() {
  try {
    const res = await fetch("/api/health", { headers });
    const data = await res.json();
    healthChecks = data.checks || null;
    vdAvailable = data.checks?.virtualDesktop?.available === true;
  } catch {
    healthChecks = null;
    vdAvailable = false;
  }
}

async function recheckHealth() {
  try {
    const res = await fetch("/api/health?force=true", { headers });
    const data = await res.json();
    healthChecks = data.checks || null;
    vdAvailable = data.checks?.virtualDesktop?.available === true;
  } catch {
    healthChecks = null;
    vdAvailable = false;
  }
}

async function fetchRecents() {
  try {
    const res = await fetch("/api/recents", { headers });
    const data = await res.json();
    recentLaunches = data.recents || [];
  } catch { /* defaults */ }
}

async function saveRecents() {
  try {
    await fetch("/api/recents", {
      method: "POST",
      headers,
      body: JSON.stringify({ recents: recentLaunches }),
    });
  } catch { /* best-effort */ }
}

async function fetchSessions() {
  try {
    const res = await fetch("/api/sessions", { headers });
    const data = await res.json();
    activeSessions = (data.sessions || []).filter((s) => s.status === "active" || s.status === "stale");
  } catch {
    activeSessions = [];
  }
}

async function fetchAgents() {
  try {
    const res = await fetch("/api/agents", { headers });
    if (!res.ok) { agentCatalog = []; return; }
    const data = await res.json();
    agentCatalog = Array.isArray(data.agents) ? data.agents : [];
  } catch { agentCatalog = []; }
}

async function checkSessionHealth() {
  try {
    await fetch("/api/sessions/health", { headers });
  } catch { /* best-effort */ }
  await fetchSessions();
  render();
}

async function closeSessionRequest(sessionId, orgDomain) {
  try {
    const res = await fetch("/api/sessions/close", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(`Failed to close session: ${data.error || "Unknown error"}`, "error", {
        action: { label: "Force close", fn: () => forceCloseRequest(sessionId, orgDomain) },
      });
      await fetchSessions();
      render();
      return false;
    }
    showToast(`Session closed for ${orgDomain}.`);
    await fetchSessions();
    render();
    return true;
  } catch (err) {
    showToast("Failed to close session: " + err.message, "error", {
      action: { label: "Force close", fn: () => forceCloseRequest(sessionId, orgDomain) },
    });
    await fetchSessions();
    render();
    return false;
  }
}

async function forceCloseRequest(sessionId, orgDomain) {
  try {
    const res = await fetch("/api/sessions/force-close", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`Session force-closed for ${orgDomain}.`);
    } else {
      showToast(`Force close failed: ${data.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    showToast("Force close failed: " + err.message, "error");
  }
  await fetchSessions();
  render();
}

function showCloseConfirmation(sessionId, orgDomain, isStale = false) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:440px">
      <div class="modal__head">
        <div>
          <h2>${isStale ? "Force close stale session?" : "Close session?"}</h2>
          <p>${isStale
            ? `The session for <strong>${esc(orgDomain)}</strong> appears stale (processes may have exited). Force close will clean up the session record.`
            : `This will close Chrome, the terminal, and remove the virtual desktop for <strong>${esc(orgDomain)}</strong>.`
          }</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__foot">
        <button class="st-btn st-btn--ghost" data-modal-close>Cancel</button>
        <button class="st-btn ${isStale ? "st-btn--stale" : "st-btn--destructive"}" id="confirm-close-session">${isStale ? "Force close" : "Close session"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#confirm-close-session").addEventListener("click", () => {
    closeModal();
    if (isStale) {
      forceCloseRequest(sessionId, orgDomain);
    } else {
      closeSessionRequest(sessionId, orgDomain);
    }
  });
  wireModalClose(overlay);
}

async function closeBatchRequest(sessionIds) {
  batchCloseInProgress = true;
  batchCloseProgress = { total: sessionIds.length, current: 0 };
  render();
  try {
    const res = await fetch("/api/sessions/close-batch", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionIds }),
    });
    const data = await res.json();
    if (data.ok) {
      const succeeded = data.results.filter(r => r.ok).length;
      const total = data.results.length;
      if (succeeded === total) {
        showToast(`Closed ${total} session${total === 1 ? "" : "s"}.`);
      } else {
        showToast(`Closed ${succeeded} of ${total} sessions (${total - succeeded} failed).`, "warn");
      }
    } else {
      showToast("Failed to close sessions: " + (data.error || "Unknown error"), "error");
    }
  } catch (err) {
    showToast("Failed to close sessions: " + err.message, "error");
  }
  batchCloseInProgress = false;
  batchCloseProgress = null;
  selectedIds.clear();
  batchOrder = [];
  await fetchSessions();
  render();
}

function showBatchCloseConfirmation(sessionsToClose) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const listHtml = sessionsToClose.map(s => {
    const si = serverInfo(s.serverKey);
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
      <span class="st-badge st-badge--${rowState({ id: s.accountId, cliAuthStatus: "active", orgDomain: s.orgDomain, serverKey: s.serverKey })}">
        <span class="st-badge__dot"></span>${esc(s.orgDomain)}
      </span>
    </div>`;
  }).join("");

  overlay.innerHTML = `
    <div class="modal" style="width:500px">
      <div class="modal__head">
        <div>
          <h2>Close ${sessionsToClose.length} session${sessionsToClose.length === 1 ? "" : "s"}?</h2>
          <p>This will close Chrome, terminals, and remove virtual desktops for:</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__body" style="max-height:300px; overflow-y:auto">
        ${listHtml}
      </div>
      <div class="modal__foot">
        <button class="st-btn st-btn--ghost" data-modal-close>Cancel</button>
        <button class="st-btn st-btn--destructive" id="confirm-batch-close">Close ${sessionsToClose.length} session${sessionsToClose.length === 1 ? "" : "s"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#confirm-batch-close").addEventListener("click", () => {
    closeModal();
    closeBatchRequest(sessionsToClose.map(s => s.sessionId));
  });
  wireModalClose(overlay);
}

function sessionDuration(launchedAt) {
  const ms = Date.now() - new Date(launchedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

function filterAccounts(list) {
  let out = list;
  if (viewMode === "recent") {
    const recentIds = new Set(recentLaunches.map((r) => r.accountId));
    out = out.filter((a) => recentIds.has(a.id));
    const order = recentLaunches.map((r) => r.accountId);
    out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  } else if (viewMode === "favorites") {
    out = out.filter((a) => favoriteIds.has(a.id));
  } else if (viewMode === "sessions") {
    const ids = new Set(activeSessions.map((s) => s.accountId));
    out = out.filter((a) => ids.has(a.id));
  }
  if (filterServer) out = out.filter((a) => a.serverKey === filterServer);
  if (statusFilter !== "all") {
    out = out.filter((a) => {
      const s = rowState(a);
      if (statusFilter === "active") return s === "active" || s === "active-reauth";
      if (statusFilter === "stale") return s === "stale";
      if (statusFilter === "reauth") return s === "reauth" || s === "active-reauth";
      if (statusFilter === "idle") return s === "idle";
      return true;
    });
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    out = out.filter((a) =>
      (a.orgDomain || "").toLowerCase().includes(q) ||
      (a.email || "").toLowerCase().includes(q) ||
      (a.orgId || "").toString().includes(q) ||
      (a.serverKey || "").toLowerCase().includes(q) ||
      serverInfo(a.serverKey).label.toLowerCase().includes(q)
    );
  }
  if (sortMode === "az") {
    out.sort((a, b) => (a.orgDomain || "").localeCompare(b.orgDomain || ""));
  } else if (sortMode === "server") {
    out.sort((a, b) => (a.serverKey || "").localeCompare(b.serverKey || "") || (a.orgDomain || "").localeCompare(b.orgDomain || ""));
  }
  return out;
}

async function saveSettings(partial) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers,
      body: JSON.stringify(partial),
    });
    userSettings = await res.json();
    render();
  } catch (err) {
    showToast("Failed to save settings: " + err.message, "error");
  }
}

async function saveSettingsQuiet(partial) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers,
      body: JSON.stringify(partial),
    });
    userSettings = await res.json();
  } catch { /* best-effort */ }
}

function toggleFavorite(id) {
  if (favoriteIds.has(id)) favoriteIds.delete(id);
  else favoriteIds.add(id);
  saveSettings({ favoriteIds: [...favoriteIds] });
}

function toggleCollapse(serverKey) {
  if (collapsedServers.has(serverKey)) collapsedServers.delete(serverKey);
  else collapsedServers.add(serverKey);
  saveSettings({ collapsedServers: [...collapsedServers] });
}

function connectLaunchSSE() {
  if (launchSSE) return;
  launchSSE = new EventSource(`/api/launch-stream?token=${encodeURIComponent(API_TOKEN)}`);
  launchSSE.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.done) return;
      activeLaunch = {
        orgDomain: data.orgDomain,
        serverKey: data.serverKey,
        step: data.step,
        totalSteps: data.totalSteps,
        label: data.label,
      };
      renderLaunchStrip();
      render();
    } catch { /* ignore */ }
  };
  launchSSE.onerror = () => {
    launchSSE.close();
    launchSSE = null;
  };
}

function disconnectLaunchSSE() {
  if (launchSSE) { launchSSE.close(); launchSSE = null; }
}

async function launchCustomer(account, opts = {}) {
  const quiet = opts.quiet || false;
  const activeSession = activeSessions.find((s) => s.accountId === account.id);
  if (activeSession) {
    if (!quiet) showToast(
      `Session already active for ${account.orgDomain} — close it first.`,
      "warn",
      { persistent: true, action: { label: "Close it", fn: async () => {
        const closed = await closeSessionRequest(activeSession.sessionId, account.orgDomain);
        if (closed) showToast("Session closed. You can re-launch now.");
      }}}
    );
    return { ok: false, account, error: "active_session_exists" };
  }
  if (launchInProgress) {
    if (!quiet) showToast("A launch is already in progress. Please wait.", "warn");
    return { ok: false, account, error: "launch_in_progress" };
  }
  launchInProgress = true;
  launchingAccountId = account.id;
  activeLaunch = { orgDomain: account.orgDomain, serverKey: account.serverKey, step: 1, totalSteps: 5, label: "Starting" };
  connectLaunchSSE();
  renderLaunchStrip();
  render();

  try {
    const payload = { ...account };
    if (opts.noSwitch) payload.noSwitch = true;
    if (opts.agentId) payload.agentId = opts.agentId;
    if (opts.agentInputs) payload.agentInputs = opts.agentInputs;
    const res = await fetch("/api/launch", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 409) {
      const errData = await res.json().catch(() => ({}));
      if (errData.error === "active_session_exists") {
        const serverSession = activeSessions.find((s) => s.accountId === account.id);
        if (!quiet) {
          const toastOpts = serverSession
            ? { persistent: true, action: { label: "Close it", fn: async () => {
                const closed = await closeSessionRequest(serverSession.sessionId, account.orgDomain);
                if (closed) showToast("Session closed. You can re-launch now.");
              }}}
            : {};
          showToast(errData.message || `Active session exists for ${account.orgDomain}.`, "warn", toastOpts);
        }
        return { ok: false, account, error: "active_session_exists" };
      }
      if (!quiet) showToast("Another launch is in progress. Please wait.", "warn");
      return { ok: false, account, error: "conflict" };
    }

    const data = await res.json();
    if (!res.ok) {
      showToast("Launch failed: " + (data.error || "Unknown error"), "error");
      return { ok: false, account, error: data.error || "Unknown error" };
    }

    if (data.sessionError) {
      showToast(`Session tracking failed: ${data.sessionError}`, "warn");
    }

    if (data.authExpired && !quiet) {
      showToast(
        `⚠️ ${account.orgDomain}: CLI session expired — re-authenticate before dr commands will work: dr login --server ${account.serverKey} --account ${account.email}`,
        "warn",
        { persistent: true }
      );
    }

    if (!quiet) {
      const parts = [];
      if (data.chrome?.ok) parts.push("Chrome");
      if (data.terminal?.ok) parts.push("Claude Code");
      if (parts.length > 0) {
        showToast(`Launched ${account.orgDomain} — ${parts.join(" + ")} opening.`);
      }
      if (data.workspace?.claudeMdCreated) {
        showToast(`New workspace created at ${data.workspace.path}.`);
      }
    }

    if (!quiet && data.virtualDesktop?.enabled) {
      const vd = data.virtualDesktop;
      if (vd.ok && vd.switched) {
        const reused = vd.reused ? " (reused existing)" : "";
        showToast(`Virtual desktop "${vd.desktopName}" ready${reused}.`);
      } else if (vd.ok && !vd.switched) {
        showToast(`Windows moved to desktop but couldn't auto-switch.`, "warn");
      } else if (vd.movedChrome || vd.movedTerminal) {
        const moved = [vd.movedChrome && "Chrome", vd.movedTerminal && "Terminal"].filter(Boolean).join(" + ");
        showToast(`Partial: ${moved} moved to desktop, but some steps failed.`, "warn");
      } else {
        showToast(`Chrome + Claude opened. Desktop move failed — they're on the current desktop.`, "warn");
      }
      if (vd.pinnedWarning) showToast(vd.pinnedWarning, "warn");
    }

    if (!data.terminal?.ok) {
      if (!quiet) showToast("Terminal unavailable — copying instructions.", "warn");
      try {
        await navigator.clipboard.writeText(data.instruction);
        if (!quiet) showToast("Instructions copied to clipboard.");
      } catch {
        showInstructionModal(data.instruction, account.orgDomain, data.workspace?.path);
      }
    }

    if (data.chrome?.ok === false || data.terminal?.ok === false) {
      launchErrors = launchErrors.filter((e) => e.accountId !== account.id);
      launchErrors.push({
        launchId: data.launchId || Date.now().toString(),
        accountId: account.id,
        orgDomain: account.orgDomain,
        chromeError: data.chrome?.ok === false ? (data.chrome.error || "Failed") : null,
        terminalError: data.terminal?.ok === false ? (data.terminal.error || "Failed") : null,
        at: new Date().toISOString(),
      });
    } else {
      launchErrors = launchErrors.filter((e) => e.accountId !== account.id);
    }

    const desktopName = data.virtualDesktop?.desktopName || null;
    recentLaunches = recentLaunches.filter((r) => r.accountId !== account.id);
    recentLaunches.unshift({
      accountId: account.id,
      orgDomain: account.orgDomain,
      serverKey: account.serverKey,
      email: account.email || "",
      launchedAt: new Date().toISOString(),
    });
    if (recentLaunches.length > 10) recentLaunches.length = 10;
    saveRecents();

    const firstLaunchKey = `dr-first-launch-v1:${authState?.user?.id || "anon"}`;
    if (!localStorage.getItem(firstLaunchKey)) {
      showFirstLaunchModal(data);
      localStorage.setItem(firstLaunchKey, new Date().toISOString());
    }

    if (data.authExpired) await fetchAccounts();
    await fetchSessions();
    return { ok: true, account, desktopName };
  } catch (err) {
    showToast("Launch failed: " + err.message, "error");
    return { ok: false, account, error: err.message };
  } finally {
    launchInProgress = false;
    launchingAccountId = null;
    activeLaunch = null;
    disconnectLaunchSSE();
    renderLaunchStrip();
    render();
  }
}

async function launchBatchQueue(agentOpts = null) {
  const ids = batchOrder.length > 0 ? [...batchOrder] : [...selectedIds];
  if (ids.length === 0 || launchInProgress) return;
  const isBatch = ids.length > 1;
  batchQueue = { ids, current: 0 };
  selectedIds.clear();
  batchOrder = [];
  const results = [];
  let lastDesktopName = null;
  for (let i = 0; i < ids.length; i++) {
    batchQueue.current = i;
    const acct = accounts.find((a) => a.id === ids[i]);
    if (!acct) { results.push({ ok: false, account: null }); continue; }
    const result = await launchCustomer(acct, { quiet: true, noSwitch: isBatch, ...(agentOpts || {}) });
    results.push(result);
    if (result.ok && result.desktopName) lastDesktopName = result.desktopName;
    if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  batchQueue = null;
  if (isBatch && lastDesktopName) {
    try {
      await fetch("/api/switch-desktop", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: lastDesktopName }),
      });
    } catch { /* best-effort */ }
  }
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && r.account);
  const total = ids.length;
  if (succeeded === total) {
    showToast(`Batch complete — ${total} customer${total === 1 ? "" : "s"} launched.`, null, { persistent: true });
  } else if (failed.length > 0) {
    showToast(
      `${failed.length} of ${total} launches failed.`,
      "warn",
      { persistent: true, action: { label: "Retry failed", fn: () => {
        const retryIds = failed.map((r) => r.account.id);
        batchOrder = retryIds;
        selectedIds = new Set(retryIds);
        launchBatchQueue();
      }}}
    );
  } else {
    showToast(`Batch done — ${succeeded} of ${total} launched.`, "warn", { persistent: true });
  }
  render();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    batchOrder = batchOrder.filter((x) => x !== id);
  } else {
    selectedIds.add(id);
    batchOrder.push(id);
  }
  renderLaunchStrip();
  render();
}

function toggleSelectAll(filtered) {
  const allSelected = filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id));
  if (allSelected) {
    filtered.forEach((a) => selectedIds.delete(a.id));
    const ids = new Set(filtered.map((a) => a.id));
    batchOrder = batchOrder.filter((x) => !ids.has(x));
  } else {
    filtered.forEach((a) => {
      if (!selectedIds.has(a.id)) {
        selectedIds.add(a.id);
        batchOrder.push(a.id);
      }
    });
  }
  renderLaunchStrip();
  render();
}

function clearSelection() {
  selectedIds.clear();
  batchOrder = [];
  renderLaunchStrip();
  render();
}

async function copyInstruction(account) {
  const instruction = buildLocalInstruction(account);
  try {
    await navigator.clipboard.writeText(instruction);
    showToast(`Instructions copied for ${account.orgDomain}.`);
  } catch {
    showInstructionModal(instruction, account.orgDomain);
  }
}

function buildLocalInstruction(account) {
  return `Customer context (paste into Claude Desktop):
- Server: ${account.serverKey}
- Account: ${account.email}
- UI: ${account.serverHost}
- Org Domain: ${account.orgDomain}

For every dr command, include:
--server ${account.serverKey} --account ${account.email}

Never rely on the default dr account for this task.`;
}

async function startLogin(serverKey, targetAccountId) {
  closeModal();
  showToast(`Starting authentication for ${serverKey}… Complete login in the browser window.`);
  try {
    await fetch("/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ server: serverKey, accountId: targetAccountId || null }),
    });
    let polls = 0;
    const maxPolls = 40;
    const prevCount = accounts.length;
    const interval = setInterval(async () => {
      polls++;
      try {
        const res = await fetch("/api/accounts?force=1", { headers });
        const data = await res.json();
        const newAccounts = data.accounts || [];
        if (targetAccountId) {
          const target = newAccounts.find((a) => a.id === targetAccountId);
          if (target && target.cliAuthStatus !== "expired") {
            clearInterval(interval);
            accounts = newAccounts;
            render();
            showToast(`Re-authenticated ${target.orgDomain || serverKey}.`);
            return;
          }
        }
        if (newAccounts.length > prevCount) {
          clearInterval(interval);
          accounts = newAccounts;
          render();
          showToast("New customer account detected.");
          return;
        }
      } catch { /* ignore */ }
      if (polls >= maxPolls) {
        clearInterval(interval);
        await fetchAccounts();
      }
    }, 3000);
  } catch (err) {
    showToast("Login failed: " + err.message, "error");
  }
}

// ── Helpers ───────────────────────────────────────────────────────
// Escape for safe interpolation into HTML text AND attribute values.
// Pure string replacement (no DOM) so it is testable headless and so that
// quotes are escaped — the DOM textContent approach left `"`/`'` unescaped,
// which is unsafe inside attributes like value="${esc(...)}".
function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initialsOf(account) {
  const dom = (account.orgDomain || "").replace(/\.[a-z]+$/i, "");
  const parts = dom.split(/[-.]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts[0]?.length >= 2) return parts[0].slice(0, 2).toUpperCase();
  const e = (account.email || "??").replace(/[^a-z]/gi, "");
  return e.slice(0, 2).toUpperCase() || "??";
}

function avatarColor(account) {
  const palette = ["#4646CE", "#F93576", "#03A678", "#7B61FF", "#FFA310", "#579BF2", "#54DBCE", "#BE1E52"];
  const s = account.orgDomain || account.email || "";
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function shadeHex(hex, percent) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0,2), 16);
  const g = parseInt(h.slice(2,4), 16);
  const b = parseInt(h.slice(4,6), 16);
  const a = (c) => Math.max(0, Math.min(255, Math.round(c + (percent / 100) * 255)));
  const x = (n) => n.toString(16).padStart(2, "0");
  return "#" + x(a(r)) + x(a(g)) + x(a(b));
}

function avatarHTML(account, state) {
  const c = avatarColor(account);
  const glow = state === "active" ? " tbl__avatar--glow-active" : state === "stale" ? " tbl__avatar--glow-stale" : "";
  return `<span class="tbl__avatar${glow}" style="background:linear-gradient(135deg,${c} 0%,${shadeHex(c, -22)} 100%)">${esc(initialsOf(account))}</span>`;
}

function timeAgo(date) {
  if (!date) return "loading…";
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

const ICON = {
  rocket: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.3-.05-3.05a2.07 2.07 0 0 0-2.95.05Z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
  shield: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>`,
  copy:   `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  more:   `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="18" r="1"/></svg>`,
  chev:   `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  user:   `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  clock:  `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  filter: `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M6 12h12M10 18h4"/></svg>`,
  plus:   `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  refresh:`<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.06-6.78L21 8"/><path d="M21 3v5h-5"/></svg>`,
  arrow:  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>`,
  x:      `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  star:   `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  starFilled: `<svg class="ic" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  grip:   `<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`,
  sun:    `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  moon:   `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>`,
  stop:   `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
  zap:    `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  checkCircle: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>`,
  xCircle: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
  alertTriangle: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  terminal: `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  book: `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>`,
  externalLink: `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  desktop: `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>`,
  settings: `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>`,
  help: `<svg class="ic ic--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  search: `<svg class="ic ic--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
};

// ── Topbar rendering ─────────────────────────────────────────────
function renderTopbar() {
  const el = document.getElementById("topbar");
  if (!el) return;

  el.innerHTML = `
    <div class="topbar__brand">
      <img class="topbar__brand-mark" src="/static/ds/brand-mark.png" alt="Datarails" />
      <span class="topbar__brand-name">datarails</span>
      <span class="topbar__brand-tag">Launcher</span>
      <span class="topbar__brand-version">1.4.0</span>
    </div>

    <div class="topbar__center">
      <div class="topbar__search">
        <span class="topbar__search-icon">${ICON.search}</span>
        <input type="text" placeholder="Search customers, org IDs, hosts" value="${esc(searchQuery)}" />
        <span class="topbar__kbd">Ctrl+K</span>
      </div>
    </div>

    <div class="topbar__right">
      <button class="st-icon-btn" id="btn-refresh" title="Refresh">${ICON.refresh}</button>
      <button class="st-icon-btn" id="btn-help" title="Help">${ICON.help}</button>
      <button class="st-icon-btn" id="btn-settings" title="Settings">${ICON.settings}</button>
      <span class="topbar__sep"></span>
      <button class="user-pill" id="user-pill"></button>
    </div>
  `;

  updateUserUI();

  el.querySelector("#btn-refresh")?.addEventListener("click", () => fetchAccounts(true));
  el.querySelector("#btn-settings")?.addEventListener("click", showSettingsModal);
  el.querySelector("#btn-help")?.addEventListener("click", showHelpModal);
  el.querySelector("#user-pill")?.addEventListener("click", () => {
    if (authState.authenticated) {
      if (confirm("Sign out of DR Launcher?")) triggerLogout();
    }
  });

  const searchInput = el.querySelector(".topbar__search input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      render();
    });
  }
}

// ── Sidebar rendering ────────────────────────────────────────────
function renderSidebar() {
  const el = document.getElementById("sidebar");
  if (!el) return;

  const total = accounts.length;
  const recent = recentLaunches.length;
  const favCount = favoriteIds.size;
  const activeCount = accounts.filter((a) => { const s = rowState(a); return s === "active" || s === "stale" || s === "active-reauth"; }).length;
  const queueCount = selectedIds.size;
  const reauthCount = accounts.filter((a) => { const s = rowState(a); return s === "reauth" || s === "active-reauth"; }).length;

  const navItem = (key, icon, label, count, opts = {}) => {
    const isActive = opts.active || false;
    const stateClass = opts.state ? ` sidebar__item-count--state` : "";
    const iconHtml = opts.swatch
      ? `<span class="sidebar__item-swatch" style="background:${opts.swatch}"></span>`
      : `<span class="sidebar__item-icon">${icon}</span>`;
    return `
      <button class="sidebar__item${isActive ? " is-active" : ""}" data-nav="${esc(key)}">
        ${iconHtml}
        <span class="sidebar__item-label">${label}</span>
        ${count != null && count > 0 ? `<span class="sidebar__item-count${stateClass}">${count}</span>` : ""}
      </button>`;
  };

  const envRows = [];
  if (healthChecks) {
    envRows.push(["dr CLI", healthChecks.dr?.version || (healthChecks.dr?.found ? "installed" : "—")]);
    envRows.push(["Chrome", healthChecks.chrome?.found ? "stable" : "—"]);
    envRows.push(["Windows Terminal", healthChecks.windowsTerminal?.found ? "installed" : "—"]);
    envRows.push(["Claude", healthChecks.claude?.found ? "installed" : "—"]);
    envRows.push(["Virtual desktops", vdAvailable ? "on" : "off"]);
  }

  const allHealthy = healthChecks && healthChecks.dr?.found && healthChecks.chrome?.found;

  el.innerHTML = `
    <div>
      <div class="sidebar__label">Workspace</div>
      <div class="sidebar__items">
        ${navItem("all", ICON.user, "Customers", total, { active: viewMode === "all" && filterServer === null })}
        ${navItem("recent", ICON.clock, "Recent", recent, { active: viewMode === "recent" })}
        ${navItem("sessions", ICON.zap, "Active sessions", activeCount, { active: viewMode === "sessions", state: activeCount > 0 })}
        ${navItem("queue", ICON.rocket, "Launch queue", queueCount, { active: false })}
        ${navItem("favorites", "★", "Favorites", favCount, { active: viewMode === "favorites" })}
        ${navItem("reauth", ICON.shield, "Needs re-auth", reauthCount, { active: false, state: reauthCount > 0 })}
      </div>
    </div>

    <div>
      <div class="sidebar__label">Servers</div>
      <div class="sidebar__items">
        ${serverList.map((s) => {
          const n = accounts.filter((a) => a.serverKey === s.key).length;
          return navItem("srv-" + s.key,
            "",
            `<span style="font-weight:600">${esc(s.key)}</span><span class="sidebar__server-host">${esc(s.label)}</span>`,
            n,
            { active: filterServer === s.key, swatch: s.color }
          );
        }).join("")}
      </div>
    </div>

    <div>
      <div class="sidebar__label">Tools</div>
      <div class="sidebar__items">
        ${navItem("diagnostics", ICON.copy, "Diagnostics", null, { active: viewMode === "diagnostics" })}
        ${navItem("cli-tools", ICON.terminal, "DR CLI", null, { active: viewMode === "cli-tools" })}
        ${navItem("settings", ICON.settings, "Settings", null, { active: false })}
      </div>
    </div>

    <div style="flex:1"></div>

    <div class="env-card">
      <div class="env-card__header">
        <span class="env-card__title">Environment</span>
        <span class="env-card__status">
          <span class="env-card__status-dot" style="background:${allHealthy ? "var(--st-state-active-dot)" : "var(--st-state-failed-dot)"}"></span>
          ${allHealthy ? "healthy" : "issues"}
        </span>
      </div>
      ${envRows.map(([k, v], i) => `
        <div class="env-card__row">
          <span class="env-card__row-label">${esc(k)}</span>
          <span class="env-card__row-value">${esc(v)}</span>
        </div>
      `).join("")}
      <div class="env-card__footer">
        <button class="env-card__btn" id="copy-support-bundle">
          ${ICON.copy} Support bundle
        </button>
        <button class="env-card__link-btn" id="open-diagnostics" title="Open Diagnostics">
          ${ICON.externalLink}
        </button>
      </div>
    </div>
  `;

  // Wire sidebar navigation
  el.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.nav;
      if (key === "settings") { showSettingsModal(); return; }
      if (key.startsWith("srv-")) {
        const sk = key.slice(4);
        filterServer = filterServer === sk ? null : sk;
        viewMode = "all";
      } else if (key === "all") {
        viewMode = "all"; filterServer = null;
      } else if (key === "recent") {
        viewMode = "recent"; filterServer = null;
      } else if (key === "favorites") {
        viewMode = "favorites"; filterServer = null;
      } else if (key === "sessions") {
        viewMode = "sessions"; filterServer = null;
      } else if (key === "cli-tools") {
        viewMode = "cli-tools"; filterServer = null;
      } else if (key === "diagnostics") {
        viewMode = "diagnostics"; filterServer = null;
      } else if (key === "reauth") {
        statusFilter = "reauth"; viewMode = "all"; filterServer = null;
      }
      render();
    });
  });

  el.querySelector("#copy-support-bundle")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/diagnostics", { headers });
      const data = await res.json();
      await navigator.clipboard.writeText(data.text || "No diagnostics available");
      showToast("Support bundle copied to clipboard.");
    } catch (err) {
      showToast("Failed to copy diagnostics: " + err.message, "error");
    }
  });

  el.querySelector("#open-diagnostics")?.addEventListener("click", () => {
    viewMode = "diagnostics"; filterServer = null; render();
  });
}

// ── Launch strip rendering ───────────────────────────────────────
function renderLaunchStrip() {
  const el = document.getElementById("launch-strip");
  if (!el) return;

  const activeCount = accounts.filter((a) => { const s = rowState(a); return s === "active" || s === "active-reauth"; }).length;
  const staleCount = accounts.filter((a) => rowState(a) === "stale").length;
  const reauthCount = accounts.filter((a) => { const s = rowState(a); return s === "reauth" || s === "active-reauth"; }).length;
  const selCount = selectedIds.size;

  if (launchInProgress && activeLaunch) {
    const pct = batchQueue
      ? Math.round(((batchQueue.current + 0.5) / batchQueue.ids.length) * 100)
      : Math.round((activeLaunch.step / activeLaunch.totalSteps) * 100);
    const batchLabel = batchQueue ? ` (${batchQueue.current + 1}/${batchQueue.ids.length})` : "";

    el.innerHTML = `
      <span class="strip__pill strip__pill--launching">
        <span class="strip__pill-dot strip__pill-dot--launching"></span>
        Launching${batchLabel}
      </span>
      <span class="strip__progress">
        <span class="strip__progress-domain">${esc(activeLaunch.orgDomain)}</span>
        <span class="strip__progress-meta">step ${activeLaunch.step}/${activeLaunch.totalSteps} · ${esc(activeLaunch.label || "starting")} · ${(pct / 20).toFixed(1)}s</span>
        <span class="strip__progress-bar"><span class="strip__progress-fill" style="width:${pct}%"></span></span>
        <span class="strip__progress-pct">${pct}%</span>
      </span>
      <span class="strip__counts">
        ${selCount > 0 ? `<span>queue <strong>${selCount}</strong>/${accounts.length}</span><span class="strip__counts-sep"></span>` : ""}
        ${activeCount > 0 ? `<span style="color:var(--st-state-active-fg);font-weight:600">● ${activeCount} active</span>` : ""}
        ${staleCount > 0 ? `<span style="color:var(--st-state-stale-fg);font-weight:600">● ${staleCount} stale</span>` : ""}
        ${reauthCount > 0 ? `<span style="color:var(--st-state-reauth-fg,#6366f1);font-weight:600">● ${reauthCount} re-auth</span>` : ""}
      </span>
      <span class="strip__actions">
        <button class="st-btn st-btn--ghost st-btn--sm" id="strip-log">View log</button>
        <button class="st-btn st-btn--destructive st-btn--sm" id="strip-cancel">Cancel</button>
      </span>
    `;
  } else if (batchCloseInProgress && batchCloseProgress) {
    const pct = Math.round(((batchCloseProgress.current + 0.5) / batchCloseProgress.total) * 100);
    el.innerHTML = `
      <span class="strip__pill" style="background:var(--st-state-failed-bg);color:var(--st-state-failed-fg)">
        <span class="strip__pill-dot" style="background:var(--st-state-failed-dot)"></span>
        Closing
      </span>
      <span class="strip__progress">
        <span class="strip__progress-meta">Closing ${batchCloseProgress.total} sessions…</span>
        <span class="strip__progress-bar"><span class="strip__progress-fill" style="width:${pct}%;background:var(--st-state-failed-dot)"></span></span>
        <span class="strip__progress-pct" style="color:var(--st-state-failed-fg)">${pct}%</span>
      </span>
    `;
  } else if (selCount > 0) {
    el.innerHTML = `
      <span class="strip__pill" style="background:var(--st-state-queued-bg);color:var(--st-state-queued-fg)">
        <span class="strip__pill-dot" style="background:var(--st-state-queued-dot)"></span>
        Queue
      </span>
      <span class="strip__progress">
        <span class="strip__progress-domain">${selCount} customer${selCount === 1 ? "" : "s"} selected</span>
      </span>
      <span class="strip__counts">
        ${activeCount > 0 ? `<span style="color:var(--st-state-active-fg);font-weight:600">● ${activeCount} active</span>` : ""}
        ${staleCount > 0 ? `<span style="color:var(--st-state-stale-fg);font-weight:600">● ${staleCount} stale</span>` : ""}
        ${reauthCount > 0 ? `<span style="color:var(--st-state-reauth-fg,#6366f1);font-weight:600">● ${reauthCount} re-auth</span>` : ""}
      </span>
      <span class="strip__actions">
        <button class="st-btn st-btn--ghost st-btn--sm" id="strip-clear">Clear</button>
        ${agentCatalog.length > 0 ? `<button class="st-btn st-btn--outline st-btn--sm" id="strip-launch-agent">${ICON.zap} with Agent</button>` : ""}
        <button class="st-btn st-btn--primary st-btn--sm" id="strip-launch">${ICON.rocket} Launch (${selCount})</button>
      </span>
    `;
    el.querySelector("#strip-clear")?.addEventListener("click", clearSelection);
    el.querySelector("#strip-launch")?.addEventListener("click", () => launchBatchQueue());
    el.querySelector("#strip-launch-agent")?.addEventListener("click", (e) => {
      const selectedAccts = accounts.filter((a) => selectedIds.has(a.id));
      showAgentPickerDropdown(el.querySelector("#strip-launch-agent"), selectedAccts, e);
    });
  } else {
    el.innerHTML = `
      <span class="strip__hints">
        <span class="strip__hint"><kbd>Ctrl+K</kbd> search</span>
        <span class="strip__hint"><kbd>Ctrl+A</kbd> select all</span>
        <span class="strip__hint"><kbd>Enter</kbd> launch queue</span>
      </span>
      <span></span>
      <span class="strip__counts">
        ${activeCount > 0 ? `<span style="color:var(--st-state-active-fg);font-weight:600">● ${activeCount} active</span>` : ""}
        ${staleCount > 0 ? `<span style="color:var(--st-state-stale-fg);font-weight:600">● ${staleCount} stale</span>` : ""}
        ${reauthCount > 0 ? `<span style="color:var(--st-state-reauth-fg,#6366f1);font-weight:600">● ${reauthCount} re-auth</span>` : ""}
        ${activeCount === 0 && staleCount === 0 && reauthCount === 0 ? `<span>No active sessions</span>` : ""}
      </span>
      <span></span>
    `;
  }
}

// ── Row rendering ────────────────────────────────────────────────
function renderRow(a) {
  const state = rowState(a);
  const checked = selectedIds.has(a.id);
  const session = activeSessions.find((s) => s.accountId === a.id);
  const si = serverInfo(a.serverKey);
  const disabled = launchInProgress;

  const agentBadge = session?.agentId
    ? ` <span class="st-badge st-badge--agent"><span class="st-badge__dot"></span>${ICON.zap} ${esc(session.agentName || session.agentId)}</span>`
    : "";
  const badgeHtml = state !== "idle"
    ? `<span class="st-status-row"><span class="st-badge st-badge--${state}"><span class="st-badge__dot"></span>${esc(ST_STATE_LABELS[state] || state)}</span>${agentBadge}</span>`
    : `<span class="tbl__idle-dash">—</span>`;

  let actionsHtml = "";
  if (state === "active") {
    actionsHtml = `
      <button class="st-btn st-btn--primary st-btn--sm" data-row-action="switch" data-account-id="${esc(a.id)}">${ICON.desktop} Switch</button>
      <button class="st-btn st-btn--destructive st-btn--sm" data-row-action="close-session" data-account-id="${esc(a.id)}" data-session-id="${esc(session?.sessionId || "")}">End</button>
      <button class="st-kebab" data-row-action="more" data-account-id="${esc(a.id)}" title="More actions">${ICON.more}</button>
    `;
  } else if (state === "stale") {
    actionsHtml = `
      <button class="st-btn st-btn--stale st-btn--sm" data-row-action="launch" data-account-id="${esc(a.id)}">Relaunch</button>
      <button class="st-btn st-btn--ghost st-btn--sm" data-row-action="close-session" data-account-id="${esc(a.id)}" data-session-id="${esc(session?.sessionId || "")}">Recover</button>
      <button class="st-kebab" data-row-action="more" data-account-id="${esc(a.id)}" title="More actions">${ICON.more}</button>
    `;
  } else if (state === "active-reauth") {
    actionsHtml = `
      <button class="st-btn st-btn--primary st-btn--sm" data-row-action="switch" data-account-id="${esc(a.id)}">${ICON.desktop} Switch</button>
      <button class="st-btn st-btn--reauth st-btn--sm" data-row-action="reauth" data-account-id="${esc(a.id)}">Re-authenticate</button>
      <button class="st-btn st-btn--destructive st-btn--sm" data-row-action="close-session" data-account-id="${esc(a.id)}" data-session-id="${esc(session?.sessionId || "")}">End</button>
      <button class="st-kebab" data-row-action="more" data-account-id="${esc(a.id)}" title="More actions">${ICON.more}</button>
    `;
  } else if (state === "reauth") {
    actionsHtml = `
      <button class="st-btn st-btn--reauth st-btn--sm" data-row-action="reauth" data-account-id="${esc(a.id)}">Re-authenticate</button>
      <button class="st-kebab" data-row-action="more" data-account-id="${esc(a.id)}" title="More actions">${ICON.more}</button>
    `;
  } else if (state === "queued") {
    actionsHtml = `
      <button class="st-kebab" data-row-action="more" data-account-id="${esc(a.id)}" title="More actions">${ICON.more}</button>
    `;
  } else if (state === "launching") {
    actionsHtml = `
      <span class="st-badge st-badge--launching"><span class="st-badge__dot"></span>Launching…</span>
    `;
  } else {
    const splitBtn = agentCatalog.length > 0
      ? `<span class="st-btn-group"><button class="st-btn st-btn--primary st-btn--sm" data-row-action="launch" data-account-id="${esc(a.id)}" ${disabled ? "disabled" : ""}>${ICON.rocket} Launch</button><button class="st-btn st-btn--primary st-btn--sm st-btn-split" data-row-action="launch-agent" data-account-id="${esc(a.id)}" ${disabled ? "disabled" : ""} title="Launch with Agent">${ICON.chev}</button></span>`
      : `<button class="st-btn st-btn--primary st-btn--sm" data-row-action="launch" data-account-id="${esc(a.id)}" ${disabled ? "disabled" : ""}>${ICON.rocket} Launch</button>`;
    actionsHtml = `
      ${splitBtn}
      <button class="st-kebab" data-row-action="more" data-account-id="${esc(a.id)}" title="More actions">${ICON.more}</button>
    `;
  }

  const lastUsedHtml = (state === "active" || state === "stale" || state === "active-reauth") && session
    ? `<span class="tbl__uptime">up ${sessionDuration(session.launchedAt)}</span>`
    : esc(a.lastUsed || "");

  return `
    <div class="tbl__row" data-state="${state}" data-id="${esc(a.id)}">
      <span>
        <button class="st-check${checked ? " is-checked" : ""}" data-check-id="${esc(a.id)}">
          <svg viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
        </button>
      </span>
      <span class="tbl__customer">
        ${avatarHTML(a, state)}
        <span class="tbl__customer-info">
          <span class="tbl__customer-domain">${esc(a.orgDomain)}</span>
          <span class="tbl__customer-email">${esc(a.email)}</span>
        </span>
      </span>
      <span>${badgeHtml}</span>
      <span class="tbl__identity">
        <span class="tbl__identity-swatch" style="background:${si.color}"></span>
        <span class="tbl__identity-key">${esc(si.key)}</span>
        <span class="tbl__identity-host">${esc(si.label)}</span>
      </span>
      <span class="tbl__org-user">${esc(a.orgId || "")} · ${esc(a.userId || "")}</span>
      <span class="tbl__last-used">${lastUsedHtml}</span>
      <span class="tbl__actions">${actionsHtml}</span>
    </div>
  `;
}

// ── Skeleton ─────────────────────────────────────────────────────
function renderSkeleton() {
  return `
    <div class="page-header">
      <div class="page-header__breadcrumb st-mono">workspace / customers</div>
      <div class="page-header__title-row">
        <h1 class="page-header__title">Customers</h1>
        <span class="page-header__meta">Loading…</span>
      </div>
    </div>
    <div class="tbl__col-header">
      <span></span><span>Customer</span><span>Status</span>
      <span>Identity</span><span class="st-mono">Org · User</span>
      <span>Last used</span><span style="text-align:right">Action</span>
    </div>
    ${Array.from({ length: 6 }, () => `
      <div class="tbl__row" style="padding:12px 28px">
        <span></span>
        <span style="display:flex;align-items:center;gap:10px">
          <span class="skel skel--circle"></span>
          <span><span class="skel skel--text" style="width:${120 + Math.random() * 60}px"></span></span>
        </span>
        <span><span class="skel skel--pill"></span></span>
        <span><span class="skel skel--text" style="width:80px"></span></span>
        <span><span class="skel skel--text" style="width:60px"></span></span>
        <span><span class="skel skel--text" style="width:50px"></span></span>
        <span></span>
      </div>
    `).join("")}
  `;
}

// ── Main render ──────────────────────────────────────────────────
function render() {
  renderSidebar();
  renderLaunchStrip();
  const main = document.getElementById("main-content");

  if (loading) {
    main.innerHTML = renderSkeleton();
    return;
  }

  const prereqs = classifyPrerequisites();
  if (prereqs.checked && prereqs.hasCritical) {
    main.innerHTML = renderFirstRun(prereqs);
    main.querySelector("#prereq-recheck")?.addEventListener("click", async () => {
      await recheckHealth();
      render();
    });
    return;
  }

  if (viewMode === "cli-tools") {
    renderCliTools(main);
    return;
  }

  if (viewMode === "diagnostics") {
    renderDiagnostics(main);
    return;
  }

  const warningHtml = (prereqs.checked && prereqs.hasWarnings && !prereqWarningDismissed)
    ? renderPrereqWarnings(prereqs) : "";

  if (accounts.length === 0) {
    main.innerHTML = warningHtml + renderEmpty();
    wirePrereqBanner(main);
    main.querySelectorAll("[data-empty-server]").forEach((btn) => {
      btn.addEventListener("click", () => startLogin(btn.dataset.emptyServer));
    });
    return;
  }

  const filtered = filterAccounts(accounts);
  const selCount = selectedIds.size;
  const allChecked = filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id));

  const counts = {
    active: accounts.filter((a) => { const s = rowState(a); return s === "active" || s === "active-reauth"; }).length,
    stale: accounts.filter((a) => rowState(a) === "stale").length,
    reauth: accounts.filter((a) => { const s = rowState(a); return s === "reauth" || s === "active-reauth"; }).length,
    idle: accounts.filter((a) => rowState(a) === "idle").length,
  };

  const pageTitle = viewMode === "sessions" ? "Active sessions"
    : viewMode === "recent" ? "Recently launched"
    : viewMode === "favorites" ? "Favorites"
    : filterServer ? esc(filterServer) + " customers"
    : "Customers";

  main.innerHTML = `
    ${warningHtml}

    ${launchErrors.map((err) => `
      <div class="launch-error-card">
        <div class="launch-error-card__body">
          <strong>Launch partially failed for ${esc(err.orgDomain)}</strong>
          <div class="launch-error-card__detail">
            ${err.chromeError ? `<span>Chrome: ${esc(err.chromeError)}</span>` : ""}
            ${err.terminalError ? `<span>Terminal: ${esc(err.terminalError)}</span>` : ""}
          </div>
        </div>
        <div class="launch-error-card__actions">
          <button class="st-btn st-btn--primary st-btn--sm" data-retry-launch="${esc(err.accountId)}">Retry</button>
          <button class="st-btn st-btn--ghost st-btn--sm" data-dismiss-error="${esc(err.accountId)}">Dismiss</button>
        </div>
      </div>
    `).join("")}

    <div class="page-header">
      <div class="page-header__breadcrumb st-mono">workspace / customers</div>
      <div class="page-header__title-row">
        <h1 class="page-header__title">${pageTitle}</h1>
        <span class="page-header__meta">${filtered.length} accounts · ${serverList.length} servers · last sync ${timeAgo(lastRefreshedAt)}</span>
      </div>
      <div class="page-header__actions">
        <button class="st-btn st-btn--ghost" id="head-sort">${ICON.filter} Sort · ${sortMode === "az" ? "A–Z" : sortMode === "server" ? "Server" : "last used"} ${ICON.chev}</button>
        <span class="page-header__sep"></span>
        <button class="st-btn st-btn--primary" id="head-auth">${ICON.plus} Authenticate customer</button>
      </div>
    </div>

    <div class="filter-strip">
      <span class="filter-strip__label">Show</span>
      <button class="st-chip${statusFilter === "all" ? " is-active" : ""}" data-status-filter="all">
        All <span class="st-chip__count">${accounts.length}</span>
      </button>
      <button class="st-chip${statusFilter === "active" ? " is-active" : ""}" data-status-filter="active">
        <span class="st-chip__dot" style="background:var(--st-state-active-dot)"></span>
        Active <span class="st-chip__count">${counts.active}</span>
      </button>
      <button class="st-chip${statusFilter === "stale" ? " is-active" : ""}" data-status-filter="stale">
        <span class="st-chip__dot" style="background:var(--st-state-stale-dot)"></span>
        Stale <span class="st-chip__count">${counts.stale}</span>
      </button>
      <button class="st-chip${statusFilter === "reauth" ? " is-active" : ""}" data-status-filter="reauth">
        <span class="st-chip__dot" style="background:var(--st-state-reauth-dot)"></span>
        Needs re-auth <span class="st-chip__count">${counts.reauth}</span>
      </button>
      <button class="st-chip${statusFilter === "idle" ? " is-active" : ""}" data-status-filter="idle">
        Idle <span class="st-chip__count">${counts.idle}</span>
      </button>
    </div>

    <div class="tbl__col-header">
      <span>
        <button class="st-check${allChecked ? " is-checked" : ""}" id="check-all" title="Select all">
          <svg viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
        </button>
      </span>
      <span>Customer</span>
      <span>Status</span>
      <span>Identity</span>
      <span class="st-mono">Org · User</span>
      <span>Last used</span>
      <span style="text-align:right">Action</span>
    </div>

    <div id="rows-container">
      ${filtered.map((a) => renderRow(a)).join("")}
    </div>

    ${filtered.length === 0 && accounts.length > 0 ? `
      <div class="st-empty" style="padding:60px 28px">
        <h2>No matching customers</h2>
        <p>Try adjusting your search or filter.</p>
      </div>
    ` : ""}
  `;

  // Wire events
  main.querySelector("#head-auth")?.addEventListener("click", showAuthModal);
  main.querySelector("#head-sort")?.addEventListener("click", (e) => showSortDropdown(e.currentTarget, e));

  main.querySelectorAll("[data-status-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      statusFilter = btn.dataset.statusFilter;
      render();
    });
  });

  main.querySelectorAll("[data-retry-launch]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const acct = accounts.find((a) => a.id === btn.dataset.retryLaunch);
      if (!acct) return;
      const session = activeSessions.find((s) => s.accountId === acct.id);
      if (session) await closeSessionRequest(session.sessionId, acct.orgDomain);
      launchErrors = launchErrors.filter((e) => e.accountId !== acct.id);
      await launchCustomer(acct);
    });
  });
  main.querySelectorAll("[data-dismiss-error]").forEach((btn) => {
    btn.addEventListener("click", () => {
      launchErrors = launchErrors.filter((e) => e.accountId !== btn.dataset.dismissError);
      render();
    });
  });

  main.querySelectorAll("[data-row-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (btn.disabled || btn.classList.contains("is-disabled")) return;
      const id = btn.dataset.accountId;
      const acct = accounts.find((a) => a.id === id);
      if (!acct) return;
      if (btn.dataset.rowAction === "launch") launchCustomer(acct);
      if (btn.dataset.rowAction === "launch-agent") { e.stopPropagation(); showAgentPickerDropdown(btn, [acct], e); }
      if (btn.dataset.rowAction === "switch") {
        const sess = activeSessions.find((s) => s.accountId === acct.id);
        if (sess?.desktopName) {
          fetch("/api/switch-desktop", { method: "POST", headers, body: JSON.stringify({ name: sess.desktopName }) });
        }
      }
      if (btn.dataset.rowAction === "copy") copyInstruction(acct);
      if (btn.dataset.rowAction === "favorite") toggleFavorite(id);
      if (btn.dataset.rowAction === "reauth") startLogin(acct.serverKey, acct.id);
      if (btn.dataset.rowAction === "more") { e.stopPropagation(); showMoreActionsMenu(btn, acct, e); }
      if (btn.dataset.rowAction === "close-session") {
        const sess = activeSessions.find((s) => s.sessionId === btn.dataset.sessionId);
        showCloseConfirmation(btn.dataset.sessionId, acct.orgDomain, sess?.status === "stale");
      }
    });
  });

  main.querySelector("#check-all")?.addEventListener("click", () => toggleSelectAll(filtered));
  main.querySelectorAll("[data-check-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggleSelect(btn.dataset.checkId); });
  });

  wirePrereqBanner(main);
}

// ── Prerequisites ────────────────────────────────────────────────
function classifyPrerequisites() {
  if (!healthChecks) return { checked: false, critical: [], warnings: [], hasCritical: false, hasWarnings: false };

  const critical = [];
  const warnings = [];

  if (!healthChecks.dr?.found) {
    critical.push({
      key: "dr", label: "Datarails CLI (dr)",
      message: "Required to authenticate and discover customer accounts.",
      action: { type: "text", label: "Install the dr CLI and restart the launcher" },
    });
  }
  if (!healthChecks.chrome?.found) {
    critical.push({
      key: "chrome", label: "Google Chrome",
      message: "Required to open customer dashboards.",
      action: { type: "link", label: "Download Chrome", url: "https://www.google.com/chrome/" },
    });
  }
  if (!healthChecks.workspaceRoot?.writable) {
    critical.push({
      key: "workspace", label: "Workspace folder",
      message: `Cannot write to ${esc(healthChecks.workspaceRoot?.path || "workspace root")}. Check folder permissions.`,
      action: { type: "text", label: "Fix folder permissions and re-check" },
    });
  }

  if (!healthChecks.claude?.found) {
    warnings.push({
      key: "claude", label: "Claude CLI",
      message: "Terminal will open but Claude will not start automatically.",
      action: { type: "link", label: "Install Claude CLI", url: "https://docs.anthropic.com/en/docs/claude-code/overview" },
    });
  }
  if (!healthChecks.windowsTerminal?.found) {
    warnings.push({
      key: "windowsTerminal", label: "Windows Terminal",
      message: "Falls back to cmd.exe (less polished experience).",
      action: { type: "link", label: "Install from Microsoft Store", url: "ms-windows-store://pdp/?ProductId=9n0dx20hk701" },
    });
  }
  if (userSettings.useVirtualDesktops && !healthChecks.virtualDesktop?.available) {
    warnings.push({
      key: "virtualDesktop", label: "Virtual Desktops",
      message: "Virtual desktop support unavailable on this system. Launches will use the current desktop.",
      action: { type: "text", label: "Requires Windows 10/11 with compatible build" },
    });
  }

  return { checked: true, critical, warnings, hasCritical: critical.length > 0, hasWarnings: warnings.length > 0 };
}

function buildPrereqAllItems() {
  if (!healthChecks) return [];
  const items = [];
  const add = (key, label, found, message, action) => {
    items.push({ key, label, found, message, action });
  };
  add("dr", "Datarails CLI (dr)", healthChecks.dr?.found,
    healthChecks.dr?.found ? "Installed" : "Required to authenticate and discover customer accounts.",
    healthChecks.dr?.found ? null : { type: "text", label: "Install the dr CLI and restart the launcher" });
  add("chrome", "Google Chrome", healthChecks.chrome?.found,
    healthChecks.chrome?.found ? (healthChecks.chrome.path ? `Installed at ${esc(healthChecks.chrome.path)}` : "Installed") : "Required to open customer dashboards.",
    healthChecks.chrome?.found ? null : { type: "link", label: "Download Chrome", url: "https://www.google.com/chrome/" });
  add("workspace", "Workspace folder", healthChecks.workspaceRoot?.writable,
    healthChecks.workspaceRoot?.writable ? `Writable at ${esc(healthChecks.workspaceRoot?.path || "")}` : `Cannot write to ${esc(healthChecks.workspaceRoot?.path || "workspace root")}`,
    healthChecks.workspaceRoot?.writable ? null : { type: "text", label: "Fix folder permissions and re-check" });
  add("windowsTerminal", "Windows Terminal", healthChecks.windowsTerminal?.found,
    healthChecks.windowsTerminal?.found ? "Installed" : "Falls back to cmd.exe (less polished experience).",
    healthChecks.windowsTerminal?.found ? null : { type: "link", label: "Install from Microsoft Store", url: "ms-windows-store://pdp/?ProductId=9n0dx20hk701" });
  add("claude", "Claude CLI", healthChecks.claude?.found,
    healthChecks.claude?.found ? "Installed" : "Terminal will open but Claude will not start automatically.",
    healthChecks.claude?.found ? null : { type: "link", label: "Install Claude CLI", url: "https://docs.anthropic.com/en/docs/claude-code/overview" });
  return items;
}

function prereqItemHtml(item) {
  const cls = item.found ? "prereq-item--pass" : (["dr", "chrome", "workspace"].includes(item.key) ? "prereq-item--fail" : "prereq-item--warn");
  const icon = item.found ? `<span class="prereq-item__icon prereq-icon--pass">${ICON.checkCircle}</span>`
    : cls === "prereq-item--fail" ? `<span class="prereq-item__icon prereq-icon--fail">${ICON.xCircle}</span>`
    : `<span class="prereq-item__icon prereq-icon--warn">${ICON.alertTriangle}</span>`;
  const actionHtml = !item.action ? ""
    : item.action.type === "link"
      ? `<a class="prereq-item__action" href="${esc(item.action.url)}" target="_blank" rel="noopener">${esc(item.action.label)}</a>`
      : `<span class="prereq-item__action">${esc(item.action.label)}</span>`;
  return `
    <div class="prereq-item ${cls}">
      ${icon}
      <div class="prereq-item__info">
        <div class="prereq-item__label">${esc(item.label)}</div>
        <div class="prereq-item__message">${item.message}</div>
      </div>
      ${actionHtml}
    </div>`;
}

function renderFirstRun(prereqs) {
  const allItems = buildPrereqAllItems();
  return `
    <div class="page-header">
      <div class="page-header__breadcrumb st-mono">setup</div>
      <div class="page-header__title-row">
        <h1 class="page-header__title">Set up your environment</h1>
      </div>
    </div>
    <div class="prereq-screen">
      <p>DR Launcher needs a few tools to work. Install the missing items below, then click Re-check.</p>
      <div class="prereq-list">
        ${allItems.map(prereqItemHtml).join("")}
      </div>
      <div class="prereq-actions">
        <button class="st-btn st-btn--primary" id="prereq-recheck">${ICON.refresh} Re-check</button>
      </div>
    </div>`;
}

function renderPrereqWarnings(prereqs) {
  const labels = prereqs.warnings.map((w) => w.label).join(", ");
  return `
    <div class="prereq-banner">
      <span class="prereq-banner__icon">${ICON.alertTriangle}</span>
      <span class="prereq-banner__text">Some optional tools are missing: ${esc(labels)}.</span>
      <span class="prereq-banner__actions">
        <button class="st-btn st-btn--sm" id="prereq-banner-recheck">${ICON.refresh} Re-check</button>
        <button class="st-btn st-btn--ghost st-btn--sm" id="prereq-banner-dismiss">${ICON.x} Dismiss</button>
      </span>
    </div>`;
}

function wirePrereqBanner(container) {
  container.querySelector("#prereq-banner-recheck")?.addEventListener("click", async () => {
    await recheckHealth();
    render();
  });
  container.querySelector("#prereq-banner-dismiss")?.addEventListener("click", () => {
    prereqWarningDismissed = true;
    render();
  });
}

function renderEmpty() {
  return `
    <div class="page-header">
      <div class="page-header__breadcrumb st-mono">workspace / customers</div>
      <div class="page-header__title-row">
        <h1 class="page-header__title">Customers</h1>
        <span class="page-header__meta">No customers authenticated yet</span>
      </div>
    </div>
    <div class="st-empty">
      <svg width="160" height="120" viewBox="0 0 180 120" fill="none" aria-hidden>
        <rect x="20" y="20" width="120" height="20" rx="10" fill="var(--st-panel)" stroke="var(--st-hair)" stroke-width="1.5" stroke-dasharray="3 4" />
        <rect x="20" y="50" width="120" height="20" rx="10" fill="var(--st-panel)" stroke="var(--st-hair)" stroke-width="1.5" stroke-dasharray="3 4" />
        <rect x="20" y="80" width="120" height="20" rx="10" fill="var(--st-panel)" stroke="var(--st-hair)" stroke-width="1.5" stroke-dasharray="3 4" />
        <circle cx="32" cy="30" r="4.5" fill="#4646CE" />
        <circle cx="32" cy="60" r="4.5" fill="#F93576" />
        <circle cx="32" cy="90" r="4.5" fill="#FFA310" />
        <line x1="46" y1="30" x2="115" y2="30" stroke="var(--st-hair)" stroke-width="2" stroke-linecap="round" />
        <line x1="46" y1="60" x2="100" y2="60" stroke="var(--st-hair)" stroke-width="2" stroke-linecap="round" />
        <line x1="46" y1="90" x2="108" y2="90" stroke="var(--st-hair)" stroke-width="2" stroke-linecap="round" />
      </svg>
      <h2>Welcome to DR Launcher</h2>
      <p>DR Launcher opens isolated Chrome + Claude Code sessions for each customer account, keeping your work separated. Authenticate a customer below to get started.</p>
      <div class="st-empty__servers">
        ${serverList.map((s) => `
          <button class="st-empty__server" data-empty-server="${esc(s.key)}">
            <span class="st-empty__server-dot" style="background:${s.color}"></span>
            Connect via ${esc(s.key)}
            <span class="st-empty__server-host">${esc(s.label)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

// ── Diagnostics view ─────────────────────────────────────────────
function renderDiagnostics(main) {
  main.innerHTML = `
    <div class="page-header">
      <div class="page-header__breadcrumb st-mono">tools / diagnostics</div>
      <div class="page-header__title-row">
        <h1 class="page-header__title">Diagnostics</h1>
        <span class="page-header__meta">System health and environment info</span>
      </div>
      <div class="page-header__actions">
        <button class="st-btn st-btn--ghost" id="diag-recheck">${ICON.refresh} Re-check</button>
        <button class="st-btn st-btn--primary" id="diag-copy">${ICON.copy} Copy support bundle</button>
      </div>
    </div>
    <div class="diag-grid">
      <div class="diag-card">
        <div class="diag-card__head"><span class="diag-card__title">System health</span></div>
        <div class="diag-card__body">${buildSettingsHealthRows()}</div>
      </div>
    </div>
  `;

  main.querySelector("#diag-recheck")?.addEventListener("click", async () => {
    await recheckHealth();
    renderDiagnostics(main);
    showToast("Health check complete.");
  });
  main.querySelector("#diag-copy")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/diagnostics", { headers });
      const data = await res.json();
      await navigator.clipboard.writeText(data.text || "No diagnostics available");
      showToast("Support bundle copied to clipboard.");
    } catch (err) {
      showToast("Failed to copy diagnostics: " + err.message, "error");
    }
  });
  main.querySelector(".crumb-home")?.addEventListener("click", (e) => {
    e.preventDefault(); viewMode = "all"; render();
  });
}

// ── Dropdown menus ──────────────────────────────────────────────
function showDropdown(anchorEl, items, evt) {
  if (evt) evt.stopPropagation();
  closeDropdown();
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "dropdown-menu";
  menu.id = "active-dropdown";
  for (const item of items) {
    if (item === "---") {
      const sep = document.createElement("div");
      sep.className = "dropdown-menu__sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "dropdown-menu__item";
    btn.textContent = item.label;
    btn.addEventListener("click", () => { closeDropdown(); item.action(); });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const menuRect = menu.getBoundingClientRect();
  let left = rect.right - menuRect.width;
  let top = rect.bottom + 4;
  if (left < 4) left = 4;
  if (top + menuRect.height > window.innerHeight - 4) top = rect.top - menuRect.height - 4;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  setTimeout(() => document.addEventListener("click", closeDropdown, { once: true }), 10);
  document.addEventListener("keydown", dropdownEsc);
}
function closeDropdown() {
  document.getElementById("active-dropdown")?.remove();
  document.removeEventListener("keydown", dropdownEsc);
}
function dropdownEsc(e) { if (e.key === "Escape") closeDropdown(); }

function showSortDropdown(anchor, evt) {
  showDropdown(anchor, [
    { label: "Last used", action() { sortMode = "lastUsed"; render(); } },
    { label: "Customer A–Z", action() { sortMode = "az"; render(); } },
    { label: "Server", action() { sortMode = "server"; render(); } },
  ], evt);
}

function showMoreActionsMenu(anchor, acct, evt) {
  const items = [
    { label: "Copy CLI flags", action() { copyInstruction(acct); } },
    { label: favoriteIds.has(acct.id) ? "Remove from favorites" : "Add to favorites", action() { toggleFavorite(acct.id); } },
    "---",
    { label: "Open in browser", action() { window.open(acct.serverHost || serverInfo(acct.serverKey).host, "_blank"); } },
  ];
  const wsSlug = workspace_slug(acct.serverKey, acct.orgId, acct.orgDomain);
  if (healthChecks?.workspaceRoot?.path) {
    items.push({ label: "Open workspace folder", action() {
      fetch("/api/open-folder", { method: "POST", headers, body: JSON.stringify({ folderPath: healthChecks.workspaceRoot.path + "\\\\" + wsSlug }) });
    }});
  }
  showDropdown(anchor, items, evt);
}

function workspace_slug(serverKey, orgId, orgDomain) {
  const domain = (orgDomain || "").replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
  return `${(serverKey || "").toLowerCase()}-${orgId || "0"}-${domain}`;
}

// ── Modals ───────────────────────────────────────────────────────
function showToast(message, level, opts = {}) {
  const tray = document.getElementById("toasts");
  if (!tray) return;
  const el = document.createElement("div");
  el.className = "toast" + (level === "error" ? " toast--error" : level === "warn" ? " toast--warn" : "");

  const body = document.createElement("span");
  body.className = "toast__body";
  body.textContent = message;
  el.appendChild(body);

  const dismiss = () => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 200);
  };

  if (opts.action) {
    const actionBtn = document.createElement("button");
    actionBtn.className = "toast__action";
    actionBtn.textContent = opts.action.label;
    actionBtn.addEventListener("click", () => { opts.action.fn(); dismiss(); });
    el.appendChild(actionBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "toast__close";
  closeBtn.innerHTML = ICON.x;
  closeBtn.addEventListener("click", dismiss);
  el.appendChild(closeBtn);

  tray.appendChild(el);

  const persistent = opts.persistent || opts.action || level === "error";
  if (!persistent) {
    const duration = opts.duration || (level === "warn" ? 8000 : 6000);
    setTimeout(dismiss, duration);
  }
}

function closeModal() {
  document.querySelectorAll(".modal-overlay").forEach((m) => m.remove());
}

function showInstructionModal(instruction, domain, workspacePath) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__head">
        <div>
          <h2>Instructions for ${esc(domain)}</h2>
          <p>Couldn't open the terminal automatically. Copy and paste this into your Claude conversation.</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__body">
        <textarea class="instruction-textarea" readonly>${esc(instruction)}</textarea>
        ${workspacePath ? `<div style="font-size:12px;color:var(--st-ink-muted);margin-top:8px">Workspace: <code style="font-family:'JetBrains Mono',monospace;color:var(--st-ink)">${esc(workspacePath)}</code></div>` : ""}
      </div>
      <div class="modal__foot">
        <span></span>
        <button class="st-btn st-btn--primary" data-modal-close>Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector("textarea");
  ta.focus(); ta.select();
  wireModalClose(overlay);
}

function showFirstLaunchModal(data) {
  const wsPath = data.workspace?.path || "unknown";
  const hasVD = data.virtualDesktop?.ok;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:520px">
      <div class="modal__head">
        <div>
          <h2>What just happened?</h2>
          <p>Here's what DR Launcher set up for this customer session.</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__body" style="font-size:14px;line-height:1.7">
        <ul style="padding-left:20px;margin:0">
          <li><strong>Chrome</strong> opened with an isolated profile — cookies and sessions won't leak between customers</li>
          <li>A <strong>workspace</strong> was created at <code style="font-family:'JetBrains Mono',monospace;font-size:12px">${esc(wsPath)}</code></li>
          <li><strong>CLAUDE.md</strong> in that workspace auto-configures Claude with this customer's context</li>
          <li>A <strong>terminal</strong> opened with Claude Code scoped to that workspace</li>
          ${hasVD ? `<li>Everything was moved to its own <strong>virtual desktop</strong> — use <kbd>Ctrl+Win+Arrow</kbd> to switch</li>` : ""}
        </ul>
      </div>
      <div class="modal__foot">
        <span style="font-size:12px;color:var(--st-ink-muted)">This message only appears once.</span>
        <button class="st-btn st-btn--primary" data-modal-close>Got it</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  wireModalClose(overlay);
}

function showHelpModal() {
  const wsRoot = healthChecks?.workspaceRoot?.path || "~/Documents/DR-Customers";
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal__head">
        <div><h2>DR Launcher Quick Guide</h2></div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__body" style="font-size:14px;line-height:1.7">
        <dl style="margin:0">
          <dt style="font-weight:600;margin-top:8px">Launch</dt>
          <dd style="margin-left:0;color:var(--st-ink-muted)">Opens isolated Chrome + Claude Code terminal per customer</dd>
          <dt style="font-weight:600;margin-top:8px">Workspaces</dt>
          <dd style="margin-left:0;color:var(--st-ink-muted)"><code style="font-family:'JetBrains Mono',monospace;font-size:12px">${esc(wsRoot)}/&lt;server-orgid-domain&gt;/</code></dd>
          <dt style="font-weight:600;margin-top:8px">CLAUDE.md</dt>
          <dd style="margin-left:0;color:var(--st-ink-muted)">Auto-configures Claude with customer context (server, account, CLI flags)</dd>
          <dt style="font-weight:600;margin-top:8px">Virtual desktops</dt>
          <dd style="margin-left:0;color:var(--st-ink-muted)">Optional — each launch gets its own Windows desktop (<kbd>Ctrl+Win+Arrow</kbd> to switch)</dd>
        </dl>
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--st-hair)">
          <div style="font-weight:600;margin-bottom:4px">Keyboard shortcuts</div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:13px;color:var(--st-ink-muted)">
            <kbd>Ctrl+K</kbd><span>Focus search</span>
            <kbd>Ctrl+A</kbd><span>Select all visible</span>
            <kbd>Escape</kbd><span>Close modal / clear search</span>
          </div>
        </div>
      </div>
      <div class="modal__foot">
        <span></span>
        <button class="st-btn st-btn--primary" data-modal-close>Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  wireModalClose(overlay);
}

function showAuthModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__head">
        <div>
          <h2>Authenticate a customer</h2>
          <p>Pick the Datarails server the customer lives on. Your browser will open for SSO; the token stays on this machine.</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__body">
        ${serverList.map((s) => {
          const n = accounts.filter((a) => a.serverKey === s.key).length;
          return `
            <button class="auth-server" data-server="${esc(s.key)}">
              <span class="auth-server__key" style="background:${s.soft};color:${s.text}">${esc(s.key)}</span>
              <span style="flex:1; min-width:0">
                <span class="auth-server__region">${esc(s.region || s.key)}</span>
                <span class="auth-server__host">${esc(s.label)}</span>
              </span>
              <span class="auth-server__meta">${n} authenticated</span>
              <span class="auth-server__caret">${ICON.arrow}</span>
            </button>`;
        }).join("")}
      </div>
      <div class="modal__foot">
        <span>Tokens stored at <code>~/.dr/credentials</code></span>
        <span>Need another region? <a href="#">Contact support</a></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelectorAll("[data-server]").forEach((btn) => {
    btn.addEventListener("click", () => startLogin(btn.dataset.server));
  });
  wireModalClose(overlay);
}

// ── DR CLI tools page ────────────────────────────────────────────
let cliInstallES = null;
let cliInstallOutput = "";

function renderCliTools(main) {
  const drFound = healthChecks?.dr?.found;
  const installing = !!cliInstallES;
  const versionHint = installing ? "Updating…" : (drFound ? "Checking version…" : "Not installed");
  main.innerHTML = `
    <div class="page-header">
      <div class="page-header__breadcrumb st-mono">tools / dr cli</div>
      <div class="page-header__title-row">
        <h1 class="page-header__title">DR CLI</h1>
        <span class="page-header__meta">Install, update, and manage the Datarails command-line interface</span>
      </div>
    </div>
    <div class="cli-tools-grid">
      <div class="settings-card cli-tools-card">
        <div class="cli-tools-card__head">
          <div>
            <div class="cli-tools-card__title">Install / Update</div>
            <div class="cli-tools-card__hint" id="cli-version-info">${versionHint}</div>
          </div>
          <button class="st-btn st-btn--primary" id="cli-install-btn"${installing ? " disabled" : ""}>
            ${installing ? "Installing…" : (drFound ? ICON.refresh + " Update DR CLI" : ICON.plus + " Install DR CLI")}
          </button>
        </div>
        <div id="cli-install-output" class="cli-output" style="display:${installing ? "block" : "none"}">${installing ? cliInstallOutput : ""}</div>
      </div>
      <div class="settings-card cli-tools-card">
        <div class="cli-tools-card__head">
          <div>
            <div class="cli-tools-card__title">CLI Reference</div>
            <div class="cli-tools-card__hint">Complete command documentation for the DR CLI</div>
          </div>
          <button class="st-btn st-btn--sm" id="cli-ref-open-btn">${ICON.externalLink} Open reference</button>
        </div>
      </div>
      <div class="settings-card cli-tools-card">
        <div class="cli-tools-card__head">
          <div>
            <div class="cli-tools-card__title">Install Guide</div>
            <div class="cli-tools-card__hint">Manual installation and platform-specific instructions</div>
          </div>
          <button class="st-btn st-btn--sm" id="cli-install-guide-btn">${ICON.externalLink} Open guide</button>
        </div>
      </div>
    </div>`;

  wireCliTools(main);

  // Skip version check while installing — dr --version will fail with the package locked
  if (!installing && drFound) {
    fetch("/api/cli/version", { headers }).then(r => r.json()).then(data => {
      if (data.installing) return; // server-side install in progress
      const el = document.getElementById("cli-version-info");
      if (el && data.installed) el.textContent = "Installed: " + data.version;
      else if (el) { el.textContent = "Not installed"; el.style.color = "var(--st-state-failed-fg)"; }
    }).catch(() => {});
  }
}

function wireCliTools(main) {
  main.querySelector(".crumb-home")?.addEventListener("click", (e) => {
    e.preventDefault();
    viewMode = "all";
    render();
  });

  main.querySelector("#cli-install-guide-btn")?.addEventListener("click", () => {
    window.open("https://staticb73dae2b.blob.core.windows.net/static/cli/install.html", "_blank");
  });

  main.querySelector("#cli-ref-open-btn")?.addEventListener("click", () => {
    window.open("https://staticb73dae2b.blob.core.windows.net/static/cli/reference.html", "_blank");
  });

  main.querySelector("#cli-install-btn")?.addEventListener("click", () => {
    const installBtn = document.getElementById("cli-install-btn");
    const outputEl = document.getElementById("cli-install-output");
    if (!installBtn || !outputEl) return;

    installBtn.disabled = true;
    installBtn.textContent = "Installing…";
    outputEl.style.display = "block";
    outputEl.textContent = "";
    cliInstallOutput = "";

    if (cliInstallES) { try { cliInstallES.close(); } catch {} }
    let cliInstallDone = false;
    const es = new EventSource(`/api/cli/install?token=${encodeURIComponent(API_TOKEN)}`);
    cliInstallES = es;
    es.onmessage = (e) => {
      const out = document.getElementById("cli-install-output");
      const btn = document.getElementById("cli-install-btn");
      const ver = document.getElementById("cli-version-info");
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "stdout" || msg.type === "stderr") {
        cliInstallOutput += msg.data;
        if (out) { out.textContent = cliInstallOutput; out.scrollTop = out.scrollHeight; }
      } else if (msg.type === "done") {
        cliInstallDone = true;
        cliInstallOutput += "\n✓ " + msg.data;
        if (out) out.textContent = cliInstallOutput;
        if (btn) { btn.innerHTML = ICON.refresh + " Update DR CLI"; btn.disabled = false; }
        es.close();
        if (cliInstallES === es) cliInstallES = null;
        showToast("DR CLI installed/updated successfully.");
        fetch("/api/cli/version", { headers }).then(r => r.json()).then(d => {
          if (ver && d.installed) ver.textContent = "Installed: " + d.version;
        }).catch(() => {});
        recheckHealth();
      } else if (msg.type === "error") {
        cliInstallDone = true;
        cliInstallOutput += "\n✗ " + msg.data;
        if (out) out.textContent = cliInstallOutput;
        if (btn) { btn.textContent = "Retry"; btn.disabled = false; }
        es.close();
        if (cliInstallES === es) cliInstallES = null;
        showToast("DR CLI install failed.", "error");
        recheckHealth().then(() => {
          const verEl = document.getElementById("cli-version-info");
          if (verEl && healthChecks?.dr?.found) {
            fetch("/api/cli/version", { headers }).then(r => r.json()).then(d => {
              if (d.installed) verEl.textContent = "Installed: " + d.version;
              else { verEl.textContent = "Not installed"; verEl.style.color = "var(--st-state-failed-fg)"; }
            }).catch(() => {});
          } else if (verEl) {
            verEl.textContent = "Not installed";
            verEl.style.color = "var(--st-state-failed-fg)";
          }
        });
      }
    };
    es.onerror = () => {
      if (cliInstallDone) return;
      setTimeout(() => {
        if (cliInstallDone) return;
        cliInstallDone = true;
        cliInstallOutput += "\nConnection to server lost. Check if the server is still running.";
        const out = document.getElementById("cli-install-output");
        const btn = document.getElementById("cli-install-btn");
        if (out) out.textContent = cliInstallOutput;
        if (btn) { btn.textContent = "Retry"; btn.disabled = false; }
        try { es.close(); } catch {}
        if (cliInstallES === es) cliInstallES = null;
      }, 500);
    };
  });
}

function wireCliReference(main) {
  main.querySelector(".crumb-home")?.addEventListener("click", (e) => {
    e.preventDefault();
    viewMode = "all";
    render();
  });
}

function runCliInstall(statusEl, btn) {
  btn.disabled = true;
  btn.textContent = "Installing…";
  statusEl.textContent = "Starting…";
  statusEl.style.color = "var(--st-ink-muted)";
  const es = new EventSource(`/api/cli/install?token=${encodeURIComponent(API_TOKEN)}`);
  let output = "";
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "stdout" || msg.type === "stderr") {
      output += msg.data;
      statusEl.textContent = msg.data.trim().split("\n").pop();
    } else if (msg.type === "done") {
      statusEl.textContent = "Installed";
      statusEl.style.color = "var(--st-state-active-fg)";
      btn.textContent = "Update DR CLI";
      btn.disabled = false;
      es.close();
      showToast("DR CLI installed/updated successfully.");
      recheckHealth().then(() => render());
    } else if (msg.type === "error") {
      statusEl.textContent = "Failed";
      statusEl.style.color = "var(--st-state-failed-fg)";
      btn.textContent = "Retry";
      btn.disabled = false;
      es.close();
      showToast("DR CLI install failed: " + msg.data, "error");
    }
  };
  es.onerror = () => {
    statusEl.textContent = "Connection lost";
    statusEl.style.color = "var(--st-state-failed-fg)";
    btn.textContent = "Retry";
    btn.disabled = false;
    es.close();
  };
}

function buildSettingsHealthRows() {
  if (!healthChecks) return `<div class="settings-row"><div class="settings-row__main" style="font-size:12px;color:var(--st-ink-muted)">Health data not available. Click "Run health check" to refresh.</div></div>`;
  const drFound = healthChecks.dr?.found;
  const rows = [
    { label: "Datarails CLI (dr)", ok: drFound, action: `<button class="st-btn st-btn--sm" id="settings-cli-install">${drFound ? "Update" : "Install"}</button>` },
    { label: "Google Chrome", ok: healthChecks.chrome?.found },
    { label: "Windows Terminal", ok: healthChecks.windowsTerminal?.found },
    { label: "Claude CLI", ok: healthChecks.claude?.found },
    { label: "Workspace", ok: healthChecks.workspaceRoot?.writable },
    { label: "Virtual Desktops", ok: healthChecks.virtualDesktop?.available },
  ];
  return rows.map((r) => `
    <div class="health-row">
      <span class="health-dot ${r.ok ? "health-dot--pass" : "health-dot--fail"}"></span>
      <span class="health-row__label">${esc(r.label)}</span>
      <span class="health-row__status" ${r.action ? 'id="cli-install-status"' : ""}>${r.ok ? "OK" : "Not found"}</span>
      ${r.action || ""}
    </div>`).join("");
}

function showSettingsModal() {
  const vdOn = userSettings.useVirtualDesktops;
  const vdDisabled = vdAvailable === false;
  const currentTheme = document.documentElement.getAttribute("data-theme") || "warm";
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:520px">
      <div class="modal__head">
        <div>
          <h2>Settings</h2>
          <p>Preferences sync across your devices.</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__body">
        <div class="settings-group">
          <div>
            <div class="settings-group__title">Appearance</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__label">Theme</div>
                  <div class="settings-row__hint">Choose your preferred palette</div>
                </div>
                <div class="palette-picker">
                  ${["warm", "zinc", "dark", "cream"].map((t) => `
                    <button class="palette-swatch${t === currentTheme ? " is-active" : ""}" data-palette="${t}" title="${t}">
                      <span class="palette-swatch__stripe" style="background:${t === "warm" ? "#FAFAF9" : t === "zinc" ? "#F8FAFC" : t === "dark" ? "#16181D" : "#F4EEE0"}"></span>
                      <span class="palette-swatch__stripe" style="background:${t === "warm" ? "#0A0A0B" : t === "zinc" ? "#0F172A" : t === "dark" ? "#ECEEF4" : "#1A1714"}"></span>
                      <span class="palette-swatch__stripe" style="background:#4646CE"></span>
                    </button>
                  `).join("")}
                </div>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">Launch behavior</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__label">Virtual desktops <span class="beta-badge">Beta</span></div>
                  <div class="settings-row__hint">${vdDisabled
                    ? `Virtual desktop support is not available on this system.`
                    : `Each launch creates a separate Windows virtual desktop. Existing desktops are reused.`
                  }</div>
                </div>
                <button class="toggle ${vdOn ? "is-on" : ""} ${vdDisabled ? "is-disabled" : ""}" id="set-vd" ${vdDisabled ? "disabled" : ""}></button>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">System health</div>
            <div class="settings-card" id="settings-health-card">
              ${buildSettingsHealthRows()}
              <div style="padding:8px 16px 12px;text-align:right">
                <button class="st-btn st-btn--sm" id="settings-health-recheck">${ICON.refresh} Run health check</button>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">Cloud sync</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__hint" id="sync-status-text">${
                    syncStatus.lastSyncedAt
                      ? `Last synced: ${new Date(syncStatus.lastSyncedAt).toLocaleString()}${syncStatus.dirty ? " (local changes pending)" : ""}`
                      : "Not yet synced"
                  }${syncStatus.error ? ` — Error: ${esc(syncStatus.error)}` : ""}</div>
                </div>
                <button class="st-btn st-btn--sm" id="settings-sync-btn">${ICON.refresh} Sync now</button>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">Storage</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__label">Cleanup unused data</div>
                  <div class="settings-row__hint">Scan for orphaned Chrome profiles and workspaces from old launches</div>
                </div>
                <button class="st-btn st-btn--sm" id="settings-cleanup-scan">Scan</button>
              </div>
              <div id="cleanup-results" style="display:none"></div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">About</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main" style="font-size:12px;color:var(--st-ink-muted);line-height:1.6">
                  <div>DR Launcher — local-first customer launcher</div>
                  <div>API token: <code style="font-family:'JetBrains Mono',monospace;color:var(--st-ink)">${esc(String(API_TOKEN).slice(0, 6))}…${esc(String(API_TOKEN).slice(-4))}</code></div>
                </div>
                <button class="st-btn st-btn--sm" id="settings-copy-diag">Copy diagnostics</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="modal__foot">
        <span></span>
        <button class="st-btn st-btn--primary" data-modal-close>Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Palette switching
  overlay.querySelectorAll("[data-palette]").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".palette-swatch").forEach((s) => s.classList.remove("is-active"));
      btn.classList.add("is-active");
      applyTheme(btn.dataset.palette);
      saveSettingsQuiet({ theme: btn.dataset.palette });
    });
  });

  const tog = overlay.querySelector("#set-vd");
  if (tog && !vdDisabled) {
    tog.addEventListener("click", () => {
      const on = !tog.classList.contains("is-on");
      tog.classList.toggle("is-on", on);
      saveSettings({ useVirtualDesktops: on });
      showToast(on ? "Virtual desktops enabled." : "Virtual desktops disabled.");
    });
  }
  const syncBtn = overlay.querySelector("#settings-sync-btn");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = "Syncing…";
      await triggerSync();
      await fetchSyncStatus();
      const statusEl = overlay.querySelector("#sync-status-text");
      if (statusEl) {
        statusEl.textContent = syncStatus.lastSyncedAt
          ? `Last synced: ${new Date(syncStatus.lastSyncedAt).toLocaleString()}${syncStatus.dirty ? " (local changes pending)" : ""}`
          : "Not yet synced";
      }
      syncBtn.disabled = false;
      syncBtn.innerHTML = `${ICON.refresh} Sync now`;
    });
  }
  const diagBtn = overlay.querySelector("#settings-copy-diag");
  if (diagBtn) {
    diagBtn.addEventListener("click", async () => {
      diagBtn.disabled = true;
      diagBtn.textContent = "Copying…";
      try {
        const res = await fetch("/api/diagnostics", { headers });
        const data = await res.json();
        await navigator.clipboard.writeText(data.text || "No diagnostics available");
        showToast("Diagnostics copied to clipboard.");
      } catch (err) {
        showToast("Failed to copy diagnostics: " + err.message, "error");
      }
      diagBtn.disabled = false;
      diagBtn.textContent = "Copy diagnostics";
    });
  }
  overlay.addEventListener("click", async (e) => {
    const recheckBtn = e.target.closest("#settings-health-recheck");
    if (recheckBtn) {
      recheckBtn.disabled = true;
      recheckBtn.textContent = "Checking…";
      await recheckHealth();
      const card = overlay.querySelector("#settings-health-card");
      if (card) {
        card.innerHTML = buildSettingsHealthRows()
          + `<div style="padding:8px 16px 12px;text-align:right"><button class="st-btn st-btn--sm" id="settings-health-recheck">${ICON.refresh} Run health check</button></div>`;
      }
      showToast("Health check complete.");
      return;
    }
    const installBtn = e.target.closest("#settings-cli-install");
    if (installBtn) {
      const statusEl = overlay.querySelector("#cli-install-status");
      if (statusEl) runCliInstall(statusEl, installBtn);
    }
  });
  const cleanupBtn = overlay.querySelector("#settings-cleanup-scan");
  if (cleanupBtn) {
    cleanupBtn.addEventListener("click", async () => {
      cleanupBtn.disabled = true;
      cleanupBtn.textContent = "Scanning…";
      try {
        const res = await fetch("/api/cleanup/scan", { headers });
        const data = await res.json();
        const resultsDiv = overlay.querySelector("#cleanup-results");
        if (!resultsDiv) return;
        const totalProfiles = data.profiles?.length || 0;
        const totalWorkspaces = data.workspaces?.length || 0;
        if (totalProfiles === 0 && totalWorkspaces === 0) {
          resultsDiv.style.display = "block";
          resultsDiv.innerHTML = `<div style="padding:12px 16px;color:var(--st-ink-muted);font-size:13px">No orphaned data found.</div>`;
          return;
        }
        let html = `<div style="padding:12px 16px;font-size:13px">`;
        if (totalProfiles > 0) {
          const totalSize = data.profiles.reduce((sum, p) => sum + p.sizeMB, 0).toFixed(1);
          html += `<div style="margin-bottom:8px"><strong>${totalProfiles} orphaned Chrome profile${totalProfiles > 1 ? "s" : ""}</strong> (${totalSize} MB)</div>`;
          html += `<div style="margin-bottom:8px">`;
          data.profiles.forEach((p) => {
            html += `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px;color:var(--st-ink-muted)">
              <input type="checkbox" class="cleanup-profile-cb" data-path="${esc(p.path)}" checked>
              ${esc(p.slug)} (${p.sizeMB} MB)${p.lastUsed ? ` — last used ${new Date(p.lastUsed).toLocaleDateString()}` : ""}
            </label>`;
          });
          html += `</div><button class="st-btn st-btn--sm st-btn--destructive" id="cleanup-purge-profiles">Delete selected profiles</button>`;
        }
        if (totalWorkspaces > 0) {
          const totalSize = data.workspaces.reduce((sum, w) => sum + w.sizeMB, 0).toFixed(1);
          html += `<div style="margin-top:12px;margin-bottom:8px"><strong>${totalWorkspaces} orphaned workspace${totalWorkspaces > 1 ? "s" : ""}</strong> (${totalSize} MB)</div>`;
          html += `<div style="margin-bottom:8px">`;
          data.workspaces.forEach((w) => {
            html += `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px;color:var(--st-ink-muted)">
              <input type="checkbox" class="cleanup-ws-cb" data-path="${esc(w.path)}" checked>
              ${esc(w.slug)} (${w.sizeMB} MB)${w.hasUserContent ? ` <span class="st-badge st-badge--stale">modified</span>` : ""}
            </label>`;
          });
          html += `</div><button class="st-btn st-btn--sm st-btn--stale" id="cleanup-quarantine-ws">Move selected to quarantine</button>`;
        }
        html += `</div>`;
        resultsDiv.style.display = "block";
        resultsDiv.innerHTML = html;
        const purgeBtn = resultsDiv.querySelector("#cleanup-purge-profiles");
        if (purgeBtn) {
          purgeBtn.addEventListener("click", async () => {
            const checked = [...resultsDiv.querySelectorAll(".cleanup-profile-cb:checked")].map((cb) => cb.dataset.path);
            if (checked.length === 0) return showToast("No profiles selected.", "warn");
            purgeBtn.disabled = true;
            purgeBtn.textContent = "Deleting…";
            try {
              const r = await fetch("/api/cleanup/purge", { method: "POST", headers, body: JSON.stringify({ profiles: checked }) });
              const d = await r.json();
              showToast(`Deleted ${d.profiles?.deleted?.length || 0} profile(s).`);
              cleanupBtn.click();
            } catch (err) {
              showToast("Purge failed: " + err.message, "error");
            }
          });
        }
        const quarantineBtn = resultsDiv.querySelector("#cleanup-quarantine-ws");
        if (quarantineBtn) {
          quarantineBtn.addEventListener("click", async () => {
            const checked = [...resultsDiv.querySelectorAll(".cleanup-ws-cb:checked")].map((cb) => cb.dataset.path);
            if (checked.length === 0) return showToast("No workspaces selected.", "warn");
            quarantineBtn.disabled = true;
            quarantineBtn.textContent = "Moving…";
            try {
              const r = await fetch("/api/cleanup/purge", { method: "POST", headers, body: JSON.stringify({ workspaces: checked }) });
              const d = await r.json();
              showToast(`Quarantined ${d.workspaces?.quarantined?.length || 0} workspace(s).`);
              cleanupBtn.click();
            } catch (err) {
              showToast("Quarantine failed: " + err.message, "error");
            }
          });
        }
      } catch (err) {
        showToast("Scan failed: " + err.message, "error");
      }
      cleanupBtn.disabled = false;
      cleanupBtn.textContent = "Scan";
    });
  }
  wireModalClose(overlay);
}

function showAgentPickerDropdown(anchorEl, accountsList, evt) {
  if (!agentCatalog.length) return;
  if (agentCatalog.length === 1) {
    showAgentLaunchModal(accountsList, agentCatalog[0].id);
    return;
  }
  const items = agentCatalog.map((a) => ({
    label: a.name,
    action() { showAgentLaunchModal(accountsList, a.id); },
  }));
  showDropdown(anchorEl, items, evt);
}

function showAgentLaunchModal(accountsList, agentId) {
  if (!agentCatalog.length) return;
  const selectedAgentId = agentId || agentCatalog[0].id;
  const agent = agentCatalog.find((a) => a.id === selectedAgentId) || agentCatalog[0];
  const isBatch = accountsList.length > 1;

  function renderInputs(ag) {
    return (ag.inputs || []).map((inp) => {
      if (inp.type === "select") {
        const opts = (inp.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
        return `<div class="agent-form__group">
          <label class="agent-form__label">${esc(inp.label)}${inp.required ? " *" : ""}</label>
          <select class="agent-form__select" data-agent-input="${esc(inp.key)}">${opts}</select>
        </div>`;
      }
      if (inp.type === "textarea") {
        return `<div class="agent-form__group">
          <label class="agent-form__label">${esc(inp.label)}${inp.required ? " *" : ""}</label>
          <textarea class="agent-form__textarea" data-agent-input="${esc(inp.key)}" placeholder="${esc(inp.placeholder || "")}"></textarea>
        </div>`;
      }
      return `<div class="agent-form__group">
        <label class="agent-form__label">${esc(inp.label)}${inp.required ? " *" : ""}</label>
        <input type="text" class="agent-form__input" data-agent-input="${esc(inp.key)}" placeholder="${esc(inp.placeholder || "")}" />
      </div>`;
    }).join("");
  }

  const targetLabel = isBatch
    ? `${accountsList.length} customers`
    : esc(accountsList[0].orgDomain);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__head">
        <div>
          <h2>${ICON.zap} ${esc(agent.name)}</h2>
          <p>${esc(agent.description)} · ${targetLabel}</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__body">
        <div class="agent-form">
          <div id="agent-inputs">${renderInputs(agent)}</div>
        </div>
      </div>
      <div class="modal__foot">
        <span class="agent-form__footer-hint">${isBatch ? "Agent will be scaffolded in each customer workspace" : ""}</span>
        <button class="st-btn st-btn--primary" id="agent-launch-btn">${ICON.rocket} ${isBatch ? "Launch All" : "Launch"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector("#agent-launch-btn").addEventListener("click", async () => {
    const agentInputs = {};
    overlay.querySelectorAll("[data-agent-input]").forEach((el) => {
      agentInputs[el.dataset.agentInput] = el.value;
    });

    const missing = (agent.inputs || []).filter((inp) => inp.required && !agentInputs[inp.key]?.trim());
    if (missing.length) {
      showToast(`Missing required fields: ${missing.map((m) => m.label).join(", ")}`, "warn");
      return;
    }

    closeModal();

    if (isBatch) {
      await launchBatchQueue({ agentId: selectedAgentId, agentInputs });
    } else {
      await launchCustomer(accountsList[0], { agentId: selectedAgentId, agentInputs });
    }
  });

  wireModalClose(overlay);
}

function wireModalClose(overlay) {
  overlay.querySelector(".modal__close")?.addEventListener("click", closeModal);
  overlay.querySelectorAll("[data-modal-close]").forEach((b) => b.addEventListener("click", closeModal));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", onKey);
    }
  });
}

// ── Keyboard shortcuts ───────────────────────────────────────────
function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const isInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key === "k") {
      e.preventDefault();
      const input = document.querySelector(".topbar__search input");
      if (input) input.focus();
      return;
    }

    if (e.key === "Escape") {
      if (isInput && searchQuery) {
        searchQuery = "";
        e.target.value = "";
        render();
        return;
      }
      if (selectedIds.size > 0) {
        clearSelection();
        return;
      }
      return;
    }

    if (isInput) return;

    if (mod && e.key === "a") {
      e.preventDefault();
      const filtered = filterAccounts(accounts);
      toggleSelectAll(filtered);
      return;
    }

    if (e.key === "Enter" && selectedIds.size > 0 && !launchInProgress) {
      e.preventDefault();
      launchBatchQueue();
      return;
    }
  });
}

function applyTheme(theme) {
  const valid = ["warm", "zinc", "dark", "cream"];
  if (!valid.includes(theme)) theme = "warm";
  document.documentElement.setAttribute("data-theme", theme);
}

// ── Init ──────────────────────────────────────────────────────────
// Guard so this file can be `require`d headless (tests import esc/serverList).
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("login-btn")?.addEventListener("click", triggerLogin);
  document.getElementById("dev-login-btn")?.addEventListener("click", triggerDevLogin);
  document.getElementById("dev-password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") triggerDevLogin();
  });

  await fetchAuthStatus();

  if (authState.authenticated) {
    const loginEl = document.getElementById("login-screen");
    const appEl = document.getElementById("app-shell");
    if (loginEl) loginEl.style.display = "none";
    if (appEl) appEl.style.display = "";
    try {
      const syncRes = await fetch("/api/sync/init", { method: "POST", headers });
      const syncData = await syncRes.json();
      if (syncData.ok && syncData.preferences) {
        applyTheme(syncData.preferences.theme || "warm");
      }
      await fetchSyncStatus();
    } catch { /* sync is best-effort */ }
    await initApp();
  }
});

async function initApp() {
  renderTopbar();
  initKeyboardShortcuts();

  await Promise.all([fetchServers(), fetchSettings(), fetchHealth(), fetchRecents(), fetchSessions(), fetchAgents()]);

  favoriteIds = new Set(userSettings.favoriteIds || []);
  collapsedServers = new Set(userSettings.collapsedServers || []);
  applyTheme(userSettings.theme || "warm");

  await fetchAccounts();

  // Seed expired tracking from initial fetch (no toast on startup)
  _prevExpiredIds = new Set(
    accounts.filter((a) => { const s = rowState(a); return s === "reauth" || s === "active-reauth"; }).map((a) => a.id)
  );

  setInterval(async () => {
    await checkSessionHealth();
    await fetchAccounts();

    const currentExpired = new Set(
      accounts.filter((a) => { const s = rowState(a); return s === "reauth" || s === "active-reauth"; }).map((a) => a.id)
    );
    if (_prevExpiredIds) {
      const newlyExpired = [...currentExpired].filter((id) => !_prevExpiredIds.has(id));
      if (newlyExpired.length > 0) {
        const domains = newlyExpired.map((id) => accounts.find((a) => a.id === id)?.orgDomain).filter(Boolean);
        if (domains.length === 1) {
          showToast(`Auth expired for ${domains[0]}. Re-authenticate to continue.`, "warn");
        } else if (domains.length > 1) {
          showToast(`Auth expired for ${domains.length} accounts. Re-authenticate to continue.`, "warn");
        }
      }
    }
    _prevExpiredIds = currentExpired;
  }, 30000);

  const validIds = new Set(accounts.map((a) => a.id));
  for (const id of [...selectedIds]) { if (!validIds.has(id)) selectedIds.delete(id); }
  batchOrder = batchOrder.filter((id) => validIds.has(id));
}

// Headless export for tests (no-op in the browser). Exposes the pure helpers
// and the fallback server list so tests can verify esc() and host parity.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { esc, serverInfo, serverList };
}
