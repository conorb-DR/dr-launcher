# BUG: Virtual Desktop Launch Fails Silently

**Status:** Fixed (pending user verification)
**Severity:** P1 - Feature completely broken
**Component:** `lib/scripts/vdesktop.ps1`, `lib/virtual-desktop.js`
**Date:** 2026-05-18

---

## Summary

The "Launch to Virtual Desktop" feature fails on every attempt. The UI shows an error toast ("can't launch the desktop"). The root cause is two separate bugs that compound: a PowerShell reserved variable collision crashes the window enumeration script, and the resulting cached "unavailable" status prevents all subsequent launch attempts for the lifetime of the server process.

---

## Root Causes

### Bug 1: `$PID` is a read-only automatic variable in PowerShell

**File:** `lib/scripts/vdesktop.ps1` line 92
**Severity:** Fatal - crashes the script

The `Get-AllTopLevelWindows` function used `$pid` as a loop variable to store the process ID returned from `EnumWindows`. In PowerShell, `$PID` is a read-only automatic variable containing the current process ID. Attempting to assign to it throws:

```
Cannot overwrite variable PID because it is read-only or constant.
CategoryInfo: WriteError: (PID:String) [vdesktop.ps1], SessionStateUnauthorizedAccessException
```

This crash affects the `snapshot` and `launch` actions (both call `Get-AllTopLevelWindows`). The `check` action does NOT call this function, so it succeeds — but only when run in isolation. When run as part of the server startup sequence, the module is imported once and the Add-Type C# class persists, masking the issue until a snapshot is attempted.

**Why it wasn't caught earlier:** The `check` action (used for the health endpoint and startup validation) doesn't enumerate windows, so it passes. The bug only manifests when `snapshot` or `launch` is called. Direct PowerShell testing of `check` always succeeded, giving a false sense that the module was working.

**Fix:** Rename `$pid` to `$wpid` in the `Get-AllTopLevelWindows` function.

```powershell
# Before (broken)
$pid = $w[1]
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue

# After (fixed)
$wpid = $w[1]
$proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
```

---

### Bug 2: Empty string passed as PowerShell parameter value

**File:** `lib/virtual-desktop.js` line 109-110
**Severity:** Fatal - crashes the script invocation

When the `snapshotWindows()` result contains empty arrays (e.g., no terminal windows open), the Node wrapper joins them with `[].join(",")` which produces an empty string `""`. This is passed to PowerShell as:

```
-TerminalHwndsBefore ""
```

PowerShell interprets `""` as a missing argument for a string parameter and throws:

```
Missing an argument for parameter 'TerminalHwndsBefore'.
Specify a parameter of type 'System.String' and try again.
```

**Fix:** Pass the sentinel string `"none"` instead of empty string, and update `Parse-HwndList` in the PowerShell script to handle it:

```javascript
// Node wrapper (virtual-desktop.js)
"-ChromeHwndsBefore", chromeHwnds || "none",
"-TerminalHwndsBefore", terminalHwnds || "none",
```

```powershell
# PowerShell (vdesktop.ps1)
function Parse-HwndList([string]$csv) {
    if ([string]::IsNullOrWhiteSpace($csv) -or $csv -eq "none") { return @() }
    return $csv.Split(",") | ForEach-Object { [long]$_.Trim() }
}
```

---

### Compounding Factor: Availability cache poisons the entire server session

**File:** `lib/virtual-desktop.js` lines 63-79

The `checkAvailability()` result is cached in `_availability` and never invalidated. During server startup, the health check calls `checkAvailability()`. If Bug 1 causes this to return `{ ok: false }` (which it does when the `check` action happens to trigger the Add-Type compilation that later fails), the cached result persists. Every subsequent `isAvailable()` call returns `false` without re-testing, so the launch route skips virtual desktop entirely and returns:

```json
{
  "virtualDesktop": {
    "enabled": true,
    "ok": false,
    "error": "Virtual desktop not available on this system"
  }
}
```

**Note:** This cache behavior is by design (avoid re-running the check on every launch) but means a server restart is required after any fix to the underlying script.

---

## Reproduction Steps

1. Start DR Launcher server (`node server.js`)
2. Enable virtual desktops in Settings
3. Click "Launch" on any customer card
4. Observe error toast: "can't launch the desktop"

**Pre-conditions:** Windows 11 (build 26200), PowerShell 5.1, vendored PSVirtualDesktop module loaded successfully.

---

## Files Changed

| File | Change |
|---|---|
| `lib/scripts/vdesktop.ps1` | Renamed `$pid` to `$wpid` in `Get-AllTopLevelWindows` (lines 92, 96, 99, 103) |
| `lib/scripts/vdesktop.ps1` | Added `"none"` sentinel handling to `Parse-HwndList` |
| `lib/virtual-desktop.js` | Pass `"none"` instead of empty string for empty HWND lists |

---

## Verification

After applying fixes:

```
# check action — passes (always did)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File vdesktop.ps1 -Action check
# => {"ok":true,"desktopCount":2,...}

# snapshot action — NOW passes (was crashing)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File vdesktop.ps1 -Action snapshot
# => {"ok":true,"chrome":[2887982,1572940,2037076],"terminal":[]}

# launch action with empty terminal list — NOW passes (was crashing)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File vdesktop.ps1 -Action launch -Name "Test" -ChromeHwndsBefore "123" -TerminalHwndsBefore "none" ...
# => {"ok":true,"created":true,"switched":true,...}

# Node execFile — NOW passes
node -e "execFile('powershell.exe', [..., '-Action', 'check'], ...)"
# => {"ok":true,...}

# Server startup — NOW shows "Virtual desktops: available"
```

---

## Remaining Risk

The window-move-and-verify logic (`Move-Window`, `Get-DesktopFromWindow`, `Switch-Desktop`) has not been tested end-to-end with a real customer launch after these fixes, because the bugs prevented execution from ever reaching that code path. There may be additional issues in steps 5-8 of the launch flow (pinned window detection, move, verify, switch) that were masked by the early crash.

---

## Lessons Learned

1. **PowerShell automatic variables are landmines.** `$PID`, `$PWD`, `$HOME`, `$HOST`, `$NULL`, `$TRUE`, `$FALSE`, `$ERROR`, `$_`, `$PSItem` are all reserved. Use prefixed names (`$w_pid`, `$wpid`) for loop variables in scripts that will be called from Node.

2. **Test every action path, not just the health check.** The `check` action passing gave false confidence. A simple `snapshot` test from Node would have caught Bug 1 immediately.

3. **Cached availability with no invalidation is fragile.** Consider adding a `--force-recheck` option or a TTL to `_availability` so transient failures don't poison the entire session.

4. **PowerShell handles empty string params differently than most shells.** Always pass a non-empty sentinel and handle it on the receiving side.

---

# BUG: Batch Launch — Single Virtual Desktop, Ghost Sessions, Stale Port Lock

**Status:** Fixed (pending user verification)
**Severity:** P1 - Batch launch workflow broken
**Component:** `server.js`, `lib/sessions.js`, `lib/virtual-desktop.js`, `lib/scripts/vdesktop.ps1`, `public/app.js`
**Date:** 2026-05-19

---

## Summary

Launching 4 customer environments in a batch resulted in: (1) only one virtual desktop being created with all windows on it, (2) none of the sessions showing as active in the UI, and (3) the app refusing to reopen after restart ("another application is using Claude").

---

## Root Causes

### Bug 4: `IsWindowVisible()` only returns windows on the current virtual desktop

**File:** `lib/scripts/vdesktop.ps1` — `GetVisibleWindows()` C# method

`EnumWindows` + `IsWindowVisible` only enumerates windows on the **active** virtual desktop. After the first batch launch creates VD1 and switches to it via `Switch-Desktop`, subsequent snapshot calls (which use `IsWindowVisible`) capture only VD1's windows as the baseline. This incomplete baseline causes the VD creation path to fail for launches 2-4, leaving their Chrome/Terminal windows on VD1 (the current desktop).

**Fix:**
- Added `GetAllTitledWindows()` C# method that skips `IsWindowVisible` — captures windows across ALL virtual desktops
- `Get-WindowSnapshot` now uses `GetAllTitledWindows()` for the baseline snapshot
- Polling (current-desktop detection for new windows) still uses `GetVisibleWindows()` — only the baseline needs cross-desktop visibility
- Added `-NoSwitch` parameter to the `launch` action — batch launches skip `Switch-Desktop` so subsequent snapshots run on the original desktop
- Added `switch` action to `vdesktop.ps1` — frontend switches to the last desktop after all batch items complete
- Server accepts `noSwitch` in POST /api/launch body; frontend sends it for batch launches (>1 item)
- New `POST /api/switch-desktop` endpoint for the post-batch switch

### Bug 5: Stale sessions from previous server runs block new registration

**File:** `lib/sessions.js`, `server.js`

Sessions persist in `settings.json` with `status: "active"`. When the server crashes or is killed without cleanup, those sessions remain. On restart, `registerSession()` checks for duplicates by `accountId` — if a stale session matches, registration silently fails (return value was never checked). This caused sessions to not appear in the UI.

**Fix:**
- Added `clearStaleSessions()` to `sessions.js` — wipes all active sessions on server startup (fresh server = no valid sessions)
- `registerSession()` return value is now checked; failures are logged to console with `[session]` prefix
- Registration errors are included in the launch response as `result.sessionError`

### Bug 6: No graceful shutdown / PID file — zombie server holds port

**File:** `server.js`

The Express server had no shutdown handler. When the terminal was closed, the Node process could linger (detached children, pending timers), holding port 3456. The next startup attempt tried 3 ports and either failed completely or started on a different port with a new API token — the old browser tab was now pointed at a dead/wrong server.

**Fix:**
- Added PID file at `%LOCALAPPDATA%/DR Launcher/server.pid` (written on startup, removed on shutdown)
- On startup, `killPreviousServer()` reads the PID file and sends SIGTERM to any lingering process before binding
- Added `SIGINT` / `SIGTERM` handlers for graceful shutdown (removes PID file, closes HTTP server)
- `process.on("exit")` as final cleanup for the PID file
