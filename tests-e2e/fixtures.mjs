// Deterministic fixtures for the Playwright smoke harness. These mirror the
// real backend response shapes (verified against server.js handlers) so the
// real public/app.js boots and renders against stubbed data — no live server,
// no `dr`, no OS actions.

export const USER = {
  name: "Jamie Kruger",
  initials: "JK",
  devMode: true,
  tokenExpired: false,
  cloudId: "cloud-e2e",
};

// 4 production servers — hosts match lib/servers.js BUNDLED_DEFAULTS / app.js fallback.
export const SERVERS = [
  { key: "US",  host: "https://app.datarails.com",   label: "app.datarails.com",   color: "#4646CE", soft: "#DFD9FF", text: "#25258C", region: "United States" },
  { key: "US2", host: "https://us-2.datarails.com",  label: "us-2.datarails.com",  color: "#7B61FF", soft: "#F0EEFF", text: "#5D45D6", region: "United States (instance 2)" },
  { key: "UK",  host: "https://ukapp.datarails.com", label: "ukapp.datarails.com", color: "#03A678", soft: "#ECFAE4", text: "#037C5A", region: "United Kingdom" },
  { key: "CA",  host: "https://caapp.datarails.com", label: "caapp.datarails.com", color: "#FFA310", soft: "#FFF4D4", text: "#9E5F00", region: "Canada" },
];

// Initial settings. useVirtualDesktops:true + health.virtualDesktop.available:false
// is what makes classifyPrerequisites() raise the "Virtual Desktops" WARNING
// (app.js:1727) — and no critical, so the app shell + account list still render.
export const SETTINGS = {
  showAllAccounts: false,
  useVirtualDesktops: true,
  favoriteIds: [],
  collapsedServers: [],
  theme: "warm",
};

// Health: all critical checks pass (dr/chrome/workspace), VD unavailable → warning only.
export const HEALTH = {
  status: "ok",
  checks: {
    dr: { found: true, installing: false, version: "1.2.3" },
    chrome: { found: true, path: "C:\\chrome.exe" },
    claude: { found: true },
    windowsTerminal: { found: true },
    workspaceRoot: { path: "C:\\Workspaces\\DR", writable: true },
    virtualDesktop: { available: false, supportsNaming: false, osBuild: null, languageMode: null, desktopCount: null, error: "not_supported" },
  },
  servers: SERVERS.map((s) => s.key),
};

function acct(o) {
  return {
    id: `${o.serverKey}:${o.email}`,
    email: o.email,
    serverKey: o.serverKey,
    serverHost: SERVERS.find((s) => s.key === o.serverKey)?.host || "",
    orgDomain: o.orgDomain,
    orgId: o.orgId ?? null,
    userId: o.userId ?? null,
    isSupport: o.isSupport,
    cliAuthStatus: o.cliAuthStatus || "active",
    lastUsed: o.lastUsed || "2026-05-29",
  };
}

// The full account universe (pre-visibility-filter). 6 support + 3 customer-user.
// Visibility (showAllAccounts=false): support always shown; a customer-user is
// shown only if it has a live session (keepAccountIds) — here `user@shachar`.
export const ACCOUNTS_ALL = [
  acct({ serverKey: "US",  email: "support@proshop.inc",        orgDomain: "proshop.inc",            orgId: "16437", userId: "63275", isSupport: true }),
  acct({ serverKey: "US",  email: "support@ccmpr.com",          orgDomain: "ccmpr.com",              orgId: "13486", userId: "48430", isSupport: true }),
  acct({ serverKey: "US",  email: "support@divergent3d.com",    orgDomain: "divergent3d.com",        orgId: "15761", userId: "58422", isSupport: true }),
  acct({ serverKey: "US",  email: "support@beltservice.com",    orgDomain: "beltservice.com",        orgId: "15258", userId: "56052", isSupport: true }),
  acct({ serverKey: "US2", email: "support@garagecoholdings.com", orgDomain: "garagecoholdings.com", orgId: "228",   userId: "895",   isSupport: true, cliAuthStatus: "expired" }),
  acct({ serverKey: "US2", email: "support@ai.exercise.shachar.com", orgDomain: "ai.exercise.shachar.com", orgId: "552", userId: "2281", isSupport: true }),
  // customer-user WITH an active session → kept visible even when support-only.
  acct({ serverKey: "US2", email: "user@ai.exercise.shachar.com", orgDomain: "ai.exercise.shachar.com", orgId: "552", userId: "4354", isSupport: false }),
  // customer-user, no session → hidden under support-only default.
  acct({ serverKey: "US2", email: "user@hidden-one.com",        orgDomain: "hidden-one.com",         orgId: "777", userId: "1111", isSupport: false }),
  acct({ serverKey: "US2", email: "user@hidden-two.com",        orgDomain: "hidden-two.com",         orgId: "888", userId: "2222", isSupport: false }),
];

export const ID = Object.fromEntries(ACCOUNTS_ALL.map((a) => [a.email, a.id]));

// Account chosen for the launch spec: a support account, idle (no session, not expired).
export const LAUNCH_TARGET_ID = ID["support@proshop.inc"];

function session(o) {
  return {
    sessionId: o.sessionId,
    accountId: o.accountId,
    email: o.email,
    serverKey: o.serverKey,
    orgDomain: o.orgDomain,
    orgId: o.orgId ?? null,
    status: o.status || "active",
    chromePid: 1000, chromeProfilePath: "C:\\p", chromeHwnds: [1],
    terminalPid: 2000, terminalHwnds: [2],
    desktopName: o.desktopName || null,
    desktopCreated: false,
    workspacePath: "C:\\Workspaces\\DR\\x",
    launchedAt: "2026-05-29T10:30:00.000Z",
    chromeOk: true, terminalOk: true,
    agentId: null, agentName: null,
  };
}

// Initial live sessions: the shachar support + shachar user accounts.
export const SESSIONS_INITIAL = [
  session({ sessionId: "sess-support-shachar", accountId: ID["support@ai.exercise.shachar.com"], email: "support@ai.exercise.shachar.com", serverKey: "US2", orgDomain: "ai.exercise.shachar.com", orgId: "552" }),
  session({ sessionId: "sess-user-shachar",    accountId: ID["user@ai.exercise.shachar.com"],    email: "user@ai.exercise.shachar.com",    serverKey: "US2", orgDomain: "ai.exercise.shachar.com", orgId: "552" }),
];

// A successful /api/launch response body (chrome+terminal ok, no VD, no first-launch noise).
export function launchSuccessBody() {
  return {
    launchId: "L-e2e-1",
    chrome: { ok: true, pid: 4242, profilePath: "C:\\p", error: null },
    workspace: { ok: true, path: "C:\\Workspaces\\DR\\proshop", slug: "proshop", claudeMdCreated: false, claudeMdUpdated: false, error: null },
    terminal: { ok: true, pid: 5252, error: null },
    virtualDesktop: { enabled: false, ok: false, created: false, reused: false, switched: false, movedChrome: false, movedTerminal: false, pinnedWarning: null, desktopName: null, error: null },
    instruction: "cd workspace && claude",
    authExpired: false,
    agent: { ok: false, initialPrompt: null },
    sessionError: null,
  };
}

export const LAUNCH_403 = { error: "support_only", message: "Launching a customer user account is disabled — enable 'Show all accounts' in Settings." };
export const LAUNCH_428 = { error: "account_type_unknown", message: "Couldn't verify this is a support account — refresh accounts and retry, or enable 'Show all accounts'." };
