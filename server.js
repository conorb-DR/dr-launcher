const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");

const drCli = require("./lib/dr-cli");
const chrome = require("./lib/chrome");
const workspace = require("./lib/workspace");
const virtualDesktop = require("./lib/virtual-desktop");
const settings = require("./lib/settings");
const sessions = require("./lib/sessions");
const { buildInstruction } = require("./lib/clipboard");
const auth = require("./lib/auth");
const preferences = require("./lib/preferences");
const history = require("./lib/history");
const cloud = require("./lib/cloud");
const sync = require("./lib/sync");
const servers = require("./lib/servers");
const logger = require("./lib/log");
const artifacts = require("./lib/artifacts");
const cleanup = require("./lib/cleanup");
const authHealth = require("./lib/auth-health");

const PID_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(require("os").homedir(), "AppData", "Local"),
  "DR Launcher"
);
const PID_FILE = path.join(PID_DIR, "server.pid");

const PKG_VERSION = require("./package.json").version;
const IS_PACKAGED = process.argv.includes("--packaged");
const NO_AUTO_OPEN = process.argv.includes("--no-open");

function parsePidFile() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    if (raw.startsWith("{")) {
      return JSON.parse(raw);
    }
    const [pidStr, portStr] = raw.split(":");
    return { pid: parseInt(pidStr, 10), port: parseInt(portStr, 10) };
  } catch {
    return null;
  }
}

function isOurProcess(pid) {
  try {
    const { execSync } = require("child_process");
    const out = execSync(
      `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { encoding: "utf8", timeout: 5000 }
    );
    return out.includes("server.js");
  } catch {
    return false;
  }
}

function killPreviousServer() {
  const info = parsePidFile();
  if (!info || !info.pid || info.pid === process.pid) return;
  try {
    process.kill(info.pid, 0);
    if (!isOurProcess(info.pid)) {
      logger.log("warn", "server", `PID ${info.pid} is alive but not a DR Launcher process — skipping kill`);
      return;
    }
    process.kill(info.pid, "SIGTERM");
    logger.log("info", "server", `Killed previous server (PID ${info.pid})`);
    const start = Date.now();
    while (Date.now() - start < 1000) { /* spin for port release */ }
  } catch {
    // Process already dead
  }
}

function writePidFile(port) {
  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify({
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    exePath: process.execPath,
    serverJs: __filename,
    version: PKG_VERSION,
  }), "utf8");
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

let serverPort = null;

const app = express();
app.use(express.json());

app.get("/ping", (req, res) => {
  res.json({
    ok: true,
    port: serverPort,
    pid: process.pid,
    version: PKG_VERSION,
    packaged: IS_PACKAGED,
  });
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.log("info", "http", `${req.method} ${req.path} ${res.statusCode}`, { ms: Date.now() - start });
  });
  next();
});

const TERMINAL_TITLE_HOLD_SECONDS = 15;

// Live launch progress — SSE subscribers + step tracking.
let launchProgress = null; // { launchId, orgDomain, serverKey, step, totalSteps, done }
const sseClients = new Set();
function emitProgress(data) {
  launchProgress = data;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

// --- API token protection ---
const API_TOKEN = crypto.randomBytes(24).toString("hex");
let healthChecksCache = null;

function requireToken(req, res, next) {
  const token = req.headers["x-dr-launcher-token"] || req.query.token;
  if (token !== API_TOKEN) {
    return res.status(403).json({ error: "Invalid or missing API token" });
  }
  const origin = req.headers["origin"];
  if (origin && !origin.startsWith("http://127.0.0.1:")) {
    return res.status(403).json({ error: "Unexpected origin" });
  }
  next();
}

// Serve static frontend — inject token + user info into index.html
app.get("/", async (req, res) => {
  const fs = require("fs");
  const htmlPath = path.join(__dirname, "public", "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  const userTheme = preferences.getPreferences().theme || "light";

  let userName = "";
  let userInitials = "";
  try {
    const user = await auth.getCurrentUser();
    if (user) {
      userName = user.name;
      userInitials = user.initials;
    }
  } catch { /* unauthenticated — leave blank */ }

  html = html.replace("__API_TOKEN__", API_TOKEN);
  html = html.replace("__THEME__", userTheme);
  html = html.replace("__USER_NAME__", userName);
  html = html.replace("__USER_INITIALS__", userInitials);
  res.type("html").send(html);
});

app.use("/static", express.static(path.join(__dirname, "public")));

// --- Auth Routes ---

app.get("/auth/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    return res.type("html").send(
      `<h2>Authentication failed</h2><p>${error}: ${error_description || ""}</p><p>You can close this tab.</p>`
    );
  }
  if (!code) {
    return res.status(400).type("html").send("<h2>Missing authorization code</h2>");
  }
  try {
    const port = req.socket.localPort;
    const user = await auth.handleCallback(code, port);
    res.type("html").send(
      `<h2>Signed in as ${user.name}</h2><p>You can close this tab and return to DR Launcher.</p>` +
      `<script>window.close()</script>`
    );
  } catch (err) {
    res.status(500).type("html").send(
      `<h2>Authentication error</h2><p>${err.message}</p><p>You can close this tab and try again.</p>`
    );
  }
});

app.get("/api/auth/status", requireToken, async (req, res) => {
  try {
    const configured = auth.isConfigured();
    const user = await auth.getCurrentUser();
    if (!configured) {
      return res.json({
        configured: false,
        authenticated: user !== null && !!user.devMode,
        user,
      });
    }
    res.json({
      configured: true,
      authenticated: user !== null && !user.tokenExpired,
      user,
    });
  } catch (err) {
    res.json({ configured: false, authenticated: false, user: null, error: err.message });
  }
});

app.post("/api/auth/login", requireToken, async (req, res) => {
  try {
    if (!auth.isConfigured()) {
      return res.status(400).json({
        error: "Azure AD not configured. Update auth-config.json with your client and tenant IDs.",
      });
    }
    const port = req.socket.localPort;
    const result = await auth.startLogin(port);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/logout", requireToken, async (req, res) => {
  try {
    await auth.logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/dev-login", requireToken, (req, res) => {
  if (auth.isConfigured()) {
    return res.status(403).json({ error: "Dev login disabled — Azure AD is configured." });
  }
  const { password, name } = req.body;
  const user = auth.devLogin(password, name);
  if (!user) {
    return res.status(401).json({ error: "Invalid password" });
  }
  res.json({ ok: true, user });
});

// --- API Routes ---

// Health check — comprehensive system status
app.get("/api/health", requireToken, async (req, res) => {
  if (req.query.force === "true") {
    workspace.resetDetectionCaches();
    drCli.resetDrCache();
  }

  const chromeInfo = chrome.chromeAvailable();
  const vdTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("VD check timed out")), 5000));
  let vdCheck;
  try {
    vdCheck = await Promise.race([virtualDesktop.checkAvailability(), vdTimeout]);
  } catch {
    vdCheck = { ok: false, error: "check_timed_out" };
  }

  // During install, don't re-probe dr — npm has the package locked, `where dr` may fail
  const drFound = cliInstallChild
    ? (healthChecksCache?.dr?.found ?? drCli.hasDrCli())
    : drCli.hasDrCli();
  const checks = {
      dr: { found: drFound, installing: !!cliInstallChild },
      chrome: { found: chromeInfo.available, path: chromeInfo.path },
      claude: { found: workspace.hasClaudeCli() },
      windowsTerminal: { found: workspace.hasWindowsTerminal() },
      workspaceRoot: {
        path: workspace.WORKSPACE_ROOT,
        writable: workspace.isWorkspaceRootWritable(),
      },
      virtualDesktop: {
        available: vdCheck.ok === true,
        supportsNaming: vdCheck.supportsNaming || false,
        osBuild: vdCheck.osBuild || null,
        languageMode: vdCheck.languageMode || null,
        desktopCount: vdCheck.desktopCount || null,
        error: vdCheck.error || null,
      },
    };
  healthChecksCache = checks;

  res.json({
    status: "ok",
    checks,
    servers: servers.getServerList().map((s) => s.key),
  });
});

// DR CLI version check
app.get("/api/cli/version", requireToken, (req, res) => {
  if (cliInstallChild) {
    return res.json({ installed: null, version: null, installing: true });
  }
  const version = drCli.getDrVersion();
  res.json({ installed: !!version, version });
});

// DR CLI install/update — streams output via SSE
let cliInstallChild = null;
const CLI_INSTALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

app.get("/api/cli/install", requireToken, (req, res) => {
  if (cliInstallChild) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Install already in progress" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let closed = false;
  const send = (type, data) => {
    if (closed) return;
    try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch { closed = true; }
  };
  const finish = () => {
    closed = true;
    cliInstallChild = null;
    clearTimeout(installTimer);
    drCli.resetDrCache();
    setTimeout(() => { try { res.end(); } catch {} }, 500);
  };

  send("status", "Starting DR CLI install/update…");

  const npmCmd = "npm install -g dr-cli --registry https://datarails.jfrog.io/artifactory/api/npm/dr-cli-client-virtual";
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", npmCmd], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  cliInstallChild = child;

  const installTimer = setTimeout(() => {
    logger.log("error", "cli", "DR CLI install timed out after 3 minutes");
    send("error", "Install timed out after 3 minutes. Check your network connection to JFrog and retry.");
    try { child.kill(); } catch {}
    finish();
  }, CLI_INSTALL_TIMEOUT_MS);

  child.stdout.on("data", (chunk) => send("stdout", chunk.toString()));
  child.stderr.on("data", (chunk) => send("stderr", chunk.toString()));
  child.on("close", (code) => {
    if (code === 0) {
      send("done", "DR CLI installed/updated successfully.");
      logger.log("info", "cli", "DR CLI install/update completed");
    } else {
      send("error", `Install exited with code ${code}. This can happen if dr-cli is currently running — close any terminals using it and retry.`);
      logger.log("error", "cli", `DR CLI install failed with exit code ${code}`);
    }
    finish();
  });
  child.on("error", (err) => {
    send("error", `Failed to start install: ${err.message}`);
    logger.log("error", "cli", `DR CLI install spawn error: ${err.message}`);
    finish();
  });

  req.on("close", () => {
    try { child.kill(); } catch {}
  });
});

// Server list with full metadata
app.get("/api/servers", requireToken, (req, res) => {
  res.json({ servers: servers.getServerList() });
});

// Log + diagnostics endpoints
app.get("/api/logs", requireToken, (req, res) => {
  const count = parseInt(req.query.count, 10) || 50;
  res.json({ entries: logger.getEntries(count) });
});

app.get("/api/diagnostics", requireToken, (req, res) => {
  res.json({ text: logger.getDiagnosticText(healthChecksCache) });
});

// Cleanup — scan orphaned profiles/workspaces
app.get("/api/cleanup/scan", requireToken, (req, res) => {
  try {
    const maxAge = parseInt(req.query.maxAge) || 30;
    const result = cleanup.scanOrphaned(maxAge);
    res.json(result);
  } catch (err) {
    logger.log("error", "cleanup", `Scan failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/cleanup/purge", requireToken, (req, res) => {
  try {
    const { profiles = [], workspaces = [] } = req.body;
    const result = {};
    if (profiles.length > 0) {
      result.profiles = cleanup.purgeProfiles(profiles);
    }
    if (workspaces.length > 0) {
      result.workspaces = cleanup.quarantineWorkspaces(workspaces);
    }
    logger.log("info", "cleanup", "Purge completed", {
      profilesDeleted: result.profiles?.deleted?.length || 0,
      workspacesQuarantined: result.workspaces?.quarantined?.length || 0,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.log("error", "cleanup", `Purge failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Settings (returns machine-local + preferences merged)
app.get("/api/settings", requireToken, (req, res) => {
  res.json(settings.getSettingsWithPreferences());
});

app.post("/api/settings", requireToken, (req, res) => {
  try {
    const updated = settings.updateSettings(req.body);
    const hasPrefKeys = Object.keys(req.body).some((k) => preferences.SYNCABLE_KEYS.includes(k));
    if (hasPrefKeys) sync.pushPreferences();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discover all authenticated accounts
app.get("/api/accounts", requireToken, async (req, res) => {
  try {
    if (req.query.force === "1") drCli.invalidateAccountsCache();
    const discovered = await drCli.discoverAccounts();
    const accounts = authHealth.mergeWithDiscovered(discovered);
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refresh accounts for a specific server
app.post("/api/refresh", requireToken, async (req, res) => {
  try {
    const { server } = req.body;
    const key = drCli.validateServer(server);
    const accounts = await drCli.discoverAccounts([key]);
    res.json({ accounts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Recent launches — derived from history
app.get("/api/recents", requireToken, (req, res) => {
  const recents = history.getRecents(10);
  res.json({ recents });
});

app.post("/api/recents", requireToken, (req, res) => {
  const { recents } = req.body;
  if (!Array.isArray(recents)) return res.status(400).json({ error: "recents must be an array" });
  for (const entry of recents) {
    if (entry.accountId || entry.id) {
      history.addEntry({
        launchId: entry.launchId || `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        accountId: entry.accountId || entry.id,
        orgDomain: entry.orgDomain || "",
        serverKey: entry.serverKey || "",
        email: entry.email || "",
        launchedAt: entry.launchedAt || entry.at || new Date().toISOString(),
      });
    }
  }
  res.json({ recents: history.getRecents(10) });
});

// Sync
app.post("/api/sync/init", requireToken, async (req, res) => {
  try {
    const user = await auth.getCurrentUser();
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    sync.setBackend(cloud.getBackend());
    const result = await sync.initialize(user.cloudId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/sync", requireToken, async (req, res) => {
  try {
    const result = await sync.pullAndMerge();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/sync/status", requireToken, (req, res) => {
  res.json(sync.getStatus());
});

// Sessions
app.get("/api/agents", requireToken, (req, res) => {
  try {
    res.json({ agents: require("./lib/agents").loadCatalog() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions", requireToken, (req, res) => {
  sessions.pruneEndedSessions();
  res.json({ sessions: sessions.getVisibleSessions() });
});

app.post("/api/sessions/close", requireToken, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  try {
    const result = await sessions.closeSession(sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/force-close", requireToken, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  try {
    const result = await sessions.forceCloseSession(sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/close-batch", requireToken, async (req, res) => {
  const { sessionIds } = req.body;
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return res.status(400).json({ error: "sessionIds must be a non-empty array" });
  }
  try {
    const results = await sessions.closeSessions(sessionIds);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions/health", requireToken, async (req, res) => {
  try {
    const result = await sessions.checkSessionHealth();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth-health/check", requireToken, async (req, res) => {
  try {
    await authHealth.runCheck();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live launch progress — SSE stream (uses query-string token since EventSource can't send headers)
app.get("/api/launch-stream", (req, res) => {
  const token = req.query.token || req.headers["x-dr-launcher-token"];
  if (token !== API_TOKEN) return res.status(403).json({ error: "Invalid token" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  if (launchProgress) res.write(`data: ${JSON.stringify(launchProgress)}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Launch: Chrome + workspace + terminal + optional virtual desktop
app.post("/api/launch", requireToken, async (req, res) => {
  const { id, email, serverKey, serverHost, orgDomain, orgId, noSwitch, agentId, agentInputs } = req.body;
  if (!email || !serverKey || !orgDomain) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    drCli.validateServer(serverKey);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email format" });
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(orgDomain)) {
    return res.status(400).json({ error: "Invalid orgDomain format" });
  }

  // Validate agent request before acquiring lock (fail-fast)
  let validatedAgent = null;
  if (agentId) {
    const agentsLib = require("./lib/agents");
    const validation = agentsLib.validateAgentRequest(agentId, agentInputs || {});
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    validatedAgent = validation.agent;
  }

  // Block duplicate active sessions
  const existingSession = sessions.getSessionByAccountId(id);
  if (existingSession) {
    return res.status(409).json({
      error: "active_session_exists",
      message: `Active session already exists for ${orgDomain}. Close it first.`,
    });
  }

  // Server-side launch serialization
  if (!virtualDesktop.acquireLaunchLock()) {
    return res.status(409).json({ error: "launch_in_progress", message: "Another launch is in progress. Please wait." });
  }

  const launchId = virtualDesktop.generateLaunchId();
  logger.log("info", "launch", "Starting launch", { launchId, accountId: id, serverKey, orgDomain });
  const account = { email, serverKey, serverHost, orgDomain, orgId };
  const userSettings = settings.getSettings();
  const useVD = userSettings.useVirtualDesktops;
  const desktopName = `[${serverKey}] ${orgDomain}`;
  const terminalTitle = `DR Launcher - ${workspace.customerSlug(serverKey, orgId, orgDomain)} - ${launchId}`;

  const result = {
    launchId,
    chrome: { ok: false },
    workspace: { ok: false },
    terminal: { ok: false },
    instruction: buildInstruction(account),
  };

  const totalSteps = useVD ? 5 : 4;
  const emit = (step, label) => emitProgress({ launchId, orgDomain, serverKey, step, totalSteps, label, done: false });

  try {
    // 1. Create workspace + write/update CLAUDE.md
    emit(1, "Creating workspace");
    try {
      const ws = workspace.ensureWorkspace(account);
      const md = workspace.writeCLAUDEmd(ws.folderPath, account);
      result.workspace = {
        ok: true,
        path: ws.folderPath,
        slug: ws.slug,
        claudeMdCreated: md.created,
        claudeMdUpdated: md.updated,
      };
    } catch (err) {
      result.workspace = { ok: false, error: err.message };
    }
    logger.log("info", "launch", `Workspace: ${result.workspace.ok ? "ok" : "failed"}`, { launchId });

    // 1b. Agent scaffolding (if agent requested)
    if (result.workspace.ok) {
      const agentsLib = require("./lib/agents");
      agentsLib.clearAgentScaffold(result.workspace.path);

      if (validatedAgent) {
        try {
          const scaffoldResult = agentsLib.scaffoldAgent(agentId, result.workspace.path, agentInputs || {});
          result.agent = { ok: true, ...scaffoldResult };
        } catch (err) {
          logger.log("error", "launch", `Agent scaffold failed: ${err.message}`, { launchId, agentId });
          virtualDesktop.releaseLaunchLock();
          return res.status(500).json({
            error: `Agent setup failed: ${err.message}`,
            agentId,
            workspace: result.workspace,
          });
        }
      }
    }

    // 2. Snapshot windows BEFORE launching (if VD enabled)
    emit(2, "Snapshotting windows");
    let snapshot = null;
    if (useVD && await virtualDesktop.isAvailable()) {
      try {
        snapshot = await virtualDesktop.snapshotWindows();
      } catch (err) {
        // Non-fatal — proceed without VD
      }
    }

    // 3. Launch Chrome
    emit(3, "Opening Chrome");
    try {
      const chromeResult = chrome.launchChrome(account);
      result.chrome = { ok: true, ...chromeResult };
    } catch (err) {
      result.chrome = { ok: false, error: err.message };
    }
    logger.log("info", "launch", `Chrome: ${result.chrome.ok ? "ok" : "failed"}`, { launchId, pid: result.chrome.pid });

    // 4. Launch Terminal (with transaction ID title)
    emit(4, "Opening Claude Code");
    if (result.workspace.ok) {
      try {
        const termOpts = {
          titlePrefix: terminalTitle,
          titleHoldSeconds: useVD && snapshot?.ok ? TERMINAL_TITLE_HOLD_SECONDS : 0,
        };
        if (validatedAgent) {
          // Prefer the token-expanded initialPrompt produced by scaffoldAgent;
          // fall back to the raw manifest value, then a generic default.
          termOpts.initialPrompt =
            result.agent?.initialPrompt ||
            validatedAgent.initialPrompt ||
            `Read AGENT_TASK.md and AGENT_INSTRUCTIONS.md, then invoke /${agentId} to begin.`;
        }
        const termResult = workspace.launchTerminal(result.workspace.path, termOpts);
        result.terminal = termResult;
      } catch (err) {
        result.terminal = { ok: false, error: err.message };
      }
    } else {
      result.terminal = { ok: false, error: "Skipped - workspace creation failed" };
    }
    logger.log("info", "launch", `Terminal: ${result.terminal.ok ? "ok" : "failed"}`, { launchId });

    // 5. Virtual desktop (if enabled and available)
    if (useVD) emit(5, "Setting up virtual desktop");
    if (useVD && snapshot?.ok) {
      try {
        const vdResult = await virtualDesktop.createDesktopAndMoveWindows({
          name: desktopName,
          allHwndsBefore: snapshot.all || [],
          chromePid: result.chrome.pid || 0,
          terminalPid: result.terminal.pid || 0,
          terminalTitleMatch: terminalTitle,
          pollTimeoutMs: 10000,
          pollIntervalMs: 400,
          noSwitch: !!noSwitch,
        });
        result.virtualDesktop = {
          enabled: true,
          ...vdResult,
          desktopName,
        };
      } catch (err) {
        result.virtualDesktop = { enabled: true, ok: false, error: err.message };
      }
    } else if (useVD) {
      result.virtualDesktop = {
        enabled: true,
        ok: false,
        error: snapshot ? "Snapshot failed" : "Virtual desktop not available on this system",
      };
    }

    logger.log("info", "launch", `VD: ${result.virtualDesktop?.ok ? "ok" : "skipped/failed"}`, { launchId });
    emitProgress({ launchId, orgDomain, serverKey, step: totalSteps, totalSteps, label: "Done", done: true });

    // Register session if at least one surface opened
    if (result.chrome.ok || result.terminal.ok) {
      const regResult = sessions.registerSession({
        sessionId: launchId,
        accountId: id,
        email,
        serverKey,
        orgDomain,
        orgId,
        chromePid: result.chrome.pid || null,
        chromeProfilePath: result.chrome.profilePath || null,
        chromeHwnds: result.virtualDesktop?.chromeHwnds || [],
        terminalPid: result.terminal.pid || null,
        terminalHwnds: result.virtualDesktop?.terminalHwnds || [],
        desktopName: result.virtualDesktop?.desktopName || null,
        desktopCreated: result.virtualDesktop?.created === true,
        workspacePath: result.workspace.path || null,
        launchedAt: new Date().toISOString(),
        chromeOk: result.chrome.ok === true,
        terminalOk: result.terminal.ok === true,
        agentId: agentId || null,
        agentName: validatedAgent?.name || null,
      });
      if (!regResult.ok) {
        logger.log("error", "session", `Registration failed for ${orgDomain}: ${regResult.error}`);
        result.sessionError = regResult.error;
      } else {
        logger.log("info", "launch", "Session registered", { launchId, sessionError: null });
      }
      const historyEntry = {
        launchId,
        accountId: id,
        orgDomain,
        serverKey,
        email,
        launchedAt: new Date().toISOString(),
        ...(agentId ? { agentId } : {}),
      };
      history.addEntry(historyEntry);
      sync.pushHistoryEntry(historyEntry);
      drCli.invalidateAccountsCache();
      artifacts.recordLaunch({
        accountId: id,
        serverKey,
        orgDomain,
        orgId: orgId || null,
        workspaceSlug: result.workspace?.slug || null,
        workspacePath: result.workspace?.path || null,
        profileSlug: result.chrome?.profilePath ? path.basename(result.chrome.profilePath) : null,
        profilePath: result.chrome?.profilePath || null,
      });
    }

    res.json(result);
  } finally {
    virtualDesktop.releaseLaunchLock();
  }
});

// Switch to a named virtual desktop
app.post("/api/switch-desktop", requireToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Missing desktop name" });
  try {
    const result = await virtualDesktop.switchToDesktop(name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a dr login flow
app.post("/api/login", requireToken, (req, res) => {
  try {
    const { server, accountId, email } = req.body;
    const key = drCli.validateServer(server);
    const child = drCli.startLogin(key);

    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("close", () => {});

    res.json({
      started: true,
      server: key,
      accountId: accountId || null,
      email: email || null,
      message: `Browser should open for ${key} authentication. Complete the login in your browser.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Open a workspace folder in Explorer
app.post("/api/open-folder", requireToken, (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath || !folderPath.toLowerCase().startsWith(workspace.WORKSPACE_ROOT.toLowerCase())) {
    return res.status(400).json({ error: "Invalid path" });
  }
  try {
    exec(`explorer "${folderPath}"`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start server ---
function tryListen(port, maxAttempts) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function listen() {
      attempt++;
      const server = app.listen(port, "127.0.0.1", () => {
        resolve({ server, port });
      });
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE" && attempt < maxAttempts) {
          port++;
          listen();
        } else {
          reject(err);
        }
      });
    }
    listen();
  });
}

(async () => {
  try {
    logger.installGlobalHandlers();
    killPreviousServer();
    settings.migrateIfNeeded();

    const { server, port } = await tryListen(3456, 3);
    serverPort = port;
    writePidFile(port);

    const url = `http://127.0.0.1:${port}`;
    logger.log("info", "server", `DR Launcher v${PKG_VERSION} running at ${url} (PID ${process.pid})`);
    logger.log("info", "server", `Workspace root: ${workspace.WORKSPACE_ROOT}`);
    if (IS_PACKAGED) logger.log("info", "server", `Packaged mode — install path: ${__dirname}`);
    logger.log("info", "server", "API token: [redacted]");

    // Clear stale sessions from previous server runs
    const stale = sessions.clearPreviousRunSessions();
    if (stale.cleared > 0) {
      logger.log("info", "server", `Cleared ${stale.cleared} stale session(s) from previous run`);
    }

    authHealth.start();

    // Pre-check virtual desktop availability
    const vdStatus = await virtualDesktop.checkAvailability();
    logger.log("info", "server", `Virtual desktops: ${vdStatus.ok ? "available" : "unavailable"}${vdStatus.error ? ` (${vdStatus.error})` : ""}`);

    // Graceful shutdown
    function shutdown(signal) {
      logger.log("info", "server", `${signal} received — shutting down`);
      authHealth.stop();
      removePidFile();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);
    }
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("exit", removePidFile);

    // System tray icon (optional — works without it in dev mode)
    try {
      const tray = require("./lib/tray");
      const icoCandidates = [
        path.join(__dirname, "..", "dr-launcher.ico"),
        path.join(__dirname, "packaging", "dr-launcher.ico"),
      ];
      const icoPath = icoCandidates.find((p) => fs.existsSync(p)) || null;
      tray.initTray({ port, iconPath: icoPath, onQuit: () => shutdown("TRAY_QUIT") });
    } catch (err) {
      logger.log("warn", "server", `Tray icon unavailable: ${err.message}`);
    }

    if (!NO_AUTO_OPEN) {
      exec(`start "" "${url}"`, (err) => {
        if (err) logger.log("warn", "server", `Could not auto-open browser: ${err.message}`);
      });
    }
  } catch (err) {
    logger.log("error", "server", `Failed to start server: ${err.message}`);
    process.exit(1);
  }
})();
