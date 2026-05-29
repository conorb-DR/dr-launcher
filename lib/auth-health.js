const fs = require("fs");
const path = require("path");
const os = require("os");
const drCli = require("./dr-cli");
const sessions = require("./sessions");
const history = require("./history");
const logger = require("./log");

const REGISTRY_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);
const REGISTRY_PATH = path.join(REGISTRY_DIR, "auth-registry.json");

const AUTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const AUTH_CHECK_INITIAL_DELAY_MS = 30 * 1000;
const PROBE_CONCURRENCY = 3;
const PROBE_STALE_MS = 5 * 60 * 1000;
const SKEW_MS = 60_000;
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const AUTH_PATTERNS = [
  "http 401",
  "unauthorized",
  "not logged in",
  "jwt auto-refresh failed",
  "refresh failed",
  "session expired",
  "mint-via-session failed",
  "authentication credentials were not provided",
];

let _timer = null;
let _initialTimer = null;
let _inflight = null;

// --- Registry I/O ---

function loadRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function saveRegistry(entries) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const tmpPath = REGISTRY_PATH + ".tmp." + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf8");
  fs.renameSync(tmpPath, REGISTRY_PATH);
}

function redactEmail(email) {
  if (!email || !email.includes("@")) return email;
  return email[0] + "***@" + email.split("@")[1];
}

// --- Startup seeding ---

function seedRegistryIfEmpty() {
  const registry = loadRegistry();
  if (registry.length > 0) return;

  const seen = new Set();
  const seeded = [];

  for (const s of sessions.getVisibleSessions()) {
    if (!s.accountId || seen.has(s.accountId)) continue;
    seen.add(s.accountId);
    seeded.push({
      id: s.accountId,
      email: s.email || "",
      serverKey: s.serverKey || "",
      serverHost: "",
      orgDomain: s.orgDomain || "",
      orgId: s.orgId || null,
      userId: null,
      jwtExp: null,
      cliAuthStatus: "unknown",
      lastSuccessfulDiscovery: null,
      lastProbeAt: null,
      lastProbeResult: null,
    });
  }

  for (const h of history.getRecents(50)) {
    if (!h.accountId || seen.has(h.accountId)) continue;
    seen.add(h.accountId);
    seeded.push({
      id: h.accountId,
      email: h.email || "",
      serverKey: h.serverKey || "",
      serverHost: "",
      orgDomain: h.orgDomain || "",
      orgId: null,
      userId: null,
      jwtExp: null,
      cliAuthStatus: "unknown",
      lastSuccessfulDiscovery: null,
      lastProbeAt: null,
      lastProbeResult: null,
    });
  }

  if (seeded.length > 0) {
    saveRegistry(seeded);
    logger.log("info", "auth-health", `Seeded registry with ${seeded.length} account(s) from sessions/history`);
  }
}

// --- Probe classification ---

function classifyProbeResult(result) {
  if (result.timedOut) return "unchanged";

  if (result.exitCode === 0) {
    try {
      const data = JSON.parse(result.stdout);
      const exp = data.claims?.exp;
      if (typeof exp === "number" && exp * 1000 > Date.now() + SKEW_MS) {
        return "active";
      }
      return "expired";
    } catch {
      return "unchanged";
    }
  }

  const combined = (result.stdout + " " + result.stderr).toLowerCase();
  if (AUTH_PATTERNS.some((p) => combined.includes(p))) {
    return "expired";
  }

  return "unchanged";
}

// --- Core check ---

async function _runCheckImpl() {
  const registry = loadRegistry();
  const registryMap = new Map(registry.map((r) => [r.id, r]));
  let discovered;
  try {
    discovered = await drCli.discoverAccounts();
  } catch (err) {
    logger.log("warn", "auth-health", `Discovery failed: ${err.message}`);
    return;
  }

  const discoveredIds = new Set(discovered.map((a) => a.id));
  const needsProbe = [];

  // Reconcile discovered accounts into registry
  for (const acct of discovered) {
    let entry = registryMap.get(acct.id);
    if (!entry) {
      entry = {
        id: acct.id,
        cliAuthStatus: "unknown",
        lastSuccessfulDiscovery: null,
        lastProbeAt: null,
        lastProbeResult: null,
      };
      registryMap.set(acct.id, entry);
    }

    // Update identity fields from discovery
    entry.email = acct.email;
    entry.serverKey = acct.serverKey;
    entry.serverHost = acct.serverHost;
    entry.orgDomain = acct.orgDomain;
    entry.orgId = acct.orgId;
    entry.userId = acct.userId;
    entry.jwtExp = acct.jwtExp;

    // Tier 1: valid JWT → mark active, skip probe
    if (acct.jwtExp && acct.jwtExp * 1000 > Date.now() + SKEW_MS) {
      entry.cliAuthStatus = "active";
      entry.lastSuccessfulDiscovery = new Date().toISOString();
      continue;
    }

    // JWT expired or missing → needs Tier 2 probe
    entry.lastSuccessfulDiscovery = new Date().toISOString();
    needsProbe.push(entry);
  }

  // Registry entries missing from discovery — probe if stale
  for (const entry of registryMap.values()) {
    if (discoveredIds.has(entry.id)) continue;
    const lastProbe = entry.lastProbeAt ? new Date(entry.lastProbeAt).getTime() : 0;
    if (Date.now() - lastProbe > PROBE_STALE_MS) {
      needsProbe.push(entry);
    }
  }

  // Prioritize: active sessions first
  const activeSessIds = new Set(sessions.getActiveSessions().map((s) => s.accountId));
  needsProbe.sort((a, b) => {
    const aActive = activeSessIds.has(a.id) ? 0 : 1;
    const bActive = activeSessIds.has(b.id) ? 0 : 1;
    return aActive - bActive;
  });

  // Probe in batches of PROBE_CONCURRENCY
  let transitioned = false;
  for (let i = 0; i < needsProbe.length; i += PROBE_CONCURRENCY) {
    const batch = needsProbe.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        if (!entry.serverKey || !entry.email) return null;
        const result = await drCli.probeWhoami(entry.serverKey, entry.email, { timeout: 20000 });
        return { entry, result };
      })
    );

    for (const item of results) {
      if (!item) continue;
      const { entry, result } = item;
      const status = classifyProbeResult(result);
      entry.lastProbeAt = new Date().toISOString();
      entry.lastProbeResult = status === "unchanged" ? "error" : status;

      if (status !== "unchanged" && status !== entry.cliAuthStatus) {
        const prev = entry.cliAuthStatus;
        entry.cliAuthStatus = status;
        if (status === "expired") {
          transitioned = true;
          logger.log("warn", "auth-health",
            `Account ${redactEmail(entry.email)} on ${entry.serverKey}: ${prev} → expired`);
        } else if (status === "active" && prev === "expired") {
          logger.log("info", "auth-health",
            `Account ${redactEmail(entry.email)} on ${entry.serverKey}: expired → active`);
        }
      }

      // If probe returned active, update jwtExp from fresh claims
      if (status === "active" && result.exitCode === 0) {
        try {
          const data = JSON.parse(result.stdout);
          if (typeof data.claims?.exp === "number") {
            entry.jwtExp = data.claims.exp;
          }
        } catch { /* keep existing */ }
      }
    }
  }

  // Prune stale entries
  const now = Date.now();
  const pruned = [...registryMap.values()].filter((entry) => {
    if (entry.cliAuthStatus === "expired") return true;
    const lastDisc = entry.lastSuccessfulDiscovery
      ? new Date(entry.lastSuccessfulDiscovery).getTime() : 0;
    if (now - lastDisc > PRUNE_AGE_MS && !activeSessIds.has(entry.id)) {
      return false;
    }
    return true;
  });

  saveRegistry(pruned);

  if (transitioned) {
    drCli.invalidateAccountsCache();
  }
}

function runCheck() {
  if (_inflight) return _inflight;
  _inflight = _runCheckImpl().catch((err) => {
    logger.log("error", "auth-health", `Check failed: ${err.message}`);
  }).finally(() => {
    _inflight = null;
  });
  return _inflight;
}

// --- Merge for /api/accounts ---

function mergeWithDiscovered(discoveredAccounts) {
  const registry = loadRegistry();
  const regMap = new Map(registry.map((r) => [r.id, r]));
  const discoveredIds = new Set(discoveredAccounts.map((a) => a.id));
  const result = [];
  let dirty = false;

  for (const acct of discoveredAccounts) {
    const entry = regMap.get(acct.id);
    if (entry) {
      // Reconcile: valid JWT in discovery clears expired status
      if (acct.jwtExp && acct.jwtExp * 1000 > Date.now() + SKEW_MS) {
        if (entry.cliAuthStatus === "expired" || entry.cliAuthStatus === "unknown") {
          entry.cliAuthStatus = "active";
          entry.lastSuccessfulDiscovery = new Date().toISOString();
          dirty = true;
        }
      }
      // Overlay: registry expired → override discovered status
      if (entry.cliAuthStatus === "expired") {
        acct.cliAuthStatus = "expired";
      }
    }
    result.push(acct);
  }

  // Append registry-only expired accounts (probe-confirmed only)
  for (const entry of registry) {
    if (!discoveredIds.has(entry.id) && entry.cliAuthStatus === "expired") {
      result.push({
        id: entry.id,
        email: entry.email,
        serverKey: entry.serverKey,
        serverHost: entry.serverHost || "",
        orgDomain: entry.orgDomain,
        orgId: entry.orgId || null,
        userId: entry.userId || null,
        jwtExp: entry.jwtExp,
        cliAuthStatus: "expired",
        lastCheckedAt: entry.lastProbeAt,
        _fromRegistry: true,
      });
    }
  }

  if (dirty) saveRegistry(registry);

  return result;
}

// --- Public API ---

function getStatus(accountId) {
  const registry = loadRegistry();
  const entry = registry.find((r) => r.id === accountId);
  if (!entry) return null;
  if (entry.cliAuthStatus === "unknown") return null;
  return entry.cliAuthStatus;
}

function markRefreshed(accountId) {
  const registry = loadRegistry();
  const entry = registry.find((r) => r.id === accountId);
  if (entry) {
    entry.cliAuthStatus = "active";
    entry.lastSuccessfulDiscovery = new Date().toISOString();
    saveRegistry(registry);
    logger.log("info", "auth-health",
      `Account ${redactEmail(entry.email)} on ${entry.serverKey}: manually marked refreshed`);
  }
  drCli.invalidateAccountsCache();
}

function start() {
  seedRegistryIfEmpty();
  _initialTimer = setTimeout(() => {
    runCheck();
    _timer = setInterval(runCheck, AUTH_CHECK_INTERVAL_MS);
  }, AUTH_CHECK_INITIAL_DELAY_MS);
  logger.log("info", "auth-health", "Auth health checker started");
}

function stop() {
  if (_initialTimer) { clearTimeout(_initialTimer); _initialTimer = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start,
  stop,
  getStatus,
  mergeWithDiscovered,
  markRefreshed,
  runCheck,
  classifyProbeResult,
};
