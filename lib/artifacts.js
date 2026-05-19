const fs = require("fs");
const path = require("path");
const os = require("os");

const ARTIFACTS_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);
const ARTIFACTS_PATH = path.join(ARTIFACTS_DIR, "artifacts.json");

function loadArtifacts() {
  try {
    return JSON.parse(fs.readFileSync(ARTIFACTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveArtifacts(data) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(ARTIFACTS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function recordLaunch({ accountId, serverKey, orgDomain, orgId, workspaceSlug, workspacePath, profileSlug, profilePath }) {
  const artifacts = loadArtifacts();
  const key = workspaceSlug || profileSlug || `${serverKey}-${orgDomain}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  artifacts[key] = {
    accountId,
    serverKey,
    orgDomain,
    orgId: orgId || null,
    workspaceSlug: workspaceSlug || null,
    workspacePath: workspacePath || null,
    profileSlug: profileSlug || null,
    profilePath: profilePath || null,
    lastLaunchedAt: new Date().toISOString(),
  };
  saveArtifacts(artifacts);
}

function getArtifacts() {
  return loadArtifacts();
}

function getArtifactAge(slug) {
  const artifacts = loadArtifacts();
  const entry = artifacts[slug];
  if (!entry || !entry.lastLaunchedAt) return Infinity;
  return (Date.now() - new Date(entry.lastLaunchedAt).getTime()) / (1000 * 60 * 60 * 24);
}

module.exports = {
  recordLaunch,
  getArtifacts,
  getArtifactAge,
  ARTIFACTS_PATH,
};
