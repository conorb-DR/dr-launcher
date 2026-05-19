const { execFile } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const logger = require("./log");

const SCRIPT_PATH = path.join(__dirname, "scripts", "vdesktop.ps1");
const PS_ARGS_BASE = [
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", SCRIPT_PATH,
];

// --- Launch serialization lock ---
let _launchInProgress = false;

function isLaunchInProgress() {
  return _launchInProgress;
}

function acquireLaunchLock() {
  if (_launchInProgress) return false;
  _launchInProgress = true;
  return true;
}

function releaseLaunchLock() {
  _launchInProgress = false;
}

/**
 * Generate a short unique launch transaction ID.
 */
function generateLaunchId() {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Run the vdesktop.ps1 script with given arguments.
 * Returns parsed JSON result.
 */
function runScript(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const fullArgs = [...PS_ARGS_BASE, ...args];
    execFile("powershell.exe", fullArgs, {
      encoding: "utf8",
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      const output = (stdout || "").trim();
      if (err) {
        logger.log("error", "vdesktop", `Script error: code=${err.code} killed=${err.killed} signal=${err.signal}`, {
          stderr: (stderr || "").trim().slice(0, 500),
          stdout: output.slice(0, 500),
        });
      }
      if (!output) {
        const errMsg = (stderr || "").trim() || (err ? err.message : "No output from script");
        resolve({ ok: false, error: errMsg });
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch (parseErr) {
        resolve({ ok: false, error: `JSON parse error: ${parseErr.message}`, raw: output.slice(0, 500) });
      }
    });
  });
}

// --- Cached availability check ---
let _availability = null;

/**
 * Check if virtual desktop support is available.
 * Tests module import, COM access, and basic operations.
 */
async function checkAvailability() {
  const result = await runScript(["-Action", "check"]);
  _availability = result;
  return result;
}

async function isAvailable() {
  if (_availability !== null) return _availability.ok === true;
  const result = await checkAvailability();
  return result.ok === true;
}

function getCachedAvailability() {
  return _availability;
}

/**
 * Snapshot current Chrome and Terminal window handles.
 */
async function snapshotWindows() {
  return runScript(["-Action", "snapshot"]);
}

/**
 * Create (or reuse) a virtual desktop, poll for new windows,
 * move them, verify, and switch.
 *
 * @param {Object} opts
 * @param {string} opts.name - Desktop name (e.g. "[US2] ai.exercise.shachar.com")
 * @param {number[]} opts.allHwndsBefore - ALL window handles before launch (used as baseline for newness detection)
 * @param {number} opts.chromePid - PID of the launched Chrome process
 * @param {number} opts.terminalPid - PID of the launched Terminal process
 * @param {string} opts.terminalTitleMatch - Unique string in terminal title (fallback when PID delegation occurs)
 * @param {number} [opts.pollTimeoutMs=5000]
 * @param {number} [opts.pollIntervalMs=300]
 */
async function createDesktopAndMoveWindows(opts) {
  const allHwnds = (opts.allHwndsBefore || []).join(",");
  const args = [
    "-Action", "launch",
    "-Name", opts.name || "",
    "-AllHwndsBefore", allHwnds || "none",
    "-ChromePid", String(opts.chromePid || 0),
    "-TerminalPid", String(opts.terminalPid || 0),
  ];

  if (opts.terminalTitleMatch) {
    args.push("-TerminalTitleMatch", opts.terminalTitleMatch);
  }

  if (opts.pollTimeoutMs) {
    args.push("-PollTimeoutMs", String(opts.pollTimeoutMs));
  }
  if (opts.pollIntervalMs) {
    args.push("-PollIntervalMs", String(opts.pollIntervalMs));
  }

  if (opts.noSwitch) {
    args.push("-NoSwitch");
  }

  // Allow more time for PS startup + polling + move/verify operations
  // PowerShell cold start can take 3-5s, plus Add-Type compilation ~2-3s
  const timeout = (opts.pollTimeoutMs || 5000) + 25000;
  return runScript(args, timeout);
}

async function switchToDesktop(name) {
  return runScript(["-Action", "switch", "-Name", name], 15000);
}

async function removeDesktopByName(name) {
  return runScript(["-Action", "delete", "-Name", name], 15000);
}

async function closeWindowsByHwnd(hwnds) {
  if (!hwnds || hwnds.length === 0) return { ok: true, closed: 0 };
  const csv = hwnds.join(",");
  return runScript(["-Action", "close", "-Hwnds", csv], 10000);
}

async function checkWindowsByHwnd(hwnds) {
  if (!hwnds || hwnds.length === 0) return { ok: true, valid: 0, invalid: 0, total: 0 };
  const csv = hwnds.join(",");
  return runScript(["-Action", "check-hwnd", "-Hwnds", csv], 10000);
}

module.exports = {
  isAvailable,
  checkAvailability,
  getCachedAvailability,
  snapshotWindows,
  createDesktopAndMoveWindows,
  switchToDesktop,
  removeDesktopByName,
  closeWindowsByHwnd,
  checkWindowsByHwnd,
  generateLaunchId,
  isLaunchInProgress,
  acquireLaunchLock,
  releaseLaunchLock,
  SCRIPT_PATH,
};
