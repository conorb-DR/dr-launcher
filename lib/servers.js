const fs = require("fs");
const path = require("path");
const os = require("os");

const LOCAL_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);
const OVERRIDE_PATH = path.join(LOCAL_DIR, "servers.json");

const BUNDLED_DEFAULTS = [
  { key: "US",      host: "https://app.datarails.com",   label: "app.datarails.com",   region: "United States",              color: "#4646CE", soft: "#DFD9FF", text: "#25258C" },
  { key: "US2",     host: "https://us-2.datarails.com",  label: "us-2.datarails.com",  region: "United States (instance 2)", color: "#7B61FF", soft: "#F0EEFF", text: "#5D45D6" },
  { key: "UK",      host: "https://ukapp.datarails.com", label: "ukapp.datarails.com", region: "United Kingdom",             color: "#03A678", soft: "#ECFAE4", text: "#037C5A" },
  { key: "CA",      host: "https://caapp.datarails.com", label: "caapp.datarails.com", region: "Canada",                     color: "#FFA310", soft: "#FFF4D4", text: "#9E5F00" },
  { key: "DEV",     host: "https://dev.datarails.com",   label: "dev.datarails.com",   region: "Development",                color: "#9EA1AA", soft: "#F0F1F4", text: "#4E566C" },
  { key: "DEV-1",   host: "https://dev-1.datarails.com", label: "dev-1.datarails.com", region: "Development (instance 1)",   color: "#9EA1AA", soft: "#F0F1F4", text: "#4E566C" },
  { key: "TEST",    host: "https://testapp.datarails.com", label: "testapp.datarails.com", region: "Test",                   color: "#9EA1AA", soft: "#F0F1F4", text: "#4E566C" },
  { key: "DEMO",    host: "https://demoapp.datarails.com", label: "demoapp.datarails.com", region: "Demo",                   color: "#9EA1AA", soft: "#F0F1F4", text: "#4E566C" },
];

let _cached = null;

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.key !== "string" || !entry.key.trim()) return false;
  if (typeof entry.host !== "string" || !entry.host.startsWith("https://")) return false;
  if (typeof entry.label !== "string" || !entry.label) return false;
  if (typeof entry.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(entry.color)) return false;
  return true;
}

function loadServers() {
  if (_cached) return _cached;

  try {
    const raw = fs.readFileSync(OVERRIDE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      _cached = BUNDLED_DEFAULTS;
      return _cached;
    }
    const seen = new Set();
    const valid = [];
    for (const entry of parsed) {
      if (!validateEntry(entry)) {
        _cached = BUNDLED_DEFAULTS;
        return _cached;
      }
      const normalized = {
        ...entry,
        key: entry.key.trim().toUpperCase(),
        soft: entry.soft || "#F0F1F4",
        text: entry.text || "#4E566C",
        region: entry.region || entry.key.trim().toUpperCase(),
      };
      if (seen.has(normalized.key)) {
        _cached = BUNDLED_DEFAULTS;
        return _cached;
      }
      seen.add(normalized.key);
      valid.push(normalized);
    }
    _cached = valid;
  } catch {
    _cached = BUNDLED_DEFAULTS;
  }

  return _cached;
}

function getServerList() {
  return loadServers();
}

function getServerMap() {
  const list = loadServers();
  const map = {};
  for (const s of list) map[s.key] = s.host;
  return map;
}

function validateKey(key) {
  const upper = (key || "").trim().toUpperCase();
  const list = loadServers();
  if (!list.find((s) => s.key === upper)) {
    throw new Error(`Unknown server key: ${key}`);
  }
  return upper;
}

function serverHost(key) {
  const upper = validateKey(key);
  return loadServers().find((s) => s.key === upper).host;
}

function resetCache() {
  _cached = null;
}

module.exports = {
  BUNDLED_DEFAULTS,
  OVERRIDE_PATH,
  getServerList,
  getServerMap,
  validateKey,
  serverHost,
  resetCache,
};
