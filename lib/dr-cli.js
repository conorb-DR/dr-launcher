const { exec, execSync } = require("child_process");
const path = require("path");
const servers = require("./servers");

function validateServer(key) {
  return servers.validateKey(key);
}

function serverHost(key) {
  return servers.serverHost(key);
}

function serverKeys() {
  return servers.getServerList().map((s) => s.key);
}

/**
 * Run a dr CLI command. Returns { stdout, stderr, exitCode }.
 * Exit code 1 is NOT treated as fatal — dr uses it for "not logged in"
 * and "multiple accounts" which are both useful responses.
 */
function execDr(args) {
  // Build a safe command string — server keys and emails are validated upstream
  const cmd = "dr " + args.map((a) => `"${a}"`).join(" ");
  return new Promise((resolve) => {
    exec(cmd, { encoding: "utf8", timeout: 15000 }, (err, stdout, stderr) => {
      resolve({
        stdout: (stdout || "").trim(),
        stderr: (stderr || (err && err.stderr) || "").trim(),
        exitCode: err ? (err.code || 1) : 0,
      });
    });
  });
}

/**
 * Parse the multi-account list from dr whoami stderr.
 * Example:
 *   error: multiple accounts stored for US2. specify --account <email>:
 *     - support@ai.exercise.shachar.com (last used 2026-05-18)
 *     - support@ai-exercise.johnstanton.com (last used 2026-05-18)
 */
function parseMultiAccountList(text) {
  const accounts = [];
  const regex = /^\s+-\s+(\S+)\s+\(last used (.+?)\)/gm;
  let match;
  while ((match = regex.exec(text)) !== null) {
    accounts.push({ email: match[1], lastUsed: match[2] });
  }
  return accounts;
}

/**
 * Get full claims for a single account via dr whoami --json.
 */
async function getAccountDetails(serverKey, email) {
  const key = validateServer(serverKey);
  const result = await execDr(["whoami", "--server", key, "--account", email, "--json"]);

  if (result.exitCode !== 0) {
    return null;
  }

  try {
    const data = JSON.parse(result.stdout);
    const claims = data.claims || {};
    const expUnix = typeof claims.exp === "number" ? claims.exp : null;

    return {
      id: `${key}:${email}`,
      email,
      serverKey: key,
      serverHost: servers.serverHost(key),
      orgId: claims.organization_id || null,
      orgDomain: extractDomain(email),
      userId: data.user_id || claims.user_id || claims.sub || null,
      role: claims.role || null,
      isSupport: claims.is_support === true,
      cliAuthStatus: "active",
      jwtExp: expUnix,
      lastCheckedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Extract a friendly domain from an email.
 * support@ai.exercise.shachar.com → ai.exercise.shachar.com
 */
function extractDomain(email) {
  const parts = (email || "").split("@");
  return parts.length === 2 ? parts[1] : email;
}

let _accountsCache = { data: null, fetchedAt: 0, inflight: null };
const CACHE_TTL_MS = 60_000;

function invalidateAccountsCache() {
  _accountsCache.fetchedAt = 0;
}

async function discoverAccounts(specificServers) {
  const now = Date.now();
  if (!specificServers && _accountsCache.data && (now - _accountsCache.fetchedAt) < CACHE_TTL_MS) {
    return _accountsCache.data;
  }
  if (!specificServers && _accountsCache.inflight) {
    return _accountsCache.inflight;
  }
  const promise = _discoverAccountsImpl(specificServers);
  if (!specificServers) {
    _accountsCache.inflight = promise;
    try {
      const result = await promise;
      _accountsCache = { data: result, fetchedAt: Date.now(), inflight: null };
      return result;
    } catch (err) {
      _accountsCache.inflight = null;
      throw err;
    }
  }
  return promise;
}

async function _discoverAccountsImpl(specificServers) {
  const keys = specificServers || serverKeys();
  const allAccounts = [];

  const results = await Promise.all(
    keys.map(async (key) => {
      const result = await execDr(["whoami", "--server", key]);
      const combined = result.stdout + "\n" + result.stderr;

      // Not logged in at all
      if (/not logged in/i.test(combined)) {
        return [];
      }

      // Multiple accounts
      if (/multiple accounts stored/i.test(combined)) {
        const parsed = parseMultiAccountList(combined);
        // Get full details for each, with concurrency cap
        const details = [];
        for (const acct of parsed) {
          const detail = await getAccountDetails(key, acct.email);
          if (detail) {
            detail.lastUsed = acct.lastUsed;
            details.push(detail);
          }
        }
        return details;
      }

      // Single account — try JSON
      const jsonResult = await execDr(["whoami", "--server", key, "--json"]);
      if (jsonResult.exitCode === 0) {
        try {
          const data = JSON.parse(jsonResult.stdout);
          const claims = data.claims || {};
          const email = data.email || claims.email || "";
          const expUnix = typeof claims.exp === "number" ? claims.exp : null;

          return [{
            id: `${key}:${email}`,
            email,
            serverKey: key,
            serverHost: servers.serverHost(key),
            orgId: claims.organization_id || null,
            orgDomain: extractDomain(email),
            userId: data.user_id || claims.user_id || claims.sub || null,
            role: claims.role || null,
            isSupport: claims.is_support === true,
            cliAuthStatus: "active",
            jwtExp: expUnix,
            lastUsed: new Date().toISOString().slice(0, 10),
            lastCheckedAt: new Date().toISOString(),
          }];
        } catch {
          return [];
        }
      }

      return [];
    })
  );

  for (const group of results) {
    allAccounts.push(...group);
  }

  return allAccounts;
}

/**
 * Start a dr login process. Returns the spawned child process.
 * The caller should poll discoverAccounts to detect completion.
 */
function startLogin(serverKey) {
  const key = validateServer(serverKey);
  const { spawn } = require("child_process");
  const child = spawn("cmd", ["/c", "dr", "login", "--server", key], {
    stdio: "pipe",
    detached: false,
  });
  return child;
}

/**
 * Probe a specific account's auth health via dr whoami --json.
 * Returns enriched result with timedOut/signal for error classification.
 */
async function probeWhoami(serverKey, email, opts = {}) {
  const key = validateServer(serverKey);
  const timeout = opts.timeout || 20000;
  const cmd = "dr " + ["whoami", "--server", key, "--account", email, "--json"]
    .map((a) => `"${a}"`).join(" ");
  return new Promise((resolve) => {
    exec(cmd, { encoding: "utf8", timeout }, (err, stdout, stderr) => {
      resolve({
        stdout: (stdout || "").trim(),
        stderr: (stderr || (err && err.stderr) || "").trim(),
        exitCode: err ? (err.code || 1) : 0,
        timedOut: !!(err && err.killed),
        signal: err?.signal || null,
      });
    });
  });
}

let _hasDr = null;
function hasDrCli() {
  if (_hasDr !== null) return _hasDr;
  try {
    execSync("where dr", { stdio: "ignore" });
    _hasDr = true;
  } catch {
    _hasDr = false;
  }
  return _hasDr;
}

function getDrVersion() {
  try {
    return execSync("dr --version", { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function resetDrCache() {
  _hasDr = null;
}

module.exports = {
  validateServer,
  serverHost,
  serverKeys,
  discoverAccounts,
  invalidateAccountsCache,
  getAccountDetails,
  probeWhoami,
  startLogin,
  parseMultiAccountList,
  extractDomain,
  hasDrCli,
  getDrVersion,
  resetDrCache,
};
