const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

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

const PID_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(require("os").homedir(), "AppData", "Local"),
  "DR Launcher"
);
const PID_FILE = path.join(PID_DIR, "server.pid");

function killPreviousServer() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const [pidStr, portStr] = raw.split(":");
    const oldPid = parseInt(pidStr, 10);
    if (!isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        process.kill(oldPid, "SIGTERM");
        console.log(`Killed previous server (PID ${oldPid})`);
        // Brief pause for port release
        const start = Date.now();
        while (Date.now() - start < 1000) { /* spin */ }
      } catch {
        // Process already dead
      }
    }
  } catch {
    // No PID file
  }
}

function writePidFile(port) {
  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}:${port}`, "utf8");
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

const app = express();
app.use(express.json());

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

function requireToken(req, res, next) {
  const token = req.headers["x-dr-launcher-token"];
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
  const vdCheck = await virtualDesktop.checkAvailability();

  res.json({
    status: "ok",
    checks: {
      dr: { found: drCli.hasDrCli() },
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
    },
    servers: drCli.serverKeys(),
  });
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
    const accounts = await drCli.discoverAccounts();
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
app.get("/api/sessions", requireToken, (req, res) => {
  sessions.pruneEndedSessions();
  res.json({ sessions: sessions.getSessions() });
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
  const { id, email, serverKey, serverHost, orgDomain, orgId, noSwitch } = req.body;
  if (!email || !serverKey || !orgDomain) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    drCli.validateServer(serverKey);
  } catch (err) {
    return res.status(400).json({ error: err.message });
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

    // 4. Launch Terminal (with transaction ID title)
    emit(4, "Opening Claude Code");
    if (result.workspace.ok) {
      try {
        const termResult = workspace.launchTerminal(result.workspace.path, {
          titlePrefix: terminalTitle,
          titleHoldSeconds: useVD && snapshot?.ok ? TERMINAL_TITLE_HOLD_SECONDS : 0,
        });
        result.terminal = termResult;
      } catch (err) {
        result.terminal = { ok: false, error: err.message };
      }
    } else {
      result.terminal = { ok: false, error: "Skipped - workspace creation failed" };
    }

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
      });
      if (!regResult.ok) {
        console.error(`[session] Registration failed for ${orgDomain}: ${regResult.error}`);
        result.sessionError = regResult.error;
      }
      const historyEntry = {
        launchId,
        accountId: id,
        orgDomain,
        serverKey,
        email,
        launchedAt: new Date().toISOString(),
      };
      history.addEntry(historyEntry);
      sync.pushHistoryEntry(historyEntry);
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
    const { server } = req.body;
    const key = drCli.validateServer(server);
    const child = drCli.startLogin(key);

    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("close", () => {});

    res.json({
      started: true,
      server: key,
      message: `Browser should open for ${key} authentication. Complete the login in your browser.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    killPreviousServer();
    settings.migrateIfNeeded();

    const { server, port } = await tryListen(3456, 3);
    writePidFile(port);

    const url = `http://127.0.0.1:${port}`;
    console.log(`DR Launcher running at ${url} (PID ${process.pid})`);
    console.log(`Workspace root: ${workspace.WORKSPACE_ROOT}`);
    console.log(`API token: ${API_TOKEN.slice(0, 8)}...`);

    // Clear stale sessions from previous server runs
    const stale = sessions.clearStaleSessions();
    if (stale.cleared > 0) {
      console.log(`Cleared ${stale.cleared} stale session(s) from previous run`);
    }

    // Pre-check virtual desktop availability
    const vdStatus = await virtualDesktop.checkAvailability();
    console.log(`Virtual desktops: ${vdStatus.ok ? "available" : "unavailable"}${vdStatus.error ? ` (${vdStatus.error})` : ""}`);

    // Graceful shutdown
    function shutdown(signal) {
      console.log(`\n${signal} received — shutting down`);
      removePidFile();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);
    }
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("exit", removePidFile);

    exec(`start "" "${url}"`, (err) => {
      if (err) console.log("Could not auto-open browser:", err.message);
    });
  } catch (err) {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  }
})();
