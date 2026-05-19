param(
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][string]$SignalFile,
    [Parameter(Mandatory)][int]$NodePid,
    [string]$IconPath
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$appContext = New-Object System.Windows.Forms.ApplicationContext

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = "DR Launcher (port $Port)"
$notifyIcon.Visible = $true

if ($IconPath -and (Test-Path $IconPath)) {
    try {
        $notifyIcon.Icon = New-Object System.Drawing.Icon($IconPath)
    } catch {
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
    }
} else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open DR Launcher"
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$openItem.Add_Click({
    Start-Process "http://127.0.0.1:$Port"
})
$contextMenu.Items.Add($openItem) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$quitItem.Text = "Quit"
$quitItem.Add_Click({
    try { Set-Content -Path $SignalFile -Value "quit" -Encoding utf8 } catch {}
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    $timer.Stop()
    $appContext.ExitThread()
})
$contextMenu.Items.Add($quitItem) | Out-Null

$notifyIcon.ContextMenuStrip = $contextMenu

$notifyIcon.Add_DoubleClick({
    Start-Process "http://127.0.0.1:$Port"
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
    try {
        Get-Process -Id $NodePid -ErrorAction Stop | Out-Null
    } catch {
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
        $timer.Stop()
        $appContext.ExitThread()
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($appContext)
