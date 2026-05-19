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
let activeLaunch = null;   // { orgDomain, serverKey, step, totalSteps } when running
let recentLaunches = [];   // last 5 successful launches (local only)
let filterServer = null;   // "US" | "US2" | "UK" | "CA" | null (= all)

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
    vdAvailable = data.checks?.virtualDesktop?.available === true;
  } catch {
    vdAvailable = false;
  }
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

async function launchCustomer(account) {
  if (launchInProgress) {
    showToast("A launch is already in progress. Please wait.", "warn");
    return;
  }
  launchInProgress = true;
  activeLaunch = { orgDomain: account.orgDomain, serverKey: account.serverKey, step: 1, totalSteps: 5 };
  render();

  try {
    const res = await fetch("/api/launch", {
      method: "POST",
      headers,
      body: JSON.stringify(account),
    });

    if (res.status === 409) {
      showToast("Another launch is in progress. Please wait.", "warn");
      return;
    }

    const data = await res.json();
    if (!res.ok) {
      showToast("Launch failed: " + (data.error || "Unknown error"), "error");
      return;
    }

    const parts = [];
    if (data.chrome?.ok) parts.push("Chrome");
    if (data.terminal?.ok) parts.push("Claude Code");
    if (parts.length > 0) {
      showToast(`Launched ${account.orgDomain} — ${parts.join(" + ")} opening.`);
    }
    if (data.workspace?.claudeMdCreated) {
      showToast(`New workspace created at ${data.workspace.path}.`);
    }

    if (data.virtualDesktop?.enabled) {
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
      showToast("Terminal unavailable — copying instructions.", "warn");
      try {
        await navigator.clipboard.writeText(data.instruction);
        showToast("Instructions copied to clipboard.");
      } catch {
        showInstructionModal(data.instruction, account.orgDomain, data.workspace?.path);
      }
    }

    // Record the launch in the local recents rail.
    recentLaunches.unshift({
      id: account.id,
      orgDomain: account.orgDomain,
      serverKey: account.serverKey,
      desktopName: data.virtualDesktop?.desktopName || null,
      at: new Date(),
    });
    if (recentLaunches.length > 5) recentLaunches.length = 5;
  } catch (err) {
    showToast("Launch failed: " + err.message, "error");
  } finally {
    launchInProgress = false;
    activeLaunch = null;
    render();
  }
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
  return `<span class="server-pill" style="background:${s.soft};color:${s.text}">
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
};

// ── Sidebar rendering ─────────────────────────────────────────────
function renderSidebar() {
  const el = document.getElementById("sidebar");
  if (!el) return;

  const total = accounts.length;
  const expired = accounts.filter((a) => a.cliAuthStatus !== "active").length;
  const recent = recentLaunches.length;
  const pinned = pinnedCustomers();

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
        ${linkHTML("all", ICON.user, "All customers", total, { active: filterServer === null, filter: "" })}
        ${linkHTML("recent", ICON.clock, "Recently launched", recent || null, { active: false, filter: "" })}
        ${linkHTML("reauth", ICON.shield, "Needs reauth", expired || null, { warn: true, active: false, filter: "" })}
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

    ${pinned.length ? `
      <div class="sidebar__section">
        <div class="sidebar__label">Pinned</div>
        <div class="sidebar__items">
          ${pinned.map((a) => `
            <button class="sidebar__link" data-pinned="${esc(a.id)}">
              <span class="avatar avatar--sm" style="background:linear-gradient(135deg,${avatarColor(a)} 0%,${shadeHex(avatarColor(a), -18)} 100%)">${esc(initialsOf(a))}</span>
              <span class="sidebar__link-text" style="font-size:12px">${esc(a.orgDomain)}</span>
            </button>`).join("")}
        </div>
      </div>
    ` : ""}

    <div class="sidebar__cta">
      <div class="sidebar__cta-title">Need another customer?</div>
      <div class="sidebar__cta-body">Authenticate via SSO. Your token stays on this machine.</div>
      <button class="btn btn--primary" id="cta-auth" style="margin-top:4px">${ICON.plus} Authenticate customer</button>
    </div>
  `;

  // Wire up server-filter buttons.
  el.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.filter;
      filterServer = v ? v : null;
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
  const ctaAuth = document.getElementById("cta-auth");
  if (ctaAuth) ctaAuth.addEventListener("click", showAuthModal);
}

function pinnedCustomers() {
  // Surface up to 3 of the user's most-recently-launched customers as pinned.
  const seen = new Set();
  const out = [];
  for (const r of recentLaunches) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const a = accounts.find((x) => x.id === r.id);
    if (a) out.push(a);
    if (out.length >= 3) break;
  }
  return out;
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

  if (accounts.length === 0) {
    main.innerHTML = renderEmpty();
    main.querySelectorAll("[data-empty-server]").forEach((btn) => {
      btn.addEventListener("click", () => startLogin(btn.dataset.emptyServer));
    });
    return;
  }

  const filtered = filterServer ? accounts.filter((a) => a.serverKey === filterServer) : accounts;
  const groups = SERVERS
    .map((s) => ({ s, rows: filtered.filter((a) => a.serverKey === s.key) }))
    .filter((g) => g.rows.length);

  main.innerHTML = `
    <div class="crumbs">
      <a href="#">Home</a>
      <span class="sep">/</span>
      <a href="#" class="is-current">${filterServer ? esc(filterServer) + " customers" : "All customers"}</a>
    </div>

    <div class="page-head">
      <div>
        <h1>${filterServer ? esc(filterServer) + " customers" : "All customers"}<span class="count">${filtered.length}</span></h1>
        <div class="sub">${groups.length} server${groups.length === 1 ? "" : "s"} · last refreshed ${new Date().toLocaleTimeString()}</div>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--ghost" id="head-refresh">${ICON.refresh} Refresh</button>
        <button class="btn btn--primary" id="head-auth">${ICON.plus} Authenticate customer</button>
      </div>
    </div>

    ${activeLaunch ? renderLaunchBanner() : ""}

    <div class="filters">
      <button class="chip ${filterServer === null ? "is-active" : ""}" data-filter="">
        All <span class="chip__count">${accounts.length}</span>
      </button>
      <button class="chip" data-status="active">
        Authenticated <span class="chip__count">${accounts.filter((a) => a.cliAuthStatus === "active").length}</span>
      </button>
      <button class="chip" data-status="expired">
        Expired <span class="chip__count">${accounts.filter((a) => a.cliAuthStatus !== "active").length}</span>
      </button>
      <span class="filter-divider"></span>
      <button class="chip">${ICON.filter} Filter</button>
      <button class="chip">Sort: Last used ${ICON.chev}</button>
      <span class="grow">${filtered.length} of ${accounts.length}</span>
    </div>

    <div class="panel">
      <div class="tbl__header">
        <div></div>
        <div class="tbl__sortable">Customer ${ICON.chev}</div>
        <div>Account</div>
        <div>Server</div>
        <div>CLI status</div>
        <div class="tbl__sortable">Last used ${ICON.chev}</div>
        <div style="text-align:right">Actions</div>
      </div>
      ${groups.map((g, gi) => renderGroup(g, gi === groups.length - 1)).join("")}
    </div>
  `;

  // Wire up actions.
  main.querySelector("#head-refresh")?.addEventListener("click", fetchAccounts);
  main.querySelector("#head-auth")?.addEventListener("click", showAuthModal);
  main.querySelectorAll("[data-row-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled || btn.classList.contains("is-disabled")) return;
      const id = btn.dataset.accountId;
      const acct = accounts.find((a) => a.id === id);
      if (!acct) return;
      if (btn.dataset.rowAction === "launch") launchCustomer(acct);
      if (btn.dataset.rowAction === "copy") copyInstruction(acct);
    });
  });
}

function renderGroup(g, isLast) {
  return `
    <div class="tbl__group">
      <span class="tbl__group-dot" style="background:${g.s.color}"></span>
      <span class="tbl__group-key">${esc(g.s.key)}</span>
      <span class="tbl__group-host">${esc(g.s.label)}</span>
      <span class="tbl__group-count">${g.rows.length} customer${g.rows.length === 1 ? "" : "s"}</span>
    </div>
    ${g.rows.map((a, i) => renderRow(a, i === g.rows.length - 1 && isLast)).join("")}
  `;
}

function renderRow(a, isLast) {
  const expired = a.cliAuthStatus !== "active";
  const disabled = launchInProgress || expired;
  return `
    <div class="tbl__row" data-id="${esc(a.id)}" style="${isLast ? "border-bottom:none" : ""}">
      ${avatarHTML(a)}
      <div style="min-width:0">
        <div class="tbl__org">${esc(a.orgDomain)}</div>
        ${a.orgId ? `<div class="tbl__meta">org ${esc(a.orgId)}${a.userId ? ` · user ${esc(a.userId)}` : ""}</div>` : ""}
      </div>
      <div class="tbl__email">${esc(a.email)}</div>
      <div>${serverPillHTML(a.serverKey)}</div>
      <div>${cliStatusHTML(a.cliAuthStatus)}</div>
      <div class="tbl__lastused">${a.lastUsed ? esc(a.lastUsed) : ""}</div>
      <div class="tbl__actions">
        <div class="btn-split${disabled ? " is-disabled" : ""}">
          <button class="btn-split__main" data-row-action="launch" data-account-id="${esc(a.id)}" ${disabled ? "disabled" : ""}>
            ${expired ? ICON.shield : ICON.rocket}
            ${expired ? "Reauthenticate" : (launchInProgress && activeLaunch?.orgDomain === a.orgDomain ? "Launching…" : "Launch")}
          </button>
          ${!disabled ? `<button class="btn-split__caret" data-row-action="launch" data-account-id="${esc(a.id)}" title="Launch options">${ICON.chev}</button>` : ""}
        </div>
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
  const pct = Math.round((activeLaunch.step / activeLaunch.totalSteps) * 100);
  return `
    <div class="launch-banner">
      <div class="launch-banner__chip"></div>
      <div style="flex:1; min-width:0">
        <div class="launch-banner__title">
          Launch in progress
          <span class="server-pill" style="background:${s.soft};color:${s.text}">
            <span class="server-pill__dot" style="background:${s.color}"></span>${esc(s.key)}
          </span>
          <span style="color:var(--dr-text-secondary); font-weight:500">${esc(activeLaunch.orgDomain)}</span>
        </div>
        <div class="launch-banner__sub">
          Moving Chrome + Claude Code to a virtual desktop — step ${activeLaunch.step} of ${activeLaunch.totalSteps}.
        </div>
      </div>
      <div class="launch-banner__bar"><div style="width:${pct}%"></div></div>
    </div>
  `;
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
function showToast(message, level) {
  const tray = document.getElementById("toasts");
  if (!tray) return;
  const el = document.createElement("div");
  el.className = "toast" + (level === "error" ? " toast--error" : level === "warn" ? " toast--warn" : "");
  el.textContent = message;
  tray.appendChild(el);
  setTimeout(() => el.remove(), 4500);
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
          <p>Preferences are stored locally on this machine.</p>
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

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("btn-refresh")?.addEventListener("click", fetchAccounts);
  document.getElementById("btn-settings")?.addEventListener("click", showSettingsModal);

  await Promise.all([fetchSettings(), fetchHealth()]);
  await fetchAccounts();
});
