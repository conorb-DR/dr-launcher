const fs = require("fs");
const path = require("path");
const chrome = require("./chrome");
const workspace = require("./workspace");
const artifacts = require("./artifacts");
const sessions = require("./sessions");
const logger = require("./log");
const { isInsideRoot } = require("./path-safety");

function dirSize(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) {
        total += dirSize(full);
      } else {
        try { total += fs.statSync(full).size; } catch { /* skip */ }
      }
    }
  } catch { /* empty or inaccessible */ }
  return total;
}

function lastModified(dirPath) {
  let latest = 0;
  try {
    const stat = fs.statSync(dirPath);
    latest = stat.mtimeMs;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      try {
        const full = path.join(dirPath, e.name);
        const s = fs.statSync(full);
        if (s.mtimeMs > latest) latest = s.mtimeMs;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return latest;
}

function hasUserContent(workspacePath) {
  try {
    const entries = fs.readdirSync(workspacePath);
    const nonClaude = entries.filter((e) => e !== "CLAUDE.md" && !e.startsWith("."));
    if (nonClaude.length > 0) return true;

    const claudePath = path.join(workspacePath, "CLAUDE.md");
    if (!fs.existsSync(claudePath)) return false;
    const content = fs.readFileSync(claudePath, "utf8");
    const beginMarker = "<!-- DR-LAUNCHER:BEGIN -->";
    const endMarker = "<!-- DR-LAUNCHER:END -->";
    const beginIdx = content.indexOf(beginMarker);
    const endIdx = content.indexOf(endMarker);
    if (beginIdx === -1 || endIdx === -1) return true;
    const outside = content.slice(0, beginIdx).trim() + content.slice(endIdx + endMarker.length).trim();
    return outside.length > 0;
  } catch {
    return false;
  }
}

function scanOrphaned(maxAgeDays = 30) {
  const allArtifacts = artifacts.getArtifacts();
  const active = sessions.getVisibleSessions();
  const activeProfilePaths = new Set(active.map((s) => s.chromeProfilePath?.toLowerCase()).filter(Boolean));
  const activeWorkspacePaths = new Set(active.map((s) => s.workspacePath?.toLowerCase()).filter(Boolean));

  const profileRoot = chrome.PROFILE_ROOT;
  const workspaceRoot = workspace.WORKSPACE_ROOT;

  const orphanedProfiles = [];
  const orphanedWorkspaces = [];

  try {
    const profileDirs = fs.readdirSync(profileRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of profileDirs) {
      const fullPath = path.join(profileRoot, d.name);
      if (activeProfilePaths.has(fullPath.toLowerCase())) continue;
      const artifact = Object.values(allArtifacts).find((a) => a.profileSlug === d.name);
      const age = artifact ? artifacts.getArtifactAge(artifact.workspaceSlug || d.name) : Infinity;
      if (age < maxAgeDays) continue;
      orphanedProfiles.push({
        path: fullPath,
        slug: d.name,
        sizeMB: Math.round(dirSize(fullPath) / (1024 * 1024) * 10) / 10,
        lastUsed: artifact?.lastLaunchedAt || null,
      });
    }
  } catch { /* profileRoot may not exist yet */ }

  try {
    const wsDirs = fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== ".quarantine");
    for (const d of wsDirs) {
      const fullPath = path.join(workspaceRoot, d.name);
      if (activeWorkspacePaths.has(fullPath.toLowerCase())) continue;
      const artifact = Object.values(allArtifacts).find((a) => a.workspaceSlug === d.name);
      const age = artifact ? artifacts.getArtifactAge(artifact.workspaceSlug || d.name) : Infinity;
      if (age < maxAgeDays) continue;
      orphanedWorkspaces.push({
        path: fullPath,
        slug: d.name,
        sizeMB: Math.round(dirSize(fullPath) / (1024 * 1024) * 10) / 10,
        lastUsed: artifact?.lastLaunchedAt || null,
        hasUserContent: hasUserContent(fullPath),
      });
    }
  } catch { /* workspaceRoot may not exist yet */ }

  return { profiles: orphanedProfiles, workspaces: orphanedWorkspaces };
}

function purgeProfiles(paths) {
  const profileRoot = chrome.PROFILE_ROOT;
  const deleted = [];
  const errors = [];
  for (const p of paths) {
    // realpath-based containment: defeats sibling-prefix + symlink/junction escape.
    if (!isInsideRoot(p, profileRoot, { mustExist: true })) {
      errors.push({ path: p, error: "path_outside_profile_root" });
      continue;
    }
    try {
      fs.rmSync(p, { recursive: true, force: true });
      deleted.push(p);
      logger.log("info", "cleanup", `Deleted profile: ${p}`);
    } catch (err) {
      errors.push({ path: p, error: err.message });
    }
  }
  return { deleted, errors };
}

function quarantineWorkspaces(paths) {
  const workspaceRoot = workspace.WORKSPACE_ROOT;
  const quarantineDir = path.join(workspaceRoot, ".quarantine");
  const quarantined = [];
  const errors = [];
  for (const p of paths) {
    if (!isInsideRoot(p, workspaceRoot, { mustExist: true })) {
      errors.push({ path: p, error: "path_outside_workspace_root" });
      continue;
    }
    try {
      fs.mkdirSync(quarantineDir, { recursive: true });
      const slug = path.basename(p);
      const date = new Date().toISOString().slice(0, 10);
      const dest = path.join(quarantineDir, `${slug}-${date}`);
      fs.renameSync(p, dest);
      quarantined.push({ from: p, to: dest });
      logger.log("info", "cleanup", `Quarantined workspace: ${p} → ${dest}`);
    } catch (err) {
      errors.push({ path: p, error: err.message });
    }
  }
  return { quarantined, errors };
}

module.exports = {
  scanOrphaned,
  purgeProfiles,
  quarantineWorkspaces,
};
