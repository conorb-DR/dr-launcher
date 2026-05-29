const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
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
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Liveness probe cadence (Hybrid). A liveness probe is a REAL authenticated API
// call (see drCli.probeLiveness) — it has a server cost and renews the session,
// so we don't run it every cycle for every account. Accounts with an active
// launched session are re-probed frequently; idle accounts are re-probed
// occasionally so their badge is still reasonably fresh.
const LIVENESS_STALE_ACTIVE_MS = 5 * 60 * 1000;   // active-session accounts: every ~5 min
const LIVENESS_STALE_IDLE_MS = 30 * 60 * 1000;    // idle accounts: every ~30 min

// Failure-log throttle: don't spam the log with the same probe failure.
const FAILURE_LOG_THROTTLE_MS = 60 * 60 * 1000;

// The authoritative DEAD signal — a pre-flight JWT REFRESH failure, surfaced by
// a real API call when the refresh token has died (~8-day inactivity). These are
// deliberately narrow: a generic "HTTP 401"/"unauthorized" can also be a
// post-refresh PERMISSION error on a live session, which must NOT be treated as
// expired. We only flip to expired on a refresh/session death.
const REFRESH_DEATH_PATTERNS = [
  "jwt auto-refresh failed",
  "refresh failed",
  "jwt refresh: http",
  "mint-via-session failed",
  "session expired",
  "not logged in",
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

// Parse a stored timestamp (ISO string or epoch-ms) to epoch-ms, or null when
// missing/invalid. Never treat null as 0 in a staleness comparison without
// intent — here a null "last probe" means "never probed" ⇒ due now.
function parseTimestamp(v) {
  if (v == null) return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function failureFingerprint(detail) {
  return crypto.createHash("sha1").update(String(detail)).digest("hex").slice(0, 12);
}

// --- Startup seeding ---

function seedRegistryIfEmpty() {
  const registry = loadRegistry();
  if (registry.length > 0) return;

  const seen = new Set();
  const seeded = [];

  const seedFrom = (id, email, serverKey, orgDomain, orgId) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    seeded.push({
      id, email: email || "", serverKey: serverKey || "", serverHost: "",
      orgDomain: orgDomain || "", orgId: orgId || null, userId: null, jwtExp: null,
      isSupport: null,
      cliAuthStatus: "unknown",
      lastLivenessProbeAt: null, lastSuccessfulProbeAt: null, lastProbeResult: null,
    });
  };

  for (const s of sessions.getVisibleSessions()) seedFrom(s.accountId, s.email, s.serverKey, s.orgDomain, s.orgId);
  for (const h of history.getRecents(50)) seedFrom(h.accountId, h.email, h.serverKey, h.orgDomain, null);

  if (seeded.length > 0) {
    saveRegistry(seeded);
    logger.log("info", "auth-health", `Seeded registry with ${seeded.length} account(s) from sessions/history`);
  }
}

// --- Probe classification (detail only — never a status) ---
//
// Classifies the result of a REAL liveness probe (drCli.probeLiveness):
//   "ok"           — exit 0; the pre-flight refresh succeeded ⇒ session alive
//                    (and just renewed).
//   "auth-failure" — the pre-flight JWT refresh failed (REFRESH_DEATH_PATTERNS)
//                    ⇒ the refresh token has died. THE authoritative expiry.
//   "timeout"      — the probe timed out (transient; do not flip).
//   "error"        — any other non-zero exit (e.g. a post-refresh permission
//                    error on a LIVE session) ⇒ do not flip.
function classifyProbeResult(result) {
  if (result.timedOut) return "timeout";
  if (result.exitCode === 0) return "ok";
  const combined = ((result.stdout || "") + " " + (result.stderr || "")).toLowerCase();
  if (REFRESH_DEATH_PATTERNS.some((p) => combined.includes(p))) return "auth-failure";
  // Non-zero exit but real JSON came back ⇒ the pre-flight refresh succeeded and
  // data was fetched, so the session is ALIVE; the non-zero is some other
  // post-refresh condition (a warning, a partial, a CLI quirk). Treat as ok
  // rather than masking a live session as an ambiguous error.
  const out = (result.stdout || "").trim();
  if (out.startsWith("[") || out.startsWith("{")) return "ok";
  return "error";
}

// --- Liveness decision ---
//
// Maps a probe outcome to a status change. A successful real probe is active; a
// refresh-death is expired (authoritative — this is the true ~8-day signal);
// transient failures (timeout/error) leave the status unchanged so a network
// blip or a post-refresh permission error never produces a false badge.
function classifyLiveness(probe) {
  if (probe === "ok") return "active";
  if (probe === "auth-failure") return "expired";
  return "unchanged";
}

function logProbeFailure(entry, probe, result, now) {
  const rawDetail = ((result.stdout || "") + " " + (result.stderr || "")).trim();
  const detail = logger.redactText(rawDetail).slice(0, 200);
  const fp = failureFingerprint(detail);
  const lastLog = parseTimestamp(entry.lastFailureLogAt);
  if (entry.lastFailureFingerprint === fp && lastLog !== null && now - lastLog <= FAILURE_LOG_THROTTLE_MS) {
    return;
  }
  logger.log("warn", "auth-health",
    `Liveness probe failure for ${redactEmail(entry.email)} on ${entry.serverKey} [${probe}]: ${detail}`);
  entry.lastFailureLogAt = new Date().toISOString();
  entry.lastFailureFingerprint = fp;
}

function clearFailureBookkeeping(entry) {
  delete entry.lastFailureLogAt;
  delete entry.lastFailureFingerprint;
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

  // Discovery (offline `dr whoami`) only ENUMERATES accounts + refreshes their
  // identity metadata. It is NOT a liveness signal — whoami succeeds even for a
  // dead session — so it never sets cliAuthStatus. Status changes only via a
  // real liveness probe below.
  for (const acct of discovered) {
    let entry = registryMap.get(acct.id);
    if (!entry) {
      entry = {
        id: acct.id, cliAuthStatus: "unknown",
        lastLivenessProbeAt: null, lastSuccessfulProbeAt: null, lastProbeResult: null,
      };
      registryMap.set(acct.id, entry);
    }
    entry.email = acct.email;
    entry.serverKey = acct.serverKey;
    entry.serverHost = acct.serverHost;
    entry.orgDomain = acct.orgDomain;
    entry.orgId = acct.orgId;
    entry.userId = acct.userId;
    entry.jwtExp = acct.jwtExp; // metadata only
    entry.isSupport = acct.isSupport;
  }

  // Pick which accounts get a REAL liveness probe this cycle (Hybrid cadence):
  // active-session accounts frequently, idle accounts occasionally.
  const now = Date.now();
  const activeSessIds = new Set(sessions.getActiveSessions().map((s) => s.accountId));
  const toProbe = [];
  for (const entry of registryMap.values()) {
    if (!entry.serverKey || !entry.email) continue;
    const lastProbe = parseTimestamp(entry.lastLivenessProbeAt) ?? 0;
    const staleMs = activeSessIds.has(entry.id) ? LIVENESS_STALE_ACTIVE_MS : LIVENESS_STALE_IDLE_MS;
    if (now - lastProbe > staleMs) toProbe.push(entry);
  }
  // Active-session accounts first.
  toProbe.sort((a, b) => (activeSessIds.has(a.id) ? 0 : 1) - (activeSessIds.has(b.id) ? 0 : 1));

  let transitioned = false;
  for (let i = 0; i < toProbe.length; i += PROBE_CONCURRENCY) {
    const batch = toProbe.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const result = await drCli.probeLiveness(entry.serverKey, entry.email, { timeout: 20000 });
        return { entry, result };
      })
    );

    for (const { entry, result } of results) {
      const probe = classifyProbeResult(result);
      const status = classifyLiveness(probe);
      entry.lastLivenessProbeAt = new Date().toISOString();
      entry.lastProbeResult = probe;

      if (probe === "ok") {
        entry.lastSuccessfulProbeAt = new Date().toISOString();
        clearFailureBookkeeping(entry);
      } else {
        logProbeFailure(entry, probe, result, now);
      }

      if (status !== "unchanged" && status !== entry.cliAuthStatus) {
        const prev = entry.cliAuthStatus;
        entry.cliAuthStatus = status;
        transitioned = true;
        if (status === "expired") {
          logger.log("warn", "auth-health",
            `Account ${redactEmail(entry.email)} on ${entry.serverKey}: ${prev} → expired (refresh token dead)`);
        } else {
          logger.log("info", "auth-health",
            `Account ${redactEmail(entry.email)} on ${entry.serverKey}: ${prev} → active`);
        }
      }
    }
  }

  // Prune very old, non-expired entries we haven't seen succeed in a long time.
  const pruned = [...registryMap.values()].filter((entry) => {
    if (entry.cliAuthStatus === "expired") return true;
    const lastOk = parseTimestamp(entry.lastSuccessfulProbeAt) ?? 0;
    if (now - lastOk > PRUNE_AGE_MS && !activeSessIds.has(entry.id)) return false;
    return true;
  });

  saveRegistry(pruned);

  if (transitioned) drCli.invalidateAccountsCache();
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

// --- On-demand liveness probe (used at launch / manual refresh) ---
//
// Runs a real liveness probe for ONE account right now and persists the result.
// Returns the resulting cliAuthStatus ("active" | "expired" | "unknown").
async function probeAccountNow(accountId) {
  const registry = loadRegistry();
  const entry = registry.find((r) => r.id === accountId);
  if (!entry || !entry.serverKey || !entry.email) return null;

  let result;
  try {
    result = await drCli.probeLiveness(entry.serverKey, entry.email, { timeout: 20000 });
  } catch (err) {
    logger.log("warn", "auth-health", `On-demand probe failed to run: ${err.message}`);
    return entry.cliAuthStatus;
  }
  const probe = classifyProbeResult(result);
  const status = classifyLiveness(probe);
  entry.lastLivenessProbeAt = new Date().toISOString();
  entry.lastProbeResult = probe;
  if (probe === "ok") { entry.lastSuccessfulProbeAt = new Date().toISOString(); clearFailureBookkeeping(entry); }
  else { logProbeFailure(entry, probe, result, Date.now()); }
  if (status !== "unchanged") entry.cliAuthStatus = status;

  saveRegistry(registry);
  drCli.invalidateAccountsCache();
  return entry.cliAuthStatus;
}

// --- Merge for /api/accounts ---

function mergeWithDiscovered(discoveredAccounts) {
  const registry = loadRegistry();
  const regMap = new Map(registry.map((r) => [r.id, r]));
  const discoveredIds = new Set(discoveredAccounts.map((a) => a.id));
  const result = [];

  for (const acct of discoveredAccounts) {
    const entry = regMap.get(acct.id);
    // Overlay the probe-derived status. Only "expired" is authoritative here
    // (it came from a real refresh-death probe). We do NOT clear "expired" based
    // on discovery — `dr whoami` is offline and cannot prove the session alive;
    // only a successful real probe (runCheck / probeAccountNow) clears it.
    if (entry && entry.cliAuthStatus === "expired") {
      acct.cliAuthStatus = "expired";
    }
    result.push(acct);
  }

  // Append registry-only expired accounts (probe-confirmed) that dropped out of
  // discovery entirely.
  for (const entry of registry) {
    if (!discoveredIds.has(entry.id) && entry.cliAuthStatus === "expired") {
      result.push({
        id: entry.id, email: entry.email, serverKey: entry.serverKey,
        serverHost: entry.serverHost || "", orgDomain: entry.orgDomain,
        orgId: entry.orgId || null, userId: entry.userId || null, jwtExp: entry.jwtExp,
        isSupport: typeof entry.isSupport === "boolean" ? entry.isSupport : null,
        cliAuthStatus: "expired", lastCheckedAt: entry.lastLivenessProbeAt, _fromRegistry: true,
      });
    }
  }

  return result;
}

// Persist account metadata (isSupport + identity) from a discovery result
// IMMEDIATELY, so the launch guard / visibility filter never lag behind the list
// the user just saw (the background _runCheckImpl also keeps it fresh).
function recordDiscoveredMeta(discoveredAccounts) {
  const registry = loadRegistry();
  const map = new Map(registry.map((r) => [r.id, r]));
  let dirty = false;
  for (const acct of discoveredAccounts || []) {
    if (!acct || !acct.id) continue;
    let entry = map.get(acct.id);
    if (!entry) {
      entry = {
        id: acct.id, cliAuthStatus: "unknown",
        lastLivenessProbeAt: null, lastSuccessfulProbeAt: null, lastProbeResult: null,
      };
      registry.push(entry); map.set(acct.id, entry); dirty = true;
    }
    if (entry.isSupport !== acct.isSupport) { entry.isSupport = acct.isSupport; dirty = true; }
    entry.email = acct.email; entry.serverKey = acct.serverKey; entry.serverHost = acct.serverHost;
    entry.orgDomain = acct.orgDomain; entry.orgId = acct.orgId; entry.userId = acct.userId;
    entry.jwtExp = acct.jwtExp;
  }
  if (dirty) saveRegistry(registry);
}

// --- Public API ---

// Registry-known support flag: true | false | null (unknown).
function isSupportAccount(accountId) {
  const registry = loadRegistry();
  const entry = registry.find((r) => r.id === accountId);
  return entry && typeof entry.isSupport === "boolean" ? entry.isSupport : null;
}

// Resolve support-ness for the launch policy, FAIL-CLOSED: use the registry; if
// unknown, do a trusted dr lookup (`getAccountDetails`) and persist; if still
// unknown, return null so the caller refuses the launch unless showAll is on.
async function resolveIsSupport(accountId, { serverKey, email } = {}) {
  const known = isSupportAccount(accountId);
  if (known === true || known === false) return known;
  if (!serverKey || !email) return null;
  let detail;
  try {
    detail = await drCli.getAccountDetails(serverKey, email);
  } catch {
    return null;
  }
  if (!detail || typeof detail.isSupport !== "boolean") return null;
  const registry = loadRegistry();
  let entry = registry.find((r) => r.id === accountId);
  if (!entry) {
    entry = {
      id: accountId, cliAuthStatus: "unknown",
      lastLivenessProbeAt: null, lastSuccessfulProbeAt: null, lastProbeResult: null,
    };
    registry.push(entry);
  }
  entry.isSupport = detail.isSupport;
  entry.email = entry.email || email;
  entry.serverKey = entry.serverKey || serverKey;
  saveRegistry(registry);
  return detail.isSupport;
}

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
    entry.lastSuccessfulProbeAt = new Date().toISOString();
    clearFailureBookkeeping(entry);
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
  probeAccountNow,
  recordDiscoveredMeta,
  isSupportAccount,
  resolveIsSupport,
  classifyProbeResult,
  classifyLiveness,
};
