const fs = require("fs");
const path = require("path");
const os = require("os");

const PREFS_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);
const PREFS_PATH = path.join(PREFS_DIR, "preferences.json");

const SCHEMA = {
  theme: { type: "string", values: ["light", "dark"], default: "light" },
  favoriteIds: { type: "string[]", maxLength: 500, default: [] },
  collapsedServers: { type: "string[]", maxLength: 20, default: [] },
};

const SYNCABLE_KEYS = Object.keys(SCHEMA);

function defaults() {
  const out = {};
  for (const [key, def] of Object.entries(SCHEMA)) {
    out[key] = def.default;
  }
  return out;
}

function validate(data) {
  if (!data || typeof data !== "object") return defaults();
  const out = {};
  for (const [key, def] of Object.entries(SCHEMA)) {
    const val = data[key];
    if (def.type === "string") {
      if (typeof val === "string" && (!def.values || def.values.includes(val))) {
        out[key] = val;
      } else {
        out[key] = def.default;
      }
    } else if (def.type === "string[]") {
      if (Array.isArray(val)) {
        out[key] = val.filter((v) => typeof v === "string").slice(0, def.maxLength);
      } else {
        out[key] = def.default;
      }
    }
  }
  return out;
}

function getPreferences() {
  try {
    const raw = fs.readFileSync(PREFS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const validated = validate(parsed);
    validated.updatedAt = parsed.updatedAt || null;
    validated.dirty = parsed.dirty === true;
    return validated;
  } catch {
    return { ...defaults(), updatedAt: null, dirty: false };
  }
}

function updatePreferences(partial) {
  const current = getPreferences();
  const validPartial = validate({ ...current, ...partial });
  const merged = {
    ...validPartial,
    updatedAt: new Date().toISOString(),
    dirty: true,
  };
  writePrefs(merged);
  return merged;
}

function markClean() {
  const current = getPreferences();
  current.dirty = false;
  writePrefs(current);
}

function applyRemote(remotePrefs) {
  const validated = validate(remotePrefs);
  const merged = {
    ...validated,
    updatedAt: remotePrefs.updatedAt || new Date().toISOString(),
    dirty: false,
  };
  writePrefs(merged);
  return merged;
}

function writePrefs(data) {
  fs.mkdirSync(PREFS_DIR, { recursive: true });
  const tmpPath = PREFS_PATH + ".tmp." + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, PREFS_PATH);
}

function syncableSnapshot() {
  const prefs = getPreferences();
  const out = {};
  for (const key of SYNCABLE_KEYS) {
    out[key] = prefs[key];
  }
  out.updatedAt = prefs.updatedAt;
  return out;
}

module.exports = {
  PREFS_PATH,
  SYNCABLE_KEYS,
  getPreferences,
  updatePreferences,
  validate,
  markClean,
  applyRemote,
  syncableSnapshot,
  defaults,
};
