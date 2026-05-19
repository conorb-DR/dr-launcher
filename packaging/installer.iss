; DR Launcher — Inno Setup Installer Script
; Requires Inno Setup 6+

#define MyAppName "DR Launcher"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Datarails"
#define MyAppURL "https://www.datarails.com"
#define MyAppExeName "DR-Launcher.exe"

[Setup]
AppId={{B8F2A1D3-9C4E-4F7A-B5D1-2E8A6C3F9D0E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=output
OutputBaseFilename=DR-Launcher-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\dr-launcher.ico
SetupIconFile=dr-launcher.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "dist\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion
Source: "dist\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\open-browser.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\dr-launcher.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\DR-Launcher.exe"; DestDir: "{app}"; Flags: ignoreversion; Check: NativeLauncherExists

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\dr-launcher.ico"; Check: NativeLauncherExists
Name: "{group}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; IconFilename: "{app}\dr-launcher.ico"; Check: not NativeLauncherExists
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\dr-launcher.ico"; Tasks: desktopicon; Check: NativeLauncherExists
Name: "{autodesktop}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; IconFilename: "{app}\dr-launcher.ico"; Tasks: desktopicon; Check: not NativeLauncherExists

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent; Check: NativeLauncherExists
Filename: "wscript.exe"; Parameters: """{app}\launcher.vbs"""; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent; Check: not NativeLauncherExists

[UninstallDelete]
Type: files; Name: "{app}\node\node.exe"
Type: dirifempty; Name: "{app}\node"
Type: dirifempty; Name: "{app}"

[Code]
function NativeLauncherExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{src}\dist\DR-Launcher.exe'));
end;

procedure GracefulShutdown;
var
  PidFile, PidContent: string;
  ResultCode: Integer;
begin
  PidFile := ExpandConstant('{localappdata}\DR Launcher\server.pid');
  if FileExists(PidFile) then
  begin
    if LoadStringFromFile(PidFile, PidContent) then
    begin
      { Try graceful shutdown via taskkill }
      Exec('taskkill.exe', '/F /FI "WINDOWTITLE eq node*" /FI "MODULES eq server.js"',
           '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;
  end;
  { Force kill any node.exe running our server.js }
  Exec('powershell.exe',
       '-NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=''''node.exe''''\" | ' +
       'Where-Object { $_.CommandLine -like ''*server.js*'' } | ' +
       'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1500);
end;

function InitializeSetup: Boolean;
begin
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    GracefulShutdown;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    GracefulShutdown;
  end;
end;
