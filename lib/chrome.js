const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Isolated Chrome data dirs — does NOT touch the user's normal Chrome profiles
const PROFILE_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher",
  "ChromeProfiles"
);

/**
 * Find Chrome executable from common install locations.
 * Respects CHROME_PATH env var as override.
 */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const candidates = [
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ];

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // try next
    }
  }

  // Fall back to bare name — let the OS resolve it
  return "chrome.exe";
}

/**
 * Build a slug from server key + domain for the profile directory name.
 * US2:ai.exercise.shachar.com → us2-ai-exercise-shachar-com
 */
function profileSlug(serverKey, orgDomain) {
  const raw = `${serverKey}-${orgDomain}`;
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Get the user-data-dir path for a customer.
 */
function profilePath(serverKey, orgDomain) {
  const slug = profileSlug(serverKey, orgDomain);
  return path.join(PROFILE_ROOT, slug);
}

/**
 * Launch Chrome with an isolated user-data-dir for this customer.
 * Chrome creates the directory on first launch if it doesn't exist.
 */
function launchChrome(account) {
  const chromePath = findChrome();
  const userDataDir = profilePath(account.serverKey, account.orgDomain);
  const url = account.serverHost;

  // Ensure parent directory exists
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });

  const child = spawn(chromePath, [
    `--user-data-dir=${userDataDir}`,
    "--new-window",
    url,
  ], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  return {
    profilePath: userDataDir,
    url,
    chromePath,
    pid: child.pid || null,
  };
}

/**
 * Check if Chrome is findable on this system.
 */
function chromeAvailable() {
  const chromePath = findChrome();
  try {
    fs.accessSync(chromePath, fs.constants.X_OK);
    return { available: true, path: chromePath };
  } catch {
    if (chromePath === "chrome.exe") {
      try {
        execSync("where chrome.exe", { stdio: "ignore" });
        return { available: true, path: chromePath };
      } catch {
        return { available: false, path: null };
      }
    }
    return { available: false, path: chromePath };
  }
}

module.exports = {
  findChrome,
  launchChrome,
  chromeAvailable,
  profilePath,
  profileSlug,
  PROFILE_ROOT,
};
