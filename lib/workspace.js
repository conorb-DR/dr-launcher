const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");

// --- Workspace root ---
// Configurable via env var, defaults to user-owned Documents folder
const DEFAULT_ROOT = path.join(
  process.env.USERPROFILE || os.homedir(),
  "Documents",
  "DR-Customers"
);

const WORKSPACE_ROOT = process.env.DR_LAUNCHER_WORKSPACE_ROOT || DEFAULT_ROOT;

// --- CLAUDE.md sentinel markers ---
const BEGIN_MARKER = "<!-- DR-LAUNCHER:BEGIN -->";
const END_MARKER = "<!-- DR-LAUNCHER:END -->";

/**
 * Build a folder-safe slug from server key, org ID, and domain.
 * US2 + 552 + ai.exercise.shachar.com → us2-552-ai-exercise-shachar-com
 */
function customerSlug(serverKey, orgId, orgDomain) {
  const raw = `${serverKey}-${orgId || "0"}-${orgDomain}`;
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Build the generated CLAUDE.md block content.
 * NEVER include tokens, JWTs, refresh data, or browser cookie info.
 * Only: server, account email, org/domain, UI URL, CLI instruction.
 */
function buildGeneratedBlock(account) {
  return [
    BEGIN_MARKER,
    `# Customer Context`,
    ``,
    `- **Customer:** ${account.orgDomain}`,
    `- **Server:** ${account.serverKey} (${account.serverHost})`,
    `- **Account Email:** ${account.email}`,
    `- **Org ID:** ${account.orgId || "unknown"}`,
    `- **UI:** ${account.serverHost}`,
    ``,
    `## DR CLI Rules`,
    ``,
    `For every \`dr\` command in this workspace, include:`,
    `\`\`\``,
    `--server ${account.serverKey} --account ${account.email}`,
    `\`\`\``,
    ``,
    `**Never rely on the default dr account.** Always explicitly pass \`--server\` and \`--account\` to prevent accidentally operating on the wrong customer.`,
    ``,
    END_MARKER,
  ].join("\n");
}

/**
 * Ensure the customer workspace folder exists.
 * Returns { folderPath, slug }.
 */
function ensureWorkspace(account) {
  const slug = customerSlug(account.serverKey, account.orgId, account.orgDomain);
  const folderPath = path.join(WORKSPACE_ROOT, slug);
  fs.mkdirSync(folderPath, { recursive: true });
  return { folderPath, slug };
}

/**
 * Write or update the CLAUDE.md file.
 *
 * - If the file doesn't exist: write the generated block + a blank notes section.
 * - If the file exists: replace ONLY the content between DR-LAUNCHER markers,
 *   preserving everything outside (IM custom instructions).
 * - If the file exists but has no markers: prepend the generated block.
 *
 * Returns { created: boolean, updated: boolean, path: string }
 */
function writeCLAUDEmd(folderPath, account) {
  const filePath = path.join(folderPath, "CLAUDE.md");
  const generatedBlock = buildGeneratedBlock(account);

  if (!fs.existsSync(filePath)) {
    // New file: generated block + notes section
    const content = [
      generatedBlock,
      "",
      "## Custom Instructions",
      "",
      "Add any customer-specific notes or instructions below.",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, content, "utf8");
    return { created: true, updated: false, path: filePath };
  }

  // File exists — update only the generated block
  const existing = fs.readFileSync(filePath, "utf8");
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1) {
    // Replace the marker block
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    const updated = before + generatedBlock + after;
    fs.writeFileSync(filePath, updated, "utf8");
    return { created: false, updated: true, path: filePath };
  }

  // File exists but no markers — prepend generated block
  const updated = generatedBlock + "\n\n" + existing;
  fs.writeFileSync(filePath, updated, "utf8");
  return { created: false, updated: true, path: filePath };
}

// --- Terminal launch ---

// Cache Windows Terminal availability (won't change during server lifetime)
let _hasWT = null;
function hasWindowsTerminal() {
  if (_hasWT !== null) return _hasWT;
  try {
    execSync("where wt.exe", { stdio: "ignore" });
    _hasWT = true;
  } catch {
    _hasWT = false;
  }
  return _hasWT;
}

// Cache Claude CLI availability
let _hasClaude = null;
function hasClaudeCli() {
  if (_hasClaude !== null) return _hasClaude;
  try {
    execSync("where claude", { stdio: "ignore" });
    _hasClaude = true;
  } catch {
    _hasClaude = false;
  }
  return _hasClaude;
}

function buildClaudeCommand(titlePrefix, titleHoldSeconds = 0) {
  if (!titlePrefix) return "claude";

  const holdSeconds = Math.max(0, Number(titleHoldSeconds || 0));
  const holdCmd = holdSeconds > 0
    ? ` & timeout /t ${holdSeconds} /nobreak >nul`
    : "";
  return `title ${titlePrefix}${holdCmd} & claude`;
}

/**
 * Launch a terminal window in the customer folder running `claude`.
 * Tries Windows Terminal first, falls back to cmd.exe.
 * Uses spawn with args (not string-built shell commands).
 *
 * @param {string} folderPath - Customer workspace folder
 * @param {object} [opts] - Optional settings
 * @param {string} [opts.titlePrefix] - Window title prefix for identification (e.g. "DR Launcher - us2-552-slug - abc123")
 * @param {number} [opts.titleHoldSeconds] - Seconds to keep the title visible before starting Claude
 */
function launchTerminal(folderPath, opts) {
  const titlePrefix = opts?.titlePrefix || "";
  const titleHoldSeconds = Math.max(0, Number(opts?.titleHoldSeconds || 0));

  if (hasWindowsTerminal()) {
    // --window new asks Windows Terminal for a separate top-level window,
    // but wt.exe may delegate creation to the existing WindowsTerminal.exe.
    // Keep the unique title visible long enough for the VD mover fallback.
    const cmdStr = buildClaudeCommand(titlePrefix, titleHoldSeconds);
    const child = spawn("wt.exe", ["--window", "new", "-d", folderPath, "cmd.exe", "/k", cmdStr], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, terminal: "windows-terminal", folderPath, pid: child.pid || null };
  }

  // Fallback: plain cmd.exe with cwd
  const cmdStr = buildClaudeCommand(titlePrefix);
  const child = spawn("cmd.exe", ["/k", cmdStr], {
    cwd: folderPath,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true, terminal: "cmd", folderPath, pid: child.pid || null };
}

/**
 * Check if the workspace root is writable.
 */
function isWorkspaceRootWritable() {
  try {
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    const testFile = path.join(WORKSPACE_ROOT, ".write-test-" + Date.now());
    fs.writeFileSync(testFile, "test", "utf8");
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function resetDetectionCaches() {
  _hasWT = null;
  _hasClaude = null;
}

module.exports = {
  WORKSPACE_ROOT,
  customerSlug,
  buildGeneratedBlock,
  ensureWorkspace,
  writeCLAUDEmd,
  hasWindowsTerminal,
  hasClaudeCli,
  resetDetectionCaches,
  launchTerminal,
  isWorkspaceRootWritable,
  BEGIN_MARKER,
  END_MARKER,
};
