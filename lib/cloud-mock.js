const fs = require("fs");
const path = require("path");
const os = require("os");

const MOCK_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);
const MOCK_PATH = path.join(MOCK_DIR, "cloud-mock.json");

let writeQueue = Promise.resolve();

function readStore() {
  try {
    const raw = fs.readFileSync(MOCK_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeStore(data) {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
  const tmpPath = MOCK_PATH + ".tmp." + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, MOCK_PATH);
}

function enqueue(fn) {
  writeQueue = writeQueue.then(fn).catch(() => {});
  return writeQueue;
}

async function getPreferences(userId) {
  const store = readStore();
  return store[userId]?.preferences || null;
}

async function putPreferences(userId, prefs) {
  return enqueue(() => {
    const store = readStore();
    if (!store[userId]) store[userId] = {};
    store[userId].preferences = { ...prefs };
    writeStore(store);
  });
}

async function getHistory(userId) {
  const store = readStore();
  return store[userId]?.history || [];
}

async function putHistory(userId, entries) {
  return enqueue(() => {
    const store = readStore();
    if (!store[userId]) store[userId] = {};
    store[userId].history = entries;
    writeStore(store);
  });
}

async function upsertHistoryEntries(userId, newEntries) {
  return enqueue(() => {
    const store = readStore();
    if (!store[userId]) store[userId] = {};
    const existing = store[userId].history || [];
    const ids = new Set(existing.map((e) => e.launchId));
    for (const entry of newEntries) {
      if (!ids.has(entry.launchId)) {
        existing.unshift(entry);
        ids.add(entry.launchId);
      }
    }
    existing.sort((a, b) => (b.launchedAt || "").localeCompare(a.launchedAt || ""));
    store[userId].history = existing.slice(0, 200);
    writeStore(store);
  });
}

async function getAppConfig(key) {
  const store = readStore();
  return store._appConfig?.[key] || null;
}

module.exports = {
  MOCK_PATH,
  getPreferences,
  putPreferences,
  getHistory,
  putHistory,
  upsertHistoryEntries,
  getAppConfig,
};
