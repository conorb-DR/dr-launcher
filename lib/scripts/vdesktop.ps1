param(
    [Parameter(Mandatory)]
    [ValidateSet("check", "snapshot", "launch", "delete", "close", "check-hwnd", "switch")]
    [string]$Action,

    [string]$Name = "",
    [string]$AllHwndsBefore = "",
    [int]$ChromePid = 0,
    [int]$TerminalPid = 0,
    [string]$TerminalTitleMatch = "",
    [int]$PollTimeoutMs = 5000,
    [int]$PollIntervalMs = 300,
    [string]$Hwnds = "",
    [switch]$NoSwitch
)

$ErrorActionPreference = "Stop"

# Import vendored PSVirtualDesktop module
$modulePath = Join-Path $PSScriptRoot "..\vendor\VirtualDesktop\VirtualDesktop.psm1"
try {
    Import-Module $modulePath -Force -DisableNameChecking -ErrorAction Stop
} catch {
    $result = @{
        ok = $false
        error = "Failed to import VirtualDesktop module: $($_.Exception.Message)"
    }
    $result | ConvertTo-Json -Compress
    exit 1
}

# --- Win32 EnumWindows for ALL top-level windows ---
# Get-Process only returns ONE MainWindowHandle per process.
# Chrome runs many windows in one process, so we need EnumWindows.
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class Win32Windows {
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static List<long[]> GetVisibleWindows() {
        // Returns list of [hwnd, pid] — only windows visible on the CURRENT virtual desktop
        var results = new List<long[]>();
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                results.Add(new long[] { (long)hWnd, (long)pid });
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }

    public static List<long[]> GetAllTitledWindows() {
        // Returns list of [hwnd, pid] — ALL windows with a title, across ALL virtual desktops
        var results = new List<long[]>();
        EnumWindows((hWnd, lParam) => {
            if (GetWindowTextLength(hWnd) > 0) {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                results.Add(new long[] { (long)hWnd, (long)pid });
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, out RECT pvParam, uint fWinIni);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static int[] GetWorkArea() {
        RECT r;
        SystemParametersInfo(0x0030 /* SPI_GETWORKAREA */, 0, out r, 0);
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static void TileLeftRight(long leftHwnd, long rightHwnd) {
        var wa = GetWorkArea();
        int x = wa[0], y = wa[1], w = wa[2], h = wa[3];
        int half = w / 2;
        IntPtr hLeft = new IntPtr(leftHwnd);
        IntPtr hRight = new IntPtr(rightHwnd);
        // SW_RESTORE = 9 — un-maximize before repositioning
        ShowWindow(hLeft, 9);
        ShowWindow(hRight, 9);
        // SWP_NOZORDER | SWP_NOACTIVATE = 0x0014
        SetWindowPos(hLeft,  IntPtr.Zero, x,        y, half, h, 0x0014);
        SetWindowPos(hRight, IntPtr.Zero, x + half, y, half, h, 0x0014);
    }

    public static string GetTitle(long hwnd) {
        IntPtr hWnd = new IntPtr(hwnd);
        int len = GetWindowTextLength(hWnd);
        if (len == 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static bool CloseByHwnd(long hwnd) {
        IntPtr hWnd = new IntPtr(hwnd);
        if (!IsWindow(hWnd)) return false;
        return PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }

    public static bool IsValidWindow(long hwnd) {
        return IsWindow(new IntPtr(hwnd));
    }
}
"@ -ErrorAction SilentlyContinue

function Get-AllTopLevelWindows {
    <#
    .SYNOPSIS
    Get ALL visible top-level windows with their titles and process names.
    Uses Win32 EnumWindows, not Get-Process (which only returns one handle per process).
    #>
    $windows = [Win32Windows]::GetVisibleWindows()
    $result = @()
    foreach ($w in $windows) {
        $hwnd = $w[0]
        $wpid = $w[1]
        $title = [Win32Windows]::GetTitle($hwnd)
        $procName = ""
        try {
            $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
            if ($proc) { $procName = $proc.ProcessName }
        } catch {}
        $result += [PSCustomObject]@{
            Hwnd = $hwnd
            Pid = $wpid
            Title = $title
            ProcessName = $procName
        }
    }
    return $result
}

function Get-AllTitledWindowsCrossDesktop {
    <#
    .SYNOPSIS
    Fast cross-desktop window enumeration. Returns Hwnd, Pid, and Title for ALL
    windows with a title, across ALL virtual desktops. Skips Get-Process (which is
    extremely slow at scale) — ProcessName is left empty. Used in the poll loop
    where only Hwnd/Pid/Title matter for matching.
    #>
    $windows = [Win32Windows]::GetAllTitledWindows()
    $result = @()
    foreach ($w in $windows) {
        $result += [PSCustomObject]@{
            Hwnd = $w[0]
            Pid = $w[1]
            Title = [Win32Windows]::GetTitle($w[0])
            ProcessName = ""
        }
    }
    return $result
}

function Get-WindowSnapshot {
    <#
    .SYNOPSIS
    Returns ALL window HWNDs across ALL virtual desktops as a baseline list.
    Uses GetAllTitledWindows (no IsWindowVisible filter) so switching desktops
    between batch launches doesn't cause subsequent snapshots to miss windows.
    Only collects HWNDs — no Get-Process calls, no title lookups — so it's fast
    even with hundreds of system/background windows.
    #>
    $windows = [Win32Windows]::GetAllTitledWindows()
    $allHwnds = @()
    foreach ($w in $windows) {
        $allHwnds += [long]$w[0]
    }
    return @{
        ok = $true
        all = $allHwnds
        chrome = @()
        terminal = @()
    }
}

function Find-WindowsByPid {
    param(
        [int]$TargetPid,
        [long[]]$BeforeHwnds
    )
    <#
    .SYNOPSIS
    Find visible windows owned by a specific PID (or its child processes)
    that were NOT in the before-snapshot.
    #>
    if ($TargetPid -eq 0) { return @() }

    # Build list of PIDs in the process tree (parent + children)
    $pidSet = @($TargetPid)
    try {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetPid" -ErrorAction SilentlyContinue
        foreach ($c in $children) {
            $pidSet += [int]$c.ProcessId
        }
    } catch {}

    $all = Get-AllTopLevelWindows
    $found = @()

    foreach ($w in $all) {
        if ([int]$w.Pid -in $pidSet -and $w.Hwnd -notin $BeforeHwnds) {
            $found += [long]$w.Hwnd
        }
    }

    return $found
}

function Find-WindowsByTitle {
    param(
        [string]$TitleMatch
    )
    <#
    .SYNOPSIS
    Find ANY window whose title contains the given string.
    Does NOT require the HWND to be new — the unique launch ID in
    the title is sufficient proof. This handles Windows Terminal
    delegating to an existing process (same HWND, new title).
    #>
    if ([string]::IsNullOrWhiteSpace($TitleMatch)) { return @() }

    $all = Get-AllTopLevelWindows
    $found = @()

    foreach ($w in $all) {
        if ($w.Title -like "*$TitleMatch*") {
            $found += [long]$w.Hwnd
        }
    }

    return $found
}

function Parse-HwndList([string]$csv) {
    if ([string]::IsNullOrWhiteSpace($csv) -or $csv -eq "none") { return @() }
    return $csv.Split(",") | ForEach-Object { [long]$_.Trim() }
}

# ---- ACTION: check ----
if ($Action -eq "check") {
    try {
        $desktops = Get-DesktopList
        $count = $desktops.Count
        $langMode = $ExecutionContext.SessionState.LanguageMode.ToString()

        $supportsNaming = $true
        try {
            $testName = Get-DesktopName -Desktop 0
        } catch {
            $supportsNaming = $false
        }

        $result = @{
            ok = $true
            desktopCount = $count
            supportsNaming = $supportsNaming
            languageMode = $langMode
            osBuild = [System.Environment]::OSVersion.Version.Build
        }
    } catch {
        $result = @{
            ok = $false
            error = $_.Exception.Message
            languageMode = $ExecutionContext.SessionState.LanguageMode.ToString()
        }
    }
    $result | ConvertTo-Json -Compress
    exit 0
}

# ---- ACTION: snapshot ----
if ($Action -eq "snapshot") {
    $handles = Get-WindowSnapshot
    $result = @{
        ok = $true
        all = $handles.all
        chrome = $handles.chrome
        terminal = $handles.terminal
    }
    $result | ConvertTo-Json -Compress
    exit 0
}

# ---- ACTION: launch ----
if ($Action -eq "launch") {
    $result = @{
        ok = $false
        phase = "init"
        created = $false
        reused = $false
        switched = $false
        desktopName = $Name
        desktopIndex = -1
        windowsFound = @{ chrome = 0; terminal = 0 }
        movedChrome = $false
        verifiedChrome = $false
        movedTerminal = $false
        verifiedTerminal = $false
        pinnedWarning = $null
        error = $null
        debug = @{
            termPidSet = @()
            chromePidSet = @()
            termFoundBy = "none"
            chromeFoundBy = "none"
            allBeforeCount = 0
            pollIterations = 0
            candidateTermTitles = @()
        }
    }

    $allBefore = Parse-HwndList $AllHwndsBefore
    $result.debug.allBeforeCount = $allBefore.Count

    # Step 1: Check for existing desktop with this name (reuse)
    $result.phase = "find_existing"
    $targetIndex = -1
    try {
        $desktops = Get-DesktopList
        for ($i = 0; $i -lt $desktops.Count; $i++) {
            try {
                $dName = Get-DesktopName -Desktop $i
                if ($dName -eq $Name) {
                    $targetIndex = $i
                    $result.reused = $true
                    break
                }
            } catch {}
        }
    } catch {}

    # Step 2: Create new desktop if not reusing
    if ($targetIndex -eq -1) {
        $result.phase = "create_desktop"
        try {
            $newDesktop = New-Desktop
            $desktops = Get-DesktopList
            $targetIndex = $desktops.Count - 1
            $result.created = $true
        } catch {
            $result.error = "create_desktop_failed: $($_.Exception.Message)"
            $result | ConvertTo-Json -Compress
            exit 0
        }
    }

    $result.desktopIndex = $targetIndex

    # Resolve desktop object from index (required by Move-Window, etc.)
    $targetDesktop = Get-Desktop -Index $targetIndex

    # Step 3: Name the desktop
    $result.phase = "name_desktop"
    if (-not $result.reused -and $Name -ne "") {
        try {
            Set-DesktopName -Desktop $targetDesktop -Name $Name
        } catch {}
    }

    # Step 4: Poll for new windows
    $result.phase = "poll_windows"

    # Resolve PID trees ONCE upfront (WMI is slow — never call it in a loop)
    $chromePidSet = @()
    if ($ChromePid -gt 0) {
        $chromePidSet = @($ChromePid)
        try {
            $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ChromePid" -ErrorAction SilentlyContinue
            foreach ($c in $children) { $chromePidSet += [int]$c.ProcessId }
        } catch {}
    }

    $termPidSet = @()
    if ($TerminalPid -gt 0) {
        $termPidSet = @($TerminalPid)
        try {
            $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $TerminalPid" -ErrorAction SilentlyContinue
            foreach ($c in $children) { $termPidSet += [int]$c.ProcessId }
        } catch {}
        # wt.exe is a single-instance launcher — it delegates to an already-running
        # WindowsTerminal.exe and exits. Include ALL WindowsTerminal.exe PIDs so we
        # can match windows created by the existing process.
        try {
            $wtProcs = Get-Process -Name "WindowsTerminal" -ErrorAction SilentlyContinue
            foreach ($p in $wtProcs) { if ($p.Id -notin $termPidSet) { $termPidSet += [int]$p.Id } }
        } catch {}
    }

    $result.debug.termPidSet = $termPidSet
    $result.debug.chromePidSet = $chromePidSet

    $elapsed = 0
    $newChromeHwnds = @()
    $newTerminalHwnds = @()

    while ($elapsed -lt $PollTimeoutMs) {
        Start-Sleep -Milliseconds $PollIntervalMs
        $elapsed += $PollIntervalMs

        # Visible windows (current desktop) — used for Chrome PID matching
        $allWindows = Get-AllTopLevelWindows
        # Cross-desktop windows — used for terminal detection because wt.exe
        # delegates to an existing WindowsTerminal.exe whose windows may be
        # on a different virtual desktop
        $allWindowsCross = Get-AllTitledWindowsCrossDesktop

        # Chrome: match by PID tree (current desktop — Chrome opens where we are)
        $newChromeHwnds = @()
        foreach ($w in $allWindows) {
            if ([int]$w.Pid -in $chromePidSet -and $w.Hwnd -notin $allBefore) {
                $newChromeHwnds += [long]$w.Hwnd
                $result.debug.chromeFoundBy = "pid"
            }
        }

        # Terminal: title match is the primary strategy (cross-desktop).
        # wt.exe is single-instance — it delegates to an existing WindowsTerminal.exe,
        # so the spawned PID is useless after the first launch. The unique launchId in
        # the title is the reliable identifier.
        $newTerminalHwnds = @()
        if ($TerminalTitleMatch) {
            foreach ($w in $allWindowsCross) {
                if ($w.Title -like "*$TerminalTitleMatch*") {
                    $newTerminalHwnds += [long]$w.Hwnd
                }
            }
            if ($newTerminalHwnds.Count -gt 0) {
                $result.debug.termFoundBy = "title"
            }
        }
        # Fallback: PID tree match (works for first launch when wt.exe spawns fresh)
        if ($newTerminalHwnds.Count -eq 0) {
            foreach ($w in $allWindowsCross) {
                if ([int]$w.Pid -in $termPidSet -and $w.Hwnd -notin $allBefore) {
                    $newTerminalHwnds += [long]$w.Hwnd
                }
            }
            if ($newTerminalHwnds.Count -gt 0) {
                $result.debug.termFoundBy = "pid"
            }
        }

        # Capture candidate titles containing "DR Launcher" on last iteration
        $result.debug.candidateTermTitles = @($allWindowsCross | Where-Object { $_.Title -like "*DR Launcher*" -or $_.Title -like "*WindowsTerminal*" -or $_.ProcessName -eq "WindowsTerminal" } | ForEach-Object { "$($_.Hwnd):$($_.Title)" })
        $result.debug.pollIterations = [math]::Ceiling($elapsed / $PollIntervalMs)

        if ($newChromeHwnds.Count -gt 0 -and $newTerminalHwnds.Count -gt 0) {
            break
        }
    }

    $result.windowsFound.chrome = @($newChromeHwnds).Count
    $result.windowsFound.terminal = @($newTerminalHwnds).Count

    # Step 5: Check for pinned windows
    $result.phase = "check_pinned"
    try {
        foreach ($hwnd in @($newChromeHwnds) + @($newTerminalHwnds)) {
            if ($hwnd -and $hwnd -ne 0) {
                $pinned = Test-WindowPinned -Hwnd $hwnd -ErrorAction SilentlyContinue
                if ($pinned) {
                    $result.pinnedWarning = "One or more windows are pinned to all desktops. Virtual desktop isolation will not work for pinned windows."
                    break
                }
            }
        }
    } catch {}

    # Step 6: Move windows to target desktop
    $result.phase = "move_windows"

    foreach ($hwnd in $newChromeHwnds) {
        try {
            Move-Window -Desktop $targetDesktop -Hwnd $hwnd | Out-Null
            $result.movedChrome = $true
        } catch {
            $result.error = "move_chrome_failed: $($_.Exception.Message)"
        }
    }

    foreach ($hwnd in $newTerminalHwnds) {
        try {
            Move-Window -Desktop $targetDesktop -Hwnd $hwnd | Out-Null
            $result.movedTerminal = $true
        } catch {
            $result.error = "move_terminal_failed: $($_.Exception.Message)"
        }
    }

    # Step 7: Verify windows are on the target desktop
    $result.phase = "verify"
    if ($result.movedChrome) {
        foreach ($hwnd in $newChromeHwnds) {
            try {
                $actualIdx = Get-DesktopIndex -Desktop (Get-DesktopFromWindow -Hwnd $hwnd)
                if ($actualIdx -eq $targetIndex) {
                    $result.verifiedChrome = $true
                }
            } catch {}
        }
    }

    if ($result.movedTerminal) {
        foreach ($hwnd in $newTerminalHwnds) {
            try {
                $actualIdx = Get-DesktopIndex -Desktop (Get-DesktopFromWindow -Hwnd $hwnd)
                if ($actualIdx -eq $targetIndex) {
                    $result.verifiedTerminal = $true
                }
            } catch {}
        }
    }

    # Step 8: Tile windows — Chrome left, Terminal right
    $result.phase = "tile"
    $result.tiled = $false
    if ($newChromeHwnds.Count -gt 0 -and $newTerminalHwnds.Count -gt 0) {
        try {
            [Win32Windows]::TileLeftRight([long]$newChromeHwnds[0], [long]$newTerminalHwnds[0])
            $result.tiled = $true
        } catch {
            $result.tileError = "tile_failed: $($_.Exception.Message)"
        }
    }

    # Step 9: Switch to the target desktop (unless -NoSwitch)
    $result.phase = "switch"
    if ($NoSwitch) {
        $result.switched = $false
        $result.switchSkipped = $true
    } else {
        try {
            Switch-Desktop -Desktop $targetDesktop | Out-Null
            $result.switched = $true
        } catch {
            $result.error = "switch_failed: $($_.Exception.Message)"
        }
    }

    $result.phase = "complete"
    $result.ok = $result.switchSkipped -or $result.switched -or $result.movedChrome -or $result.movedTerminal
    $result.chromeHwnds = @($newChromeHwnds)
    $result.terminalHwnds = @($newTerminalHwnds)

    $result | ConvertTo-Json -Compress
    exit 0
}

# ---- ACTION: switch ----
if ($Action -eq "switch") {
    $result = @{ ok = $false; desktopName = $Name; error = $null }

    if ([string]::IsNullOrWhiteSpace($Name)) {
        $result.error = "No desktop name provided"
        $result | ConvertTo-Json -Compress
        exit 0
    }

    try {
        $desktops = Get-DesktopList
        $targetIndex = -1
        for ($i = 0; $i -lt $desktops.Count; $i++) {
            try {
                $dName = Get-DesktopName -Desktop $i
                if ($dName -eq $Name) {
                    $targetIndex = $i
                    break
                }
            } catch {}
        }

        if ($targetIndex -eq -1) {
            $result.error = "Desktop '$Name' not found"
            $result | ConvertTo-Json -Compress
            exit 0
        }

        $targetDesktop = Get-Desktop -Index $targetIndex
        Switch-Desktop -Desktop $targetDesktop | Out-Null
        $result.ok = $true
    } catch {
        $result.error = "switch_failed: $($_.Exception.Message)"
    }

    $result | ConvertTo-Json -Compress
    exit 0
}

# ---- ACTION: delete ----
if ($Action -eq "delete") {
    $result = @{ ok = $false; desktopName = $Name; error = $null }

    if ([string]::IsNullOrWhiteSpace($Name)) {
        $result.error = "No desktop name provided"
        $result | ConvertTo-Json -Compress
        exit 0
    }

    try {
        $desktops = Get-DesktopList
        if ($desktops.Count -le 1) {
            $result.error = "Cannot delete the only remaining desktop"
            $result | ConvertTo-Json -Compress
            exit 0
        }

        $targetIndex = -1
        for ($i = 0; $i -lt $desktops.Count; $i++) {
            try {
                $dName = Get-DesktopName -Desktop $i
                if ($dName -eq $Name) {
                    $targetIndex = $i
                    break
                }
            } catch {}
        }

        if ($targetIndex -eq -1) {
            $result.error = "Desktop not found: $Name"
            $result | ConvertTo-Json -Compress
            exit 0
        }

        $currentIndex = Get-DesktopIndex -Desktop (Get-CurrentDesktop)
        if ($currentIndex -eq $targetIndex) {
            $switchTo = if ($targetIndex -gt 0) { $targetIndex - 1 } else { 1 }
            Switch-Desktop -Desktop (Get-Desktop -Index $switchTo) | Out-Null
        }

        $targetDesktop = Get-Desktop -Index $targetIndex
        Remove-Desktop -Desktop $targetDesktop | Out-Null
        $result.ok = $true
    } catch {
        $result.error = $_.Exception.Message
    }

    $result | ConvertTo-Json -Compress
    exit 0
}

# ---- ACTION: close ----
if ($Action -eq "close") {
    $hwndList = Parse-HwndList $Hwnds
    $result = @{ ok = $true; closed = 0; invalid = 0; failed = 0 }

    foreach ($hwnd in $hwndList) {
        if (-not [Win32Windows]::IsValidWindow($hwnd)) {
            $result.invalid++
            continue
        }
        $sent = [Win32Windows]::CloseByHwnd($hwnd)
        if ($sent) {
            $result.closed++
        } else {
            $result.failed++
        }
    }

    $result | ConvertTo-Json -Compress
    exit 0
}

# ---- ACTION: check-hwnd ----
if ($Action -eq "check-hwnd") {
    $hwndList = Parse-HwndList $Hwnds
    $result = @{ ok = $true; valid = 0; invalid = 0; total = $hwndList.Count }

    foreach ($hwnd in $hwndList) {
        if ([Win32Windows]::IsValidWindow($hwnd)) {
            $result.valid++
        } else {
            $result.invalid++
        }
    }

    $result | ConvertTo-Json -Compress
    exit 0
}
