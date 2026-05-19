const fs = require("fs");
const path = require("path");

const CLOUD_CONFIG_PATH = path.join(__dirname, "..", "cloud-config.json");

let backend = null;

function loadCloudConfig() {
  try {
    const raw = fs.readFileSync(CLOUD_CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getBackend() {
  if (backend) return backend;

  const config = loadCloudConfig();
  if (config && config.type === "azure") {
    // Future: return require("./cloud-azure")(config);
    throw new Error("Azure cloud backend not yet implemented");
  }

  backend = require("./cloud-mock");
  return backend;
}

function resetBackend() {
  backend = null;
}

module.exports = {
  getBackend,
  resetBackend,
};
