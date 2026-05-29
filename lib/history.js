const fs = require("fs");
const path = require("path");
const os = require("os");

const HISTORY_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);
const HISTORY_PATH = path.join(HISTORY_DIR, "history.json");
const MAX_ENTRIES = 200;

function getHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, "utf8");
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.filter(isValidEntry);
  } catch {
    return [];
  }
}

function addEntry(entry) {
  const validated = validateEntry(entry);
  if (!validated) return null;

  const history = getHistory();
  history.unshift(validated);
  const deduped = deduplicateByLaunchId(history);
  const capped = deduped.slice(0, MAX_ENTRIES);
  writeHistory(capped);
  return validated;
}

function getRecents(limit = 10) {
  const history = getHistory();
  const seen = new Set();
  const recents = [];
  for (const entry of history) {
    if (!seen.has(entry.accountId)) {
      seen.add(entry.accountId);
      recents.push(entry);
      if (recents.length >= limit) break;
    }
  }
  return recents;
}

function replaceHistory(entries) {
  const validated = entries.filter(isValidEntry).map(validateEntry);
  const deduped = deduplicateByLaunchId(validated);
  const sorted = deduped.sort((a, b) => (b.launchedAt || "").localeCompare(a.launchedAt || ""));
  const capped = sorted.slice(0, MAX_ENTRIES);
  writeHistory(capped);
  return capped;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const validated = {
    launchId: String(entry.launchId || ""),
    accountId: String(entry.accountId || ""),
    orgDomain: String(entry.orgDomain || ""),
    serverKey: String(entry.serverKey || ""),
    email: String(entry.email || ""),
    launchedAt: String(entry.launchedAt || new Date().toISOString()),
  };
  if (entry.agentId) validated.agentId = String(entry.agentId);
  return validated;
}

function isValidEntry(entry) {
  return entry && typeof entry === "object" && entry.accountId && entry.launchedAt;
}

function deduplicateByLaunchId(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    if (!e.launchId || seen.has(e.launchId)) return false;
    seen.add(e.launchId);
    return true;
  });
}

function writeHistory(entries) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const tmpPath = HISTORY_PATH + ".tmp." + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf8");
  fs.renameSync(tmpPath, HISTORY_PATH);
}

module.exports = {
  HISTORY_PATH,
  MAX_ENTRIES,
  getHistory,
  addEntry,
  getRecents,
  replaceHistory,
  deduplicateByLaunchId,
  validateEntry,
};
