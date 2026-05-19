' DR Launcher — silent launcher (VBS prototype)
' Starts the Node server hidden (no console window) or opens the browser
' to an already-running instance. Production target is Launcher.cs (C#).

Option Explicit

Dim fso, shell, pidPath, appDir, nodeExe, serverJs, openBrowserJs

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Resolve paths relative to this script's location
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = fso.BuildPath(appDir, "node\node.exe")
serverJs = fso.BuildPath(appDir, "app\server.js")
openBrowserJs = fso.BuildPath(appDir, "open-browser.js")

' PID file in %LOCALAPPDATA%\DR Launcher\
Dim localAppData
localAppData = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
pidPath = fso.BuildPath(localAppData, "DR Launcher\server.pid")

' Check if server is already running
If fso.FileExists(pidPath) Then
    Dim pidJson, pid, port
    pidJson = fso.OpenTextFile(pidPath, 1).ReadAll()

    ' Parse JSON PID file (simple extraction, no JSON library in VBS)
    pid = ExtractJsonNumber(pidJson, "pid")
    port = ExtractJsonNumber(pidJson, "port")

    If pid > 0 And port > 0 Then
        If IsProcessAlive(pid) Then
            ' Server is running — just open the browser
            shell.Run """" & nodeExe & """ """ & openBrowserJs & """ " & port, 0, False
            WScript.Quit 0
        End If
    End If
End If

' No server running — start it hidden
shell.Run """" & nodeExe & """ """ & serverJs & """ --no-open --packaged", 0, False

' Wait for server to be ready, then open browser
WScript.Sleep 1000
shell.Run """" & nodeExe & """ """ & openBrowserJs & """ --wait", 0, False

WScript.Quit 0

' --- Helpers ---

Function ExtractJsonNumber(json, key)
    Dim pattern, regex, matches
    Set regex = New RegExp
    regex.Pattern = """" & key & """\s*:\s*(\d+)"
    regex.IgnoreCase = True
    Set matches = regex.Execute(json)
    If matches.Count > 0 Then
        ExtractJsonNumber = CLng(matches(0).SubMatches(0))
    Else
        ExtractJsonNumber = 0
    End If
End Function

Function IsProcessAlive(pid)
    On Error Resume Next
    Dim wmi, procs
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE ProcessId = " & pid)
    IsProcessAlive = False
    Dim proc
    For Each proc In procs
        If InStr(LCase(proc.CommandLine), "server.js") > 0 Then
            IsProcessAlive = True
        End If
    Next
    On Error GoTo 0
End Function
