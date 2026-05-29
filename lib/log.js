const fs = require("fs");
const path = require("path");
const os = require("os");

const LOCAL_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);
const LOG_DIR = path.join(LOCAL_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "launcher.log");

const MAX_BUFFER = 500;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 3;

const buffer = [];

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch { /* ignore */ }
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_FILE_SIZE) return;
  } catch {
    return;
  }
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const src = i === 1 ? LOG_FILE : path.join(LOG_DIR, `launcher.${i - 1}.log`);
    const dst = path.join(LOG_DIR, `launcher.${i}.log`);
    try { fs.renameSync(src, dst); } catch { /* ignore */ }
  }
}

function appendToFile(line) {
  try {
    ensureLogDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch { /* best-effort */ }
}

function log(level, category, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
    meta: meta || undefined,
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const metaStr = meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : "";
  const line = `${entry.ts} [${level.toUpperCase()}] [${category}] ${message}${metaStr}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  appendToFile(line);
}

function getEntries(count = 50) {
  return buffer.slice(-count).reverse();
}

function getBuffer() {
  return [...buffer];
}

function redactEmail(email) {
  if (!email || typeof email !== "string") return email;
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return email;
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx);
  return local.slice(0, 3) + "***" + domain;
}

function redactText(text) {
  if (text == null) return text;
  return String(text)
    // emails
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (m) => redactEmail(m))
    // JWTs (three base64url segments, starting with the standard `eyJ` header)
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]")
    // explicit bearer tokens
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]");
}

function getDiagnosticText(healthChecks) {
  let version = "unknown";
  try { version = require("../package.json").version; } catch {}
  const packaged = process.argv.includes("--packaged");

  const lines = [];
  lines.push("=== DR Launcher Diagnostics ===");
  lines.push(`Version: ${version}${packaged ? " (packaged)" : " (dev)"}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`OS: ${os.type()} ${os.release()} (${os.arch()})`);
  lines.push(`Node: ${process.version} (${process.execPath})`);
  lines.push(`Install path: ${path.resolve(__dirname, "..")}`);
  lines.push(`Platform: ${process.platform}`);
  lines.push(`PID: ${process.pid}`);
  lines.push(`Uptime: ${Math.floor(process.uptime())}s`);
  lines.push("");

  if (healthChecks) {
    lines.push("--- Health Checks ---");
    if (healthChecks.dr) lines.push(`DR CLI: ${healthChecks.dr.found ? "found" : "NOT FOUND"}`);
    if (healthChecks.chrome) lines.push(`Chrome: ${healthChecks.chrome.found ? "found" : "NOT FOUND"} ${healthChecks.chrome.path || ""}`);
    if (healthChecks.claude) lines.push(`Claude CLI: ${healthChecks.claude.found ? "found" : "NOT FOUND"}`);
    if (healthChecks.windowsTerminal) lines.push(`Windows Terminal: ${healthChecks.windowsTerminal.found ? "found" : "NOT FOUND"}`);
    if (healthChecks.workspaceRoot) lines.push(`Workspace root: ${healthChecks.workspaceRoot.path} (writable: ${healthChecks.workspaceRoot.writable})`);
    if (healthChecks.virtualDesktop) {
      lines.push(`Virtual desktops: ${healthChecks.virtualDesktop.available ? "available" : "unavailable"}${healthChecks.virtualDesktop.error ? ` (${healthChecks.virtualDesktop.error})` : ""}`);
    }
    lines.push("");
  }

  lines.push("--- Recent Log Entries (last 50) ---");
  const recent = getEntries(50);
  for (const e of recent) {
    const metaStr = e.meta && Object.keys(e.meta).length > 0 ? " " + JSON.stringify(e.meta) : "";
    lines.push(`${e.ts} [${e.level.toUpperCase()}] [${e.category}] ${e.message}${metaStr}`);
  }

  return redactText(lines.join("\n"));
}

function installGlobalHandlers() {
  process.on("uncaughtException", (err) => {
    log("error", "crash", `Uncaught exception: ${err.message}`, { stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    log("error", "crash", `Unhandled rejection: ${reason}`, {});
  });
}

module.exports = {
  log,
  getEntries,
  getBuffer,
  getDiagnosticText,
  installGlobalHandlers,
  redactEmail,
  redactText,
  LOG_DIR,
  LOG_FILE,
};
