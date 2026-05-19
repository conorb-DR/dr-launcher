// ───────────────────────────────────────────────────────────────
// DR Launcher · app.js (B3 / Datarails design-system aligned)
//
// API logic from the original app.js is preserved verbatim. The only
// substantive change is the markup output by render() and the new
// helpers (renderSidebar, serverInfo, accountAvatar, etc).
// ───────────────────────────────────────────────────────────────

const API_TOKEN = window.__DR_TOKEN__;

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
let activeLaunch = null;   // { orgDomain, serverKey, step, totalSteps, label } when running
let recentLaunches = [];   // persisted via /api/recents
let filterServer = null;   // "US" | "US2" | "UK" | "CA" | null (= all)
let selectedIds = new Set();
let batchOrder = [];       // ordered IDs for batch launch, synced with selectedIds
let batchQueue = null;     // { ids: [], current: 0 } when a batch launch is running
let searchQuery = "";      // live search filter
let launchSSE = null;      // EventSource for live progress
let viewMode = "all";      // "all" | "recent" | "favorites"
let favoriteIds = new Set();
let collapsedServers = new Set();
let syncStatus = { lastSyncedAt: null, dirty: false, cloudAvailable: false, error: null };
let dragIdx = null;        // index being dragged in batch list
let activeSessions = [];   // active session objects from server
let healthChecks = null;   // full checks object from /api/health
let prereqWarningDismissed = false; // session-only dismissal of warning banner
let batchCloseInProgress = false;  // true during batch close operation
let batchCloseProgress = null;     // { total, current } when running
let authState = { configured: false, authenticated: false, user: null };

// ── Server metadata ──────────────────────────────────────────────
const SERVERS = [
  { key: "US",  label: "app.datarails.com",      color: "#4646CE", soft: "#DFD9FF", text: "#25258C" },
  { key: "US2", label: "us-2.datarails.com",     color: "#7B61FF", soft: "#F0EEFF", text: "#5D45D6" },
  { key: "UK",  label: "ukapp.datarails.com",    color: "#03A678", soft: "#ECFAE4", text: "#037C5A" },
  { key: "CA",  label: "caapp.datarails.com",    color: "#FFA310", soft: "#FFF4D4", text: "#9E5F00" },
];
const SERVER_REGION = {
  US:  "United States",
  US2: "United States (instance 2)",
  UK:  "United Kingdom",
  CA:  "Canada",
};
function serverInfo(key) {
  return SERVERS.find((s) => s.key === key) || { key, label: "", color: "#9EA1AA", soft: "#F0F1F4", text: "#4E566C" };
}

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
      applyTheme(data.preferences.theme || "light");
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
      if (data.preferences) applyTheme(data.preferences.theme || "light");
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
  const avatarEl = document.getElementById("user-avatar");
  const nameEl = document.getElementById("user-name");
  const topbarAvatar = document.getElementById("topbar-avatar");
  if (authState.authenticated && authState.user) {
    const u = authState.user;
    if (avatarEl) avatarEl.textContent = u.initials;
    if (nameEl) nameEl.textContent = u.name;
    if (topbarAvatar) topbarAvatar.textContent = u.initials;
  } else {
    if (avatarEl) avatarEl.textContent = "?";
    if (nameEl) nameEl.textContent = "Sign in";
    if (topbarAvatar) topbarAvatar.textContent = "?";
  }

  // Toggle login panels based on whether Azure AD is configured
  const msPanel = document.getElementById("login-microsoft");
  const devPanel = document.getElementById("login-dev");
  if (msPanel) msPanel.style.display = authState.configured ? "" : "none";
  if (devPanel) devPanel.style.display = authState.configured ? "none" : "";
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

// ── API calls (unchanged behaviour from original) ────────────────
async function fetchAccounts() {
  loading = true;
  render();
  try {
    const res = await fetch("/api/accounts", { headers });
    const data = await res.json();
    accounts = data.accounts || [];
  } catch (err) {
    showToast("Failed to load accounts: " + err.message, "error");
    accounts = [];
  }
  loading = false;
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
    activeSessions = (data.sessions || []).filter((s) => s.status === "active");
  } catch {
    activeSessions = [];
  }
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
    if (data.ok) {
      showToast(`Session closed for ${orgDomain}.`);
    } else {
      showToast(`Failed to close session: ${data.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    showToast("Failed to close session: " + err.message, "error");
  }
  await fetchSessions();
  render();
}

function showCloseConfirmation(sessionId, orgDomain) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:440px">
      <div class="modal__head">
        <div>
          <h2>Close session?</h2>
          <p>This will close Chrome, the terminal, and remove the virtual desktop for <strong>${esc(orgDomain)}</strong>.</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-modal-close>Cancel</button>
        <button class="btn btn--danger" id="confirm-close-session">Close session</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#confirm-close-session").addEventListener("click", () => {
    closeModal();
    closeSessionRequest(sessionId, orgDomain);
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
    return `<div class="batch-close-item">
      <span class="server-pill server-pill--${esc(si.key)}" style="background:${si.soft};color:${si.text}">
        <span class="server-pill__dot" style="background:${si.color}"></span>${esc(si.key)}
      </span>
      <span>${esc(s.orgDomain)}</span>
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
      <div class="modal__body" style="max-height:300px; overflow-y:auto; padding:0 24px">
        <div class="batch-close-list">${listHtml}</div>
      </div>
      <div class="modal__foot">
        <button class="btn btn--ghost" data-modal-close>Cancel</button>
        <button class="btn btn--danger" id="confirm-batch-close">Close ${sessionsToClose.length} session${sessionsToClose.length === 1 ? "" : "s"}</button>
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
    if (!quiet) showToast(`Session already active for ${account.orgDomain} — close it first.`, "warn");
    return { ok: false, account, error: "active_session_exists" };
  }
  if (launchInProgress) {
    if (!quiet) showToast("A launch is already in progress. Please wait.", "warn");
    return { ok: false, account, error: "launch_in_progress" };
  }
  launchInProgress = true;
  activeLaunch = { orgDomain: account.orgDomain, serverKey: account.serverKey, step: 1, totalSteps: 5, label: "Starting" };
  connectLaunchSSE();
  render();

  try {
    const payload = { ...account };
    if (opts.noSwitch) payload.noSwitch = true;
    const res = await fetch("/api/launch", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 409) {
      const errData = await res.json().catch(() => ({}));
      if (errData.error === "active_session_exists") {
        if (!quiet) showToast(errData.message || `Active session exists for ${account.orgDomain}.`, "warn");
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
    await fetchSessions();
    return { ok: true, account, desktopName };
  } catch (err) {
    showToast("Launch failed: " + err.message, "error");
    return { ok: false, account, error: err.message };
  } finally {
    launchInProgress = false;
    activeLaunch = null;
    disconnectLaunchSSE();
    render();
  }
}

async function launchBatchQueue() {
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
    const result = await launchCustomer(acct, { quiet: true, noSwitch: isBatch });
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
  const total = ids.length;
  if (succeeded === total) {
    showToast(`Batch complete — ${total} customer${total === 1 ? "" : "s"} launched.`, null, { persistent: true });
  } else {
    showToast(`Batch done — ${succeeded} of ${total} launched (${total - succeeded} failed).`, "warn", { persistent: true });
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
  render();
}

function clearSelection() {
  selectedIds.clear();
  batchOrder = [];
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

async function startLogin(serverKey) {
  closeModal();
  showToast(`Starting authentication for ${serverKey}… Complete login in the browser window.`);
  try {
    await fetch("/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ server: serverKey }),
    });
    let polls = 0;
    const maxPolls = 40;
    const prevCount = accounts.length;
    const interval = setInterval(async () => {
      polls++;
      try {
        const res = await fetch("/api/accounts", { headers });
        const data = await res.json();
        const newAccounts = data.accounts || [];
        if (newAccounts.length > prevCount) {
          clearInterval(interval);
          accounts = newAccounts;
          render();
          showToast("New customer account detected.");
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
function esc(str) {
  const el = document.createElement("span");
  el.textContent = str == null ? "" : String(str);
  return el.innerHTML;
}

function initialsOf(account) {
  // "acme-corp.com" → "AC". Falls back to first 2 alpha chars of email.
  const dom = (account.orgDomain || "").replace(/\.[a-z]+$/i, "");
  const parts = dom.split(/[-.]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts[0]?.length >= 2) return parts[0].slice(0, 2).toUpperCase();
  const e = (account.email || "??").replace(/[^a-z]/gi, "");
  return e.slice(0, 2).toUpperCase() || "??";
}

function avatarColor(account) {
  // Hash orgDomain into one of the brand chart colors so each customer
  // gets a stable colour without storing it.
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

function avatarHTML(account) {
  const c = avatarColor(account);
  return `<span class="avatar" style="background:linear-gradient(135deg,${c} 0%,${shadeHex(c, -18)} 100%)">${esc(initialsOf(account))}</span>`;
}

function serverPillHTML(serverKey) {
  const s = serverInfo(serverKey);
  return `<span class="server-pill server-pill--${esc(s.key)}" style="background:${s.soft};color:${s.text}">
    <span class="server-pill__dot" style="background:${s.color}"></span>${esc(s.key)}
  </span>`;
}

function cliStatusHTML(status) {
  const active = status === "active";
  return `<span class="cli-status ${active ? "is-active" : "is-expired"}">
    <span class="cli-status__dot"></span>${active ? "Authenticated" : "Token expired"}
  </span>`;
}

// Inline SVG icons. Kept here (vs <img>) so they can be tinted by currentColor.
const ICON = {
  rocket: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.3-.05-3.05a2.07 2.07 0 0 0-2.95.05Z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
  shield: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>`,
  copy:   `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  more:   `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`,
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
};

// ── Sidebar rendering ─────────────────────────────────────────────
function renderSidebar() {
  const el = document.getElementById("sidebar");
  if (!el) return;

  const total = accounts.length;
  const recent = recentLaunches.length;
  const favCount = favoriteIds.size;
  const favCustomers = accounts.filter((a) => favoriteIds.has(a.id));

  const linkHTML = (k, icon, label, count, opts = {}) => {
    const active = (k === "all" && filterServer === null) || (k === ("srv-" + filterServer));
    const isActive = opts.active != null ? opts.active : active;
    const warn = opts.warn ? " sidebar__count--warn" : "";
    return `
      <button class="sidebar__link${isActive ? " is-active" : ""}" data-filter="${esc(opts.filter ?? "")}">
        ${icon}
        <span class="sidebar__link-text">${label}</span>
        ${count != null ? `<span class="sidebar__count${warn}">${count}</span>` : ""}
      </button>`;
  };

  el.innerHTML = `
    <div class="sidebar__section">
      <div class="sidebar__label">Workspaces</div>
      <div class="sidebar__items">
        ${linkHTML("all", ICON.user, "All customers", total, { active: viewMode === "all" && filterServer === null, filter: "" })}
        <button class="sidebar__link${viewMode === "recent" ? " is-active" : ""}" data-view="recent">
          ${ICON.clock}
          <span class="sidebar__link-text">Recently launched</span>
          ${recent ? `<span class="sidebar__count">${recent}</span>` : ""}
        </button>
        <button class="sidebar__link${viewMode === "favorites" ? " is-active" : ""}" data-view="favorites">
          ${ICON.star}
          <span class="sidebar__link-text">Favorites</span>
          ${favCount ? `<span class="sidebar__count">${favCount}</span>` : ""}
        </button>
        <button class="sidebar__link${viewMode === "sessions" ? " is-active" : ""}" data-view="sessions">
          ${ICON.zap}
          <span class="sidebar__link-text">Active sessions</span>
          ${activeSessions.length ? `<span class="sidebar__count sidebar__count--active">${activeSessions.length}</span>` : ""}
        </button>
      </div>
    </div>

    <div class="sidebar__section">
      <div class="sidebar__label">Servers</div>
      <div class="sidebar__items">
        ${SERVERS.map((s) => {
          const n = accounts.filter((a) => a.serverKey === s.key).length;
          const dot = `<span class="server-pill__dot" style="background:${s.color}"></span>`;
          const active = filterServer === s.key;
          return `
            <button class="sidebar__link${active ? " is-active" : ""}" data-filter="${esc(s.key)}">
              ${dot}
              <span class="sidebar__link-text">
                <span style="font-weight:500">${esc(s.key)}</span>
                <span class="sidebar__link-host">${esc(s.label)}</span>
              </span>
              <span class="sidebar__count">${n}</span>
            </button>`;
        }).join("")}
      </div>
    </div>

    ${favCustomers.length ? `
      <div class="sidebar__section">
        <div class="sidebar__label">Favorites</div>
        <div class="sidebar__items">
          ${favCustomers.map((a) => `
            <button class="sidebar__link" data-pinned="${esc(a.id)}">
              <span class="avatar avatar--sm" style="background:linear-gradient(135deg,${avatarColor(a)} 0%,${shadeHex(avatarColor(a), -18)} 100%)">${esc(initialsOf(a))}</span>
              <span class="sidebar__link-text" style="font-size:12px">${esc(a.orgDomain)}</span>
            </button>`).join("")}
        </div>
      </div>
    ` : ""}

  `;

  // Wire up server-filter buttons.
  el.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.filter;
      filterServer = v ? v : null;
      viewMode = "all";
      render();
    });
  });
  el.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      viewMode = btn.dataset.view;
      filterServer = null;
      render();
    });
  });
  el.querySelectorAll("[data-pinned]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.pinned;
      const a = accounts.find((x) => x.id === id);
      if (a && !launchInProgress) launchCustomer(a);
    });
  });
}


// ── Main render ───────────────────────────────────────────────────
function render() {
  renderSidebar();
  const main = document.getElementById("main-content");

  if (loading) {
    main.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <div>Discovering authenticated customers…</div>
      </div>`;
    return;
  }

  // Prerequisites gate — show first-run screen if critical items missing
  const prereqs = classifyPrerequisites();
  if (prereqs.checked && prereqs.hasCritical) {
    main.innerHTML = renderFirstRun(prereqs);
    main.querySelector("#prereq-recheck")?.addEventListener("click", async () => {
      await recheckHealth();
      render();
    });
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
  const groups = SERVERS
    .map((s) => ({ s, rows: filtered.filter((a) => a.serverKey === s.key) }))
    .filter((g) => g.rows.length);

  const selCount = selectedIds.size;
  const allChecked = filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id));

  const pageTitle = viewMode === "sessions" ? "Active sessions"
    : viewMode === "recent" ? "Recently launched"
    : viewMode === "favorites" ? "Favorites"
    : filterServer ? esc(filterServer) + " customers"
    : "All customers";

  main.innerHTML = `
    <div class="crumbs">
      <a href="#">Home</a>
      <span class="sep">/</span>
      <a href="#" class="is-current">${pageTitle}</a>
    </div>

    ${warningHtml}

    <div class="page-head">
      <div>
        <h1>${pageTitle}<span class="count">${filtered.length}</span></h1>
        <div class="sub">${viewMode === "sessions" && filtered.length === 0 ? "No active sessions — launch a customer to get started"
          : viewMode === "recent" && filtered.length === 0 ? "Launch a customer to see them here"
          : viewMode === "favorites" && filtered.length === 0 ? "Star a customer to add them to favorites"
          : `${groups.length} server${groups.length === 1 ? "" : "s"} · last refreshed ${new Date().toLocaleTimeString()}`}</div>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--ghost" id="head-refresh">${ICON.refresh} Refresh</button>
        ${activeSessions.length > 0 ? `
          <button class="btn btn--danger" id="close-all-sessions"${batchCloseInProgress ? " disabled" : ""}>${ICON.stop} Close all (${activeSessions.length})</button>
        ` : ""}
        <button class="btn btn--primary" id="head-auth">${ICON.plus} Authenticate customer</button>
      </div>
    </div>

    ${batchCloseInProgress ? renderCloseProgressBanner() : activeLaunch ? renderLaunchBanner() : ""}

    ${selCount > 0 ? (viewMode === "sessions" ? `
      <div class="batch-bar batch-bar--danger">
        <div class="batch-bar__top">
          <span class="batch-bar__count">${selCount} session${selCount === 1 ? "" : "s"} selected</span>
          <div class="batch-bar__actions">
            <button class="batch-bar__clear" id="batch-clear">Clear selection</button>
            <button class="batch-bar__launch batch-bar__launch--danger" id="batch-close"${batchCloseInProgress ? " disabled" : ""}>
              ${ICON.stop} Close selected (${selCount})
            </button>
          </div>
        </div>
      </div>
    ` : `
      <div class="batch-bar">
        <div class="batch-bar__top">
          <span class="batch-bar__count">${selCount} customer${selCount === 1 ? "" : "s"} selected</span>
          <div class="batch-bar__actions">
            <button class="batch-bar__clear" id="batch-clear">Clear selection</button>
            <button class="batch-bar__launch" id="batch-launch"${launchInProgress ? " disabled" : ""}>
              ${ICON.rocket} Launch Queue (${selCount})
            </button>
          </div>
        </div>
        <div class="batch-list" id="batch-list">
          ${batchOrder.map((id, idx) => {
            const ba = accounts.find((x) => x.id === id);
            if (!ba) return "";
            const si = serverInfo(ba.serverKey);
            return `<div class="batch-item" draggable="true" data-batch-idx="${idx}">
              <span class="grip-handle">${ICON.grip}</span>
              <span class="batch-item__num">${idx + 1}</span>
              <span class="avatar avatar--sm" style="background:linear-gradient(135deg,${avatarColor(ba)} 0%,${shadeHex(avatarColor(ba), -18)} 100%)">${esc(initialsOf(ba))}</span>
              <span class="batch-item__domain">${esc(ba.orgDomain)}</span>
              <span class="server-pill server-pill--${esc(si.key)}" style="background:${si.soft};color:${si.text}"><span class="server-pill__dot" style="background:${si.color}"></span>${esc(si.key)}</span>
              <button class="batch-item__remove" data-batch-remove="${esc(id)}" title="Remove">${ICON.x}</button>
            </div>`;
          }).join("")}
        </div>
      </div>
    `) : ""}

    <div class="filters">
      <button class="chip ${filterServer === null ? "is-active" : ""}" data-filter="">
        All <span class="chip__count">${accounts.length}</span>
      </button>
      <button class="chip">${ICON.filter} Filter</button>
      <button class="chip">Sort: Last used ${ICON.chev}</button>
      <span class="grow">${filtered.length} of ${accounts.length}</span>
    </div>

    <div class="panel">
      <div class="tbl__header">
        <div>
          <button class="tbl__check${allChecked ? " is-checked" : ""}" id="check-all" title="Select all">
            <svg viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
          </button>
        </div>
        <div></div>
        <div class="tbl__sortable">Customer ${ICON.chev}</div>
        <div>Account</div>
        <div>Server</div>
        <div class="tbl__sortable">Last used ${ICON.chev}</div>
        <div style="text-align:right">Actions</div>
      </div>
      ${groups.map((g, gi) => renderGroup(g, gi === groups.length - 1)).join("")}
    </div>
  `;

  // Wire up actions.
  main.querySelector("#head-refresh")?.addEventListener("click", fetchAccounts);
  main.querySelector("#head-auth")?.addEventListener("click", showAuthModal);
  main.querySelector("#close-all-sessions")?.addEventListener("click", () => {
    showBatchCloseConfirmation(activeSessions);
  });
  main.querySelector("#batch-close")?.addEventListener("click", () => {
    const selected = activeSessions.filter(s => selectedIds.has(s.accountId));
    if (selected.length > 0) showBatchCloseConfirmation(selected);
  });
  main.querySelectorAll("[data-row-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled || btn.classList.contains("is-disabled")) return;
      const id = btn.dataset.accountId;
      const acct = accounts.find((a) => a.id === id);
      if (!acct) return;
      if (btn.dataset.rowAction === "launch") launchCustomer(acct);
      if (btn.dataset.rowAction === "copy") copyInstruction(acct);
      if (btn.dataset.rowAction === "favorite") toggleFavorite(id);
      if (btn.dataset.rowAction === "close-session") {
        showCloseConfirmation(btn.dataset.sessionId, acct.orgDomain);
      }
    });
  });

  // Collapsible group headers.
  main.querySelectorAll("[data-server-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => toggleCollapse(btn.dataset.serverToggle));
  });

  // Batch selection wiring.
  main.querySelector("#check-all")?.addEventListener("click", () => toggleSelectAll(filtered));
  main.querySelectorAll("[data-check-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggleSelect(btn.dataset.checkId); });
  });
  main.querySelector("#batch-launch")?.addEventListener("click", launchBatchQueue);
  main.querySelector("#batch-clear")?.addEventListener("click", clearSelection);
  wirePrereqBanner(main);

  // Batch remove buttons.
  main.querySelectorAll("[data-batch-remove]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.batchRemove;
      selectedIds.delete(id);
      batchOrder = batchOrder.filter((x) => x !== id);
      render();
    });
  });

  // Batch drag-to-reorder.
  const batchList = main.querySelector("#batch-list");
  if (batchList) {
    batchList.addEventListener("dragstart", (e) => {
      const item = e.target.closest("[data-batch-idx]");
      if (!item) return;
      dragIdx = parseInt(item.dataset.batchIdx, 10);
      item.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    batchList.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const item = e.target.closest("[data-batch-idx]");
      batchList.querySelectorAll(".batch-item").forEach((el) => el.classList.remove("is-drag-over"));
      if (item) item.classList.add("is-drag-over");
    });
    batchList.addEventListener("drop", (e) => {
      e.preventDefault();
      const item = e.target.closest("[data-batch-idx]");
      if (!item || dragIdx === null) return;
      const dropIdx = parseInt(item.dataset.batchIdx, 10);
      if (dragIdx !== dropIdx) {
        const [moved] = batchOrder.splice(dragIdx, 1);
        batchOrder.splice(dropIdx, 0, moved);
      }
      dragIdx = null;
      render();
    });
    batchList.addEventListener("dragend", () => {
      dragIdx = null;
      batchList.querySelectorAll(".batch-item").forEach((el) => {
        el.classList.remove("is-dragging", "is-drag-over");
      });
    });
  }
}

function renderGroup(g, isLast) {
  const collapsed = collapsedServers.has(g.s.key);
  return `
    <div class="tbl__group">
      <button class="tbl__group-btn" data-server-toggle="${esc(g.s.key)}" aria-expanded="${!collapsed}">
        <span class="tbl__group-chevron${collapsed ? " is-collapsed" : ""}">${ICON.chev}</span>
        <span class="tbl__group-dot" style="background:${g.s.color}"></span>
        <span class="tbl__group-key">${esc(g.s.key)}</span>
        <span class="tbl__group-host">${esc(g.s.label)}</span>
        <span class="tbl__group-count">${g.rows.length} customer${g.rows.length === 1 ? "" : "s"}</span>
      </button>
    </div>
    ${collapsed ? "" : g.rows.map((a, i) => renderRow(a, i === g.rows.length - 1 && isLast)).join("")}
  `;
}

function renderRow(a, isLast) {
  const disabled = launchInProgress;
  const checked = selectedIds.has(a.id);
  const session = activeSessions.find((s) => s.accountId === a.id);
  const hasSession = !!session;
  return `
    <div class="tbl__row${checked ? " is-selected" : ""}${hasSession ? " has-session" : ""}" data-id="${esc(a.id)}" style="${isLast ? "border-bottom:none" : ""}">
      <button class="tbl__check${checked ? " is-checked" : ""}" data-check-id="${esc(a.id)}">
        <svg viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6l2.5 2.5 4.5-5"/></svg>
      </button>
      <div class="avatar-wrap">
        ${avatarHTML(a)}
        ${hasSession ? `<span class="session-dot"></span>` : ""}
      </div>
      <div style="min-width:0">
        <div class="tbl__org">${esc(a.orgDomain)}</div>
        ${a.orgId ? `<div class="tbl__meta">org ${esc(a.orgId)}${a.userId ? ` · user ${esc(a.userId)}` : ""}</div>` : ""}
      </div>
      <div class="tbl__email">${esc(a.email)}</div>
      <div>${serverPillHTML(a.serverKey)}</div>
      <div class="tbl__lastused">${hasSession ? sessionDuration(session.launchedAt) : (a.lastUsed ? esc(a.lastUsed) : "")}</div>
      <div class="tbl__actions">
        <button class="btn-fav${favoriteIds.has(a.id) ? " is-active" : ""}" data-row-action="favorite" data-account-id="${esc(a.id)}" title="${favoriteIds.has(a.id) ? "Remove from favorites" : "Add to favorites"}">
          ${favoriteIds.has(a.id) ? ICON.starFilled : ICON.star}
        </button>
        ${hasSession ? `
          <button class="btn btn--danger btn--sm" data-row-action="close-session" data-account-id="${esc(a.id)}" data-session-id="${esc(session.sessionId)}">
            ${ICON.stop} Close
          </button>
        ` : `
          <div class="btn-split${disabled ? " is-disabled" : ""}">
            <button class="btn-split__main" data-row-action="launch" data-account-id="${esc(a.id)}" ${disabled ? "disabled" : ""}>
              ${ICON.rocket}
              ${launchInProgress && activeLaunch?.orgDomain === a.orgDomain ? "Launching…" : "Launch"}
            </button>
            ${!disabled ? `<button class="btn-split__caret" data-row-action="launch" data-account-id="${esc(a.id)}" title="Launch options">${ICON.chev}</button>` : ""}
          </div>
        `}
        <button class="btn-icon" data-row-action="copy" data-account-id="${esc(a.id)}" title="Copy CLI flags">
          ${ICON.copy}
        </button>
        <button class="btn-icon" title="More actions">${ICON.more}</button>
      </div>
    </div>
  `;
}

function renderLaunchBanner() {
  const s = serverInfo(activeLaunch.serverKey);
  const batchLabel = batchQueue ? ` (${batchQueue.current + 1} of ${batchQueue.ids.length})` : "";
  const pct = batchQueue
    ? Math.round(((batchQueue.current + 0.5) / batchQueue.ids.length) * 100)
    : Math.round((activeLaunch.step / activeLaunch.totalSteps) * 100);
  return `
    <div class="launch-banner">
      <div class="launch-banner__chip"></div>
      <div style="flex:1; min-width:0">
        <div class="launch-banner__title">
          ${batchQueue ? "Queue in progress" : "Launch in progress"}${batchLabel}
          <span class="server-pill" style="background:${s.soft};color:${s.text}">
            <span class="server-pill__dot" style="background:${s.color}"></span>${esc(s.key)}
          </span>
          <span style="color:var(--dr-text-secondary); font-weight:500">${esc(activeLaunch.orgDomain)}</span>
        </div>
        <div class="launch-banner__sub">
          ${batchQueue
            ? `Launching customer ${batchQueue.current + 1} of ${batchQueue.ids.length}… ${activeLaunch.label ? "— " + esc(activeLaunch.label) : ""}`
            : `${activeLaunch.label || "Launching"} — step ${activeLaunch.step} of ${activeLaunch.totalSteps}`}
        </div>
      </div>
      <div class="launch-banner__bar"><div style="width:${pct}%"></div></div>
    </div>
  `;
}

function renderCloseProgressBanner() {
  if (!batchCloseProgress) return "";
  const pct = Math.round(((batchCloseProgress.current + 0.5) / batchCloseProgress.total) * 100);
  return `
    <div class="launch-banner launch-banner--danger">
      <div class="launch-banner__chip"></div>
      <div style="flex:1; min-width:0">
        <div class="launch-banner__title">Closing sessions</div>
        <div class="launch-banner__sub">Closing ${batchCloseProgress.total} session${batchCloseProgress.total === 1 ? "" : "s"}…</div>
      </div>
      <div class="launch-banner__bar"><div style="width:${pct}%"></div></div>
    </div>`;
}

// ── Prerequisites classification & first-run UX ─────────────────

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
    <div class="crumbs">
      <a href="#">Home</a>
      <span class="sep">/</span>
      <a href="#" class="is-current">Setup</a>
    </div>
    <div class="prereq-screen">
      <svg width="160" height="120" viewBox="0 0 180 120" fill="none" aria-hidden>
        <rect x="30" y="20" width="120" height="80" rx="8" fill="#fff" stroke="#DFE0E3" stroke-width="1.5"/>
        <path d="M55 55 l10 10 l20-20" stroke="#03A678" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <rect x="100" y="50" width="30" height="4" rx="2" fill="#DFE0E3"/>
        <rect x="100" y="60" width="20" height="4" rx="2" fill="#DFE0E3"/>
      </svg>
      <h2>Set up your environment</h2>
      <p>DR Launcher needs a few tools to work. Install the missing items below, then click Re-check.</p>
      <div class="prereq-list">
        ${allItems.map(prereqItemHtml).join("")}
      </div>
      <div class="prereq-actions">
        <button class="btn btn--primary" id="prereq-recheck">${ICON.refresh} Re-check</button>
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
        <button class="btn btn--sm" id="prereq-banner-recheck">${ICON.refresh} Re-check</button>
        <button class="btn btn--sm btn--ghost" id="prereq-banner-dismiss">${ICON.x} Dismiss</button>
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
    <div class="crumbs">
      <a href="#">Home</a>
      <span class="sep">/</span>
      <a href="#" class="is-current">All customers</a>
    </div>
    <div class="page-head">
      <div>
        <h1>All customers<span class="count">0</span></h1>
        <div class="sub">No customers authenticated on this machine yet.</div>
      </div>
    </div>
    <div class="empty">
      <svg width="160" height="120" viewBox="0 0 180 120" fill="none" aria-hidden>
        <rect x="20" y="20" width="120" height="20" rx="10" fill="#fff" stroke="#DFE0E3" stroke-width="1.5" stroke-dasharray="3 4" />
        <rect x="20" y="50" width="120" height="20" rx="10" fill="#fff" stroke="#DFE0E3" stroke-width="1.5" stroke-dasharray="3 4" />
        <rect x="20" y="80" width="120" height="20" rx="10" fill="#fff" stroke="#DFE0E3" stroke-width="1.5" stroke-dasharray="3 4" />
        <circle cx="32" cy="30" r="4.5" fill="#4646CE" />
        <circle cx="32" cy="60" r="4.5" fill="#F93576" />
        <circle cx="32" cy="90" r="4.5" fill="#FFA310" />
        <line x1="46" y1="30" x2="115" y2="30" stroke="#DFE0E3" stroke-width="2" stroke-linecap="round" />
        <line x1="46" y1="60" x2="100" y2="60" stroke="#DFE0E3" stroke-width="2" stroke-linecap="round" />
        <line x1="46" y1="90" x2="108" y2="90" stroke="#DFE0E3" stroke-width="2" stroke-linecap="round" />
      </svg>
      <h2>Start by authenticating a customer</h2>
      <p>Each customer launch opens Chrome and a Claude Code terminal scoped to that account, in its own virtual desktop. Pick a server to begin.</p>
      <div class="empty__servers">
        ${SERVERS.map((s) => `
          <button class="empty__server" data-empty-server="${esc(s.key)}">
            <span class="server-pill__dot" style="background:${s.color}"></span>
            Connect via ${esc(s.key)}
            <span class="empty__server-host">${esc(s.label)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

// ── Modals (auth picker, settings, instruction fallback) ─────────
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

  const closeBtn = document.createElement("button");
  closeBtn.className = "toast__close";
  closeBtn.innerHTML = ICON.x;
  closeBtn.addEventListener("click", dismiss);
  el.appendChild(closeBtn);

  tray.appendChild(el);

  const persistent = opts.persistent || level === "error";
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
        ${workspacePath ? `<div style="font-size:12px;color:var(--dr-text-secondary);margin-top:8px">Workspace: <code style="font-family:var(--dr-font-mono);color:var(--dr-text-body)">${esc(workspacePath)}</code></div>` : ""}
      </div>
      <div class="modal__foot">
        <span></span>
        <button class="btn btn--primary" data-modal-close>Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector("textarea");
  ta.focus(); ta.select();
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
        ${SERVERS.map((s) => {
          const n = accounts.filter((a) => a.serverKey === s.key).length;
          return `
            <button class="auth-server" data-server="${esc(s.key)}">
              <span class="auth-server__key" style="background:${s.soft};color:${s.text}">${esc(s.key)}</span>
              <span style="flex:1; min-width:0">
                <span class="auth-server__region">${esc(SERVER_REGION[s.key] || s.key)}</span>
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

function buildSettingsHealthRows() {
  if (!healthChecks) return `<div class="settings-row"><div class="settings-row__main" style="font-size:12px;color:var(--dr-text-secondary)">Health data not available. Click "Run health check" to refresh.</div></div>`;
  const rows = [
    { label: "Datarails CLI (dr)", ok: healthChecks.dr?.found },
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
      <span class="health-row__status">${r.ok ? "OK" : "Not found"}</span>
    </div>`).join("");
}

function showSettingsModal() {
  const vdOn = userSettings.useVirtualDesktops;
  const vdDisabled = vdAvailable === false;
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
                <button class="btn btn--sm" id="settings-health-recheck">${ICON.refresh} Run health check</button>
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
                <button class="btn btn--sm" id="settings-sync-btn">${ICON.refresh} Sync now</button>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">About</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main" style="font-size:12px;color:var(--dr-text-secondary);line-height:1.6">
                  <div>DR Launcher — local-first customer launcher</div>
                  <div>API token: <code style="font-family:var(--dr-font-mono);color:var(--dr-text-body)">${esc(String(API_TOKEN).slice(0, 6))}…${esc(String(API_TOKEN).slice(-4))}</code></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="modal__foot">
        <span></span>
        <button class="btn btn--primary" data-modal-close>Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
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
  overlay.addEventListener("click", async (e) => {
    const btn = e.target.closest("#settings-health-recheck");
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = "Checking…";
    await recheckHealth();
    const card = overlay.querySelector("#settings-health-card");
    if (card) {
      card.innerHTML = buildSettingsHealthRows()
        + `<div style="padding:8px 16px 12px;text-align:right"><button class="btn btn--sm" id="settings-health-recheck">${ICON.refresh} Run health check</button></div>`;
    }
    showToast("Health check complete.");
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

    // Cmd/Ctrl+K → focus search
    if (mod && e.key === "k") {
      e.preventDefault();
      const input = document.querySelector(".topbar__search input");
      if (input) input.focus();
      return;
    }

    // Escape → clear search, clear selection, or close modal
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

    // Cmd/Ctrl+A → select all visible
    if (mod && e.key === "a") {
      e.preventDefault();
      const filtered = filterAccounts(accounts);
      toggleSelectAll(filtered);
      return;
    }

    // Enter → launch selection queue
    if (e.key === "Enter" && selectedIds.size > 0 && !launchInProgress) {
      e.preventDefault();
      launchBatchQueue();
      return;
    }
  });
}

function updateThemeIcon(theme) {
  const btn = document.getElementById("btn-theme");
  if (btn) btn.innerHTML = theme === "dark" ? ICON.sun : ICON.moon;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeIcon(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  updateThemeIcon(next);
  saveSettingsQuiet({ theme: next });
}

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Wire login buttons
  document.getElementById("login-btn")?.addEventListener("click", triggerLogin);
  document.getElementById("dev-login-btn")?.addEventListener("click", triggerDevLogin);
  document.getElementById("dev-password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") triggerDevLogin();
  });

  // Check auth status — gate the app behind it
  await fetchAuthStatus();

  if (authState.authenticated) {
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app-shell").style.display = "";
    try {
      const syncRes = await fetch("/api/sync/init", { method: "POST", headers });
      const syncData = await syncRes.json();
      if (syncData.ok && syncData.preferences) {
        applyTheme(syncData.preferences.theme || "light");
      }
      await fetchSyncStatus();
    } catch { /* sync is best-effort */ }
    await initApp();
  }
  // If not authenticated, the login screen is already visible
});

async function initApp() {
  document.getElementById("btn-refresh")?.addEventListener("click", fetchAccounts);
  document.getElementById("btn-settings")?.addEventListener("click", showSettingsModal);
  document.getElementById("btn-theme")?.addEventListener("click", toggleTheme);

  document.getElementById("user-switcher")?.addEventListener("click", () => {
    if (authState.authenticated) {
      if (confirm("Sign out of DR Launcher?")) triggerLogout();
    }
  });

  const searchInput = document.querySelector(".topbar__search input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      render();
    });
  }

  initKeyboardShortcuts();

  await Promise.all([fetchSettings(), fetchHealth(), fetchRecents(), fetchSessions()]);

  favoriteIds = new Set(userSettings.favoriteIds || []);
  collapsedServers = new Set(userSettings.collapsedServers || []);
  applyTheme(userSettings.theme || "light");

  await fetchAccounts();

  setInterval(checkSessionHealth, 30000);

  const validIds = new Set(accounts.map((a) => a.id));
  for (const id of [...selectedIds]) { if (!validIds.has(id)) selectedIds.delete(id); }
  batchOrder = batchOrder.filter((id) => validIds.has(id));
}
