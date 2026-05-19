const preferences = require("./preferences");
const history = require("./history");

function mergePreferences(local, remote) {
  if (!remote) return { action: "push", result: local };
  if (!local) return { action: "pull", result: remote };

  const localTime = local.updatedAt || "";
  const remoteTime = remote.updatedAt || "";

  if (local.dirty && localTime > remoteTime) {
    return { action: "push", result: local };
  }
  if (remoteTime > localTime) {
    return { action: "pull", result: remote };
  }
  return { action: "none", result: local };
}

function mergeHistory(local, remote) {
  if (!remote || remote.length === 0) return local || [];
  if (!local || local.length === 0) return remote;

  const combined = [...local, ...remote];
  const deduped = history.deduplicateByLaunchId(combined);
  deduped.sort((a, b) => (b.launchedAt || "").localeCompare(a.launchedAt || ""));
  return deduped.slice(0, history.MAX_ENTRIES);
}

let cloudBackend = null;
let userId = null;
let lastSyncedAt = null;
let syncError = null;

function setBackend(backend) {
  cloudBackend = backend;
}

function setUserId(id) {
  userId = id;
}

async function initialize(uid) {
  userId = uid;
  if (!cloudBackend) return { ok: false, error: "No cloud backend" };

  try {
    const [remotePrefs, remoteHistory] = await Promise.all([
      cloudBackend.getPreferences(userId),
      cloudBackend.getHistory(userId),
    ]);

    const localPrefs = preferences.getPreferences();
    const prefMerge = mergePreferences(localPrefs, remotePrefs);

    if (prefMerge.action === "pull") {
      preferences.applyRemote(prefMerge.result);
    } else if (prefMerge.action === "push") {
      await cloudBackend.putPreferences(userId, preferences.syncableSnapshot());
      preferences.markClean();
    }

    const localHistory = history.getHistory();
    const merged = mergeHistory(localHistory, remoteHistory);
    history.replaceHistory(merged);

    if (merged.length > 0) {
      await cloudBackend.putHistory(userId, merged);
    }

    lastSyncedAt = new Date().toISOString();
    syncError = null;
    return { ok: true, preferences: preferences.getPreferences() };
  } catch (err) {
    syncError = err.message;
    return { ok: false, error: err.message };
  }
}

async function pushPreferences() {
  if (!cloudBackend || !userId) return;
  try {
    const snapshot = preferences.syncableSnapshot();
    await cloudBackend.putPreferences(userId, snapshot);
    preferences.markClean();
    lastSyncedAt = new Date().toISOString();
  } catch {
    // Best-effort — dirty flag stays true
  }
}

async function pushHistoryEntry(entry) {
  if (!cloudBackend || !userId) return;
  try {
    await cloudBackend.upsertHistoryEntries(userId, [entry]);
    lastSyncedAt = new Date().toISOString();
  } catch {
    // Best-effort
  }
}

async function pullAndMerge() {
  if (!cloudBackend || !userId) {
    return { ok: false, error: "No cloud backend or user" };
  }

  try {
    const [remotePrefs, remoteHistory] = await Promise.all([
      cloudBackend.getPreferences(userId),
      cloudBackend.getHistory(userId),
    ]);

    const localPrefs = preferences.getPreferences();
    const prefMerge = mergePreferences(localPrefs, remotePrefs);

    if (prefMerge.action === "pull") {
      preferences.applyRemote(prefMerge.result);
    } else if (prefMerge.action === "push") {
      await cloudBackend.putPreferences(userId, preferences.syncableSnapshot());
      preferences.markClean();
    }

    const localHistory = history.getHistory();
    const merged = mergeHistory(localHistory, remoteHistory);
    history.replaceHistory(merged);
    await cloudBackend.putHistory(userId, merged);

    lastSyncedAt = new Date().toISOString();
    syncError = null;
    return { ok: true, preferences: preferences.getPreferences() };
  } catch (err) {
    syncError = err.message;
    return { ok: false, error: err.message };
  }
}

function getStatus() {
  return {
    lastSyncedAt,
    dirty: preferences.getPreferences().dirty,
    cloudAvailable: cloudBackend !== null,
    error: syncError,
  };
}

module.exports = {
  mergePreferences,
  mergeHistory,
  setBackend,
  setUserId,
  initialize,
  pushPreferences,
  pushHistoryEntry,
  pullAndMerge,
  getStatus,
};
