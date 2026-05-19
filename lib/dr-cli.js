const { exec, execSync } = require("child_process");
const path = require("path");

// Fixed server whitelist — never allow arbitrary server keys into shell commands
const SERVERS = {
  US:    "https://app.datarails.com",
  US2:   "https://us-2.datarails.com",
  UK:    "https://ukapp.datarails.com",
  CA:    "https://caapp.datarails.com",
  DEV:   "https://dev.datarails.com",
  "DEV-1": "https://dev-1.datarails.com",
  TEST:  "https://testapp.datarails.com",
  DEMO:  "https://demoapp.datarails.com",
};

function validateServer(key) {
  const upper = (key || "").trim().toUpperCase();
  if (!SERVERS[upper]) throw new Error(`Unknown server key: ${key}`);
  return upper;
}

function serverHost(key) {
  return SERVERS[validateServer(key)];
}

function serverKeys() {
  return Object.keys(SERVERS);
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
    const isExpired = expUnix ? (Date.now() / 1000) > expUnix : true;

    return {
      id: `${key}:${email}`,
      email,
      serverKey: key,
      serverHost: SERVERS[key],
      orgId: claims.organization_id || null,
      orgDomain: extractDomain(email),
      userId: data.user_id || claims.user_id || claims.sub || null,
      role: claims.role || null,
      isSupport: claims.is_support === true,
      cliAuthStatus: isExpired ? "expired" : "active",
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

/**
 * Discover all authenticated accounts across all servers.
 * Returns array of customer context objects.
 */
async function discoverAccounts(specificServers) {
  const keys = specificServers || Object.keys(SERVERS);
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
          const isExpired = expUnix ? (Date.now() / 1000) > expUnix : true;

          return [{
            id: `${key}:${email}`,
            email,
            serverKey: key,
            serverHost: SERVERS[key],
            orgId: claims.organization_id || null,
            orgDomain: extractDomain(email),
            userId: data.user_id || claims.user_id || claims.sub || null,
            role: claims.role || null,
            isSupport: claims.is_support === true,
            cliAuthStatus: isExpired ? "expired" : "active",
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

function resetDrCache() {
  _hasDr = null;
}

module.exports = {
  SERVERS,
  validateServer,
  serverHost,
  serverKeys,
  discoverAccounts,
  getAccountDetails,
  startLogin,
  parseMultiAccountList,
  extractDomain,
  hasDrCli,
  resetDrCache,
};
