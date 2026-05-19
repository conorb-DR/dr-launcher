const { execFile } = require("child_process");
const settings = require("./settings");
const virtualDesktop = require("./virtual-desktop");

const PRUNE_AGE_MS = 5 * 60 * 1000;

function getSessions() {
  return settings.getSettings().activeSessions || [];
}

function clearStaleSessions() {
  const sessions = getSessions();
  const active = sessions.filter((s) => s.status === "active");
  if (active.length === 0) return { cleared: 0 };
  settings.updateSettings({ activeSessions: [] });
  return { cleared: active.length };
}

function getActiveSessions() {
  return getSessions().filter((s) => s.status === "active");
}

function getSessionByAccountId(accountId) {
  return getActiveSessions().find((s) => s.accountId === accountId) || null;
}

function registerSession(data) {
  const existing = getSessionByAccountId(data.accountId);
  if (existing) {
    return { ok: false, error: "active_session_exists" };
  }
  const sessions = getSessions();
  sessions.push({ ...data, status: "active", endedAt: null });
  settings.updateSettings({ activeSessions: sessions });
  return { ok: true };
}

function endSession(sessionId) {
  const sessions = getSessions();
  const s = sessions.find((x) => x.sessionId === sessionId);
  if (!s) return false;
  s.status = "ended";
  s.endedAt = new Date().toISOString();
  settings.updateSettings({ activeSessions: sessions });
  return true;
}

function markSessionsEnded(sessionIds) {
  if (!sessionIds.length) return;
  const sessions = getSessions();
  const idSet = new Set(sessionIds);
  const now = new Date().toISOString();
  for (const s of sessions) {
    if (idSet.has(s.sessionId) && s.status === "active") {
      s.status = "ended";
      s.endedAt = now;
    }
  }
  settings.updateSettings({ activeSessions: sessions });
}

function pruneEndedSessions() {
  const sessions = getSessions();
  const cutoff = Date.now() - PRUNE_AGE_MS;
  const kept = sessions.filter(
    (s) => s.status === "active" || !s.endedAt || new Date(s.endedAt).getTime() > cutoff
  );
  if (kept.length !== sessions.length) {
    settings.updateSettings({ activeSessions: kept });
  }
  return kept;
}

// --- Health checking ---

function execPromise(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout || "");
    });
  });
}

async function checkChromeAlive(session) {
  if (!session.chromeOk || !session.chromeProfilePath) return false;
  try {
    const out = await execPromise("powershell.exe", [
      "-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
    ]);
    const profileNorm = session.chromeProfilePath.toLowerCase().replace(/\\/g, "/");
    return out.toLowerCase().replace(/\\/g, "/").includes(profileNorm);
  } catch {
    return false;
  }
}

async function checkTerminalAlive(session) {
  if (!session.terminalOk) return false;
  if (session.terminalHwnds && session.terminalHwnds.length > 0) {
    try {
      const result = await virtualDesktop.checkWindowsByHwnd(session.terminalHwnds);
      return result.valid > 0;
    } catch {
      return false;
    }
  }
  if (session.terminalPid) {
    try {
      const out = await execPromise("tasklist", [
        "/FI", `PID eq ${session.terminalPid}`,
        "/FO", "CSV", "/NH",
      ]);
      return out.includes(String(session.terminalPid));
    } catch {
      return false;
    }
  }
  return false;
}

async function checkSessionHealth(sessions) {
  if (!sessions) sessions = getActiveSessions();
  const alive = [];
  const dead = [];
  for (const s of sessions) {
    const [chromeUp, termUp] = await Promise.all([
      checkChromeAlive(s),
      checkTerminalAlive(s),
    ]);
    if (chromeUp || termUp) {
      alive.push(s.sessionId);
    } else {
      dead.push(s.sessionId);
    }
  }
  if (dead.length > 0) {
    markSessionsEnded(dead);
  }
  return { checked: sessions.length, alive, dead };
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
  getSessionByAccountId,
  registerSession,
  endSession,
  markSessionsEnded,
  pruneEndedSessions,
  clearStaleSessions,
  checkSessionHealth,
  closeSession,
  closeSessions,
};
