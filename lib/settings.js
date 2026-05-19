const fs = require("fs");
const path = require("path");
const os = require("os");
const preferences = require("./preferences");
const history = require("./history");

const SETTINGS_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);

const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");

const DEFAULTS = {
  useVirtualDesktops: false,
  activeSessions: [],
};

const PREFERENCE_KEYS = preferences.SYNCABLE_KEYS;

function migrateIfNeeded() {
  if (fs.existsSync(preferences.PREFS_PATH)) return;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const prefData = {};
    let migrated = false;
    for (const key of PREFERENCE_KEYS) {
      if (key in parsed) {
        prefData[key] = parsed[key];
        delete parsed[key];
        migrated = true;
      }
    }
    if (Array.isArray(parsed.recentLaunches)) {
      for (const r of parsed.recentLaunches) {
        if (r && (r.id || r.accountId)) {
          history.addEntry({
            launchId: `migrated-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            accountId: r.accountId || r.id,
            orgDomain: r.orgDomain || "",
            serverKey: r.serverKey || "",
            email: r.email || "",
            launchedAt: r.launchedAt || r.at || new Date().toISOString(),
          });
        }
      }
      delete parsed.recentLaunches;
      migrated = true;
    }
    if (migrated) {
      preferences.updatePreferences(prefData);
      const tmpPath = SETTINGS_PATH + ".tmp." + Date.now();
      fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), "utf8");
      fs.renameSync(tmpPath, SETTINGS_PATH);
    }
  } catch {
    // No settings file or parse error — nothing to migrate
  }
}

function getSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function getSettingsWithPreferences() {
  const s = getSettings();
  const p = preferences.getPreferences();
  return { ...s, ...p };
}

function updateSettings(partial) {
  const current = getSettings();
  const prefUpdate = {};
  const localUpdate = {};
  for (const [key, val] of Object.entries(partial)) {
    if (PREFERENCE_KEYS.includes(key)) {
      prefUpdate[key] = val;
    } else {
      localUpdate[key] = val;
    }
  }
  if (Object.keys(prefUpdate).length > 0) {
    preferences.updatePreferences(prefUpdate);
  }
  const merged = { ...current, ...localUpdate };
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const tmpPath = SETTINGS_PATH + ".tmp." + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
  fs.renameSync(tmpPath, SETTINGS_PATH);
  return { ...merged, ...preferences.getPreferences() };
}

module.exports = {
  SETTINGS_PATH,
  getSettings,
  getSettingsWithPreferences,
  updateSettings,
  migrateIfNeeded,
};
