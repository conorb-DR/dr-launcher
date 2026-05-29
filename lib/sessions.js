const { execFile } = require("child_process");
const virtualDesktop = require("./virtual-desktop");
const store = require("./session-store");

const PRUNE_AGE_MS = 5 * 60 * 1000;
const STALE_GRACE_MS = 2 * 60 * 1000; // session must be stale for 2 min before ending

function getSessions() {
  return store.read();
}

function getActiveSessions() {
  return getSessions().filter((s) => s.status === "active");
}

function getVisibleSessions() {
  return getSessions().filter((s) => s.status === "active" || s.status === "stale");
}

function getLaunchBlockingSessions() {
  return getSessions().filter((s) => s.status === "active");
}

function getSessionByAccountId(accountId) {
  return getLaunchBlockingSessions().find((s) => s.accountId === accountId) || null;
}

function registerSession(data) {
  let result = { ok: true };
  store.update((sessions) => {
    const existing = sessions.find((s) => s.accountId === data.accountId && s.status === "active");
    if (existing) {
      result = { ok: false, error: "active_session_exists" };
      return sessions;
    }
    sessions.push({ ...data, status: "active", endedAt: null });
    return sessions;
  });
  return result;
}

function endSession(sessionId) {
  let found = false;
  store.update((sessions) => {
    const s = sessions.find((x) => x.sessionId === sessionId);
    if (s) {
      s.status = "ended";
      s.endedAt = new Date().toISOString();
      found = true;
    }
    return sessions;
  });
  return found;
}

function markSessionsEnded(sessionIds) {
  if (!sessionIds.length) return;
  const idSet = new Set(sessionIds);
  const now = new Date().toISOString();
  store.update((sessions) => {
    for (const s of sessions) {
      if (idSet.has(s.sessionId) && s.status === "active") {
        s.status = "ended";
        s.endedAt = now;
      }
    }
    return sessions;
  });
}

function pruneEndedSessions() {
  const cutoff = Date.now() - PRUNE_AGE_MS;
  return store.update((sessions) =>
    sessions.filter(
      (s) => s.status === "active" || !s.endedAt || new Date(s.endedAt).getTime() > cutoff
    )
  );
}

// --- Health checking ---

function execPromise(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout || "");
    });
  });
}

async function checkChromeAlive(session) {
  if (!session.chromeOk || !session.chromeProfilePath) return false;
  const profileNorm = session.chromeProfilePath.toLowerCase().replace(/\\/g, "/");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await execPromise("powershell.exe", [
        "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
      ]);
      if (out.toLowerCase().replace(/\\/g, "/").includes(profileNorm)) return true;
    } catch {
      // retry once — CIM can be slow after system idle
    }
  }
  return false;
}

async function checkTerminalAlive(session) {
  if (!session.terminalOk) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (session.terminalHwnds && session.terminalHwnds.length > 0) {
      try {
        const result = await virtualDesktop.checkWindowsByHwnd(session.terminalHwnds);
        if (result.valid > 0) return true;
      } catch {
        // retry once — HWND checks can fail transiently after idle
      }
    }
    if (session.terminalPid) {
      try {
        const out = await execPromise("tasklist", [
          "/FI", `PID eq ${session.terminalPid}`,
          "/FO", "CSV", "/NH",
        ]);
        if (out.includes(String(session.terminalPid))) return true;
      } catch {
        // retry once
      }
    }
  }
  return false;
}

async function checkSessionHealth() {
  const visible = getVisibleSessions();
  const alive = [];
  const dead = [];
  const stale = [];
  const recovered = [];

  for (const s of visible) {
    const [chromeUp, termUp] = await Promise.all([
      checkChromeAlive(s),
      checkTerminalAlive(s),
    ]);
    const isAlive = chromeUp || termUp;

    if (s.status === "active" && !isAlive) {
      stale.push(s.sessionId);
    } else if (s.status === "stale" && !isAlive) {
      const staleAge = s.staleAt ? Date.now() - new Date(s.staleAt).getTime() : 0;
      if (staleAge >= STALE_GRACE_MS) {
        dead.push(s.sessionId);
      }
      // else: still within grace period, leave as stale
    } else if (s.status === "stale" && isAlive) {
      recovered.push(s.sessionId);
    } else {
      alive.push(s.sessionId);
    }
  }

  if (stale.length > 0 || dead.length > 0 || recovered.length > 0) {
    const now = new Date().toISOString();
    const staleSet = new Set(stale);
    const deadSet = new Set(dead);
    const recoveredSet = new Set(recovered);
    // Single synchronous read-modify-write, patching by sessionId against a
    // FRESH read — never overwrite the registry with the stale `visible`
    // snapshot we probed from (that snapshot may be minutes old by now).
    store.update((all) => {
      for (const s of all) {
        if (staleSet.has(s.sessionId)) {
          s.status = "stale";
          s.staleAt = now;
        } else if (deadSet.has(s.sessionId)) {
          s.status = "ended";
          s.endedAt = now;
        } else if (recoveredSet.has(s.sessionId)) {
          s.status = "active";
          delete s.staleAt;
        }
      }
      return all;
    });
  }

  return { checked: visible.length, alive, stale, dead, recovered };
}

// --- Reconcile sessions persisted by a previous server run ---

// Pure decision for a persisted session given a fresh liveness probe.
// Returns "adopt" (re-adopt a living session), "end" (mark a dead one ended),
// or "skip" (already ended/pruned — leave it alone).
function classifyReconcile(session, isAlive) {
  if (session.status !== "active" && session.status !== "stale") return "skip";
  return isAlive ? "adopt" : "end";
}

async function reconcilePreviousRunSessions() {
  const candidates = getVisibleSessions();
  if (candidates.length === 0) return { adopted: 0, ended: 0 };

  // Probe liveness OUTSIDE the store write (probes are async).
  const aliveById = new Map();
  for (const s of candidates) {
    const [chromeUp, termUp] = await Promise.all([checkChromeAlive(s), checkTerminalAlive(s)]);
    aliveById.set(s.sessionId, chromeUp || termUp);
  }

  let adopted = 0;
  let ended = 0;
  const now = new Date().toISOString();
  store.update((all) => {
    for (const s of all) {
      if (!aliveById.has(s.sessionId)) continue;
      const action = classifyReconcile(s, aliveById.get(s.sessionId));
      if (action === "adopt") {
        adopted++;
        if (s.status === "stale") { s.status = "active"; delete s.staleAt; }
      } else if (action === "end") {
        ended++;
        s.status = "ended";
        s.endedAt = now;
      }
    }
    return all;
  });
  return { adopted, ended };
}

// --- Teardown ---

async function killChromeByProfile(profilePath) {
  if (!profilePath) return { ok: false, error: "no_profile_path" };
  try {
    const out = await execPromise("powershell.exe", [
      "-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }",
    ]);
    const profileNorm = profilePath.toLowerCase().replace(/\\/g, "/");
    const pids = [];
    for (const line of out.split("\n")) {
      if (line.toLowerCase().replace(/\\/g, "/").includes(profileNorm)) {
        const match = line.match(/^(\d+)\|/);
        if (match) pids.push(match[1]);
      }
    }
    if (pids.length === 0) return { ok: true, killed: 0 };
    for (const pid of pids) {
      await execPromise("taskkill", ["/PID", pid, "/T", "/F"]).catch(() => {});
    }
    return { ok: true, killed: pids.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function killTerminalByHwnds(hwnds) {
  if (!hwnds || hwnds.length === 0) return { ok: true, skipped: true };
  try {
    // Send graceful WM_CLOSE first
    await virtualDesktop.closeWindowsByHwnd(hwnds);
    // Brief wait for graceful shutdown
    await new Promise((r) => setTimeout(r, 1500));
    // Check if windows are still alive — if so, force-kill via PID
    const check = await virtualDesktop.checkWindowsByHwnd(hwnds);
    if (check.valid > 0) {
      // Windows survived WM_CLOSE (Claude Code catching signals, cmd /k, etc.)
      // Resolve PIDs from HWNDs and force-kill the process trees
      const out = await execPromise("powershell.exe", [
        "-NoProfile", "-Command",
        `$hwnds = @(${hwnds.join(",")});` +
        `Add-Type @"
using System; using System.Runtime.InteropServices;
public class WP { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }
"@;` +
        `$pids = @(); foreach ($h in $hwnds) { $p = 0; [WP]::GetWindowThreadProcessId([IntPtr]$h, [ref]$p) | Out-Null; if ($p -gt 0) { $pids += $p } };` +
        `$pids | Select-Object -Unique | ForEach-Object { taskkill /PID $_ /T /F 2>$null }`,
      ], 10000);
      return { ok: true, method: "force-kill", details: out.trim() };
    }
    return { ok: true, method: "graceful" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function closeSession(sessionId) {
  const sessions = getSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session) return { ok: false, error: "session_not_found" };

  const steps = { terminal: null, chrome: null, desktop: null };

  // 1. Kill terminal — graceful WM_CLOSE first, force-kill if it survives
  if (session.terminalOk && session.terminalHwnds && session.terminalHwnds.length > 0) {
    steps.terminal = await killTerminalByHwnds(session.terminalHwnds);
  } else if (session.terminalOk && session.terminalPid) {
    // No HWNDs (virtual desktops unavailable) — fall back to PID-based kill
    try {
      await execPromise("taskkill", ["/PID", String(session.terminalPid), "/T", "/F"], 10000);
      steps.terminal = { ok: true, method: "pid-fallback" };
    } catch (err) {
      steps.terminal = { ok: false, error: err.message, method: "pid-fallback" };
    }
  } else {
    steps.terminal = { ok: true, skipped: true };
  }

  // 2. Kill Chrome by profile path
  if (session.chromeOk && session.chromeProfilePath) {
    steps.chrome = await killChromeByProfile(session.chromeProfilePath);
  } else {
    steps.chrome = { ok: true, skipped: true };
  }

  // 3. Delete virtual desktop (if it has a launcher-managed name)
  if (session.desktopName) {
    try {
      steps.desktop = await virtualDesktop.removeDesktopByName(session.desktopName);
    } catch (err) {
      steps.desktop = { ok: false, error: err.message };
    }
  } else {
    steps.desktop = { ok: true, skipped: true };
  }

  // 4. End session in registry
  endSession(sessionId);

  return { ok: true, steps };
}

async function forceCloseSession(sessionId) {
  const all = getSessions();
  const session = all.find((s) => s.sessionId === sessionId);
  if (!session) return { ok: false, error: "session_not_found" };

  const steps = {};
  if (session.terminalHwnds && session.terminalHwnds.length > 0) {
    try { steps.terminal = await killTerminalByHwnds(session.terminalHwnds); } catch (e) { steps.terminal = { ok: false, error: e.message }; }
  } else if (session.terminalPid) {
    try {
      await execPromise("taskkill", ["/PID", String(session.terminalPid), "/T", "/F"], 10000);
      steps.terminal = { ok: true, method: "pid-fallback" };
    } catch (e) { steps.terminal = { ok: false, error: e.message, method: "pid-fallback" }; }
  }
  try { steps.chrome = await killChromeByProfile(session.chromeProfilePath); } catch (e) { steps.chrome = { ok: false, error: e.message }; }
  if (session.desktopName) {
    try { steps.desktop = await virtualDesktop.removeDesktopByName(session.desktopName); } catch (e) { steps.desktop = { ok: false, error: e.message }; }
  }

  endSession(sessionId);
  return { ok: true, forced: true, steps };
}

async function closeSessions(sessionIds) {
  const results = [];
  for (const id of sessionIds) {
    try {
      const result = await closeSession(id);
      results.push({ sessionId: id, ...result });
    } catch (err) {
      results.push({ sessionId: id, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  getSessions,
  getActiveSessions,
  getVisibleSessions,
  getLaunchBlockingSessions,
  getSessionByAccountId,
  registerSession,
  endSession,
  markSessionsEnded,
  pruneEndedSessions,
  reconcilePreviousRunSessions,
  classifyReconcile,
  checkSessionHealth,
  closeSession,
  forceCloseSession,
  closeSessions,
};
