# DR Launcher - Build Pipeline
# Downloads portable Node.js, stages files, compiles Inno Setup installer.
# Usage: powershell -File packaging/build.ps1
# Run from repo root (C:\...\dr-launcher)

param(
    [switch]$SkipInstaller,
    [switch]$SkipCSharp
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$PackagingDir = Join-Path $RepoRoot "packaging"
$DistDir = Join-Path $PackagingDir "dist"
$CacheDir = Join-Path $PackagingDir ".cache"
$OutputDir = Join-Path $PackagingDir "output"

# Read config
$config = Get-Content (Join-Path $PackagingDir "build-config.json") | ConvertFrom-Json
$nodeVersion = $config.nodeVersion
$expectedSha = $config.nodeSha256
$nodeZipOverride = $config.nodeZipPath
$innoPath = $config.innoSetupPath

$version = (Get-Content (Join-Path $RepoRoot "package.json") | ConvertFrom-Json).version
Write-Host "=== DR Launcher Build v$version ===" -ForegroundColor Cyan
Write-Host "Node.js version: $nodeVersion"

# --- Step 1: Get Node.js portable ---
$nodeZipName = "node-v$nodeVersion-win-x64.zip"
$nodeZipUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeZipName"

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

if ($nodeZipOverride -and (Test-Path $nodeZipOverride)) {
    $nodeZipPath = $nodeZipOverride
    Write-Host "Using local Node.js zip: $nodeZipPath"
} else {
    $nodeZipPath = Join-Path $CacheDir $nodeZipName
    if (-not (Test-Path $nodeZipPath)) {
        Write-Host "Downloading Node.js $nodeVersion..."
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZipPath -UseBasicParsing
        Write-Host "Downloaded: $nodeZipPath"
    } else {
        Write-Host "Using cached Node.js zip: $nodeZipPath"
    }
}

# Verify SHA256
$actualSha = (Get-FileHash -Path $nodeZipPath -Algorithm SHA256).Hash
if ($expectedSha -and $expectedSha -ne "TO_BE_PINNED_AFTER_FIRST_DOWNLOAD") {
    if ($actualSha -ne $expectedSha) {
        throw "SHA256 mismatch! Expected: $expectedSha, Got: $actualSha"
    }
    Write-Host "SHA256 verified: $actualSha" -ForegroundColor Green
} else {
    Write-Host "SHA256 (pin this in build-config.json): $actualSha" -ForegroundColor Yellow
}

# --- Step 2: Clean and create dist ---
if (Test-Path $DistDir) {
    Remove-Item -Recurse -Force $DistDir
}
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DistDir "node") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DistDir "app") | Out-Null

# Extract only node.exe from zip
Write-Host "Extracting node.exe..."
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($nodeZipPath)
$nodeEntry = $zip.Entries | Where-Object { $_.Name -eq "node.exe" -and $_.FullName -like "*/node.exe" } | Select-Object -First 1
if (-not $nodeEntry) { throw "node.exe not found in zip" }
$destNodeExe = Join-Path $DistDir "node\node.exe"
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($nodeEntry, $destNodeExe, $true)
$zip.Dispose()
$nodeSizeMB = [math]::Round((Get-Item $destNodeExe).Length / 1048576, 1)
Write-Host "Extracted node.exe ($nodeSizeMB MB)"

# --- Step 3: Copy app files ---
Write-Host "Staging application files..."

$appDist = Join-Path $DistDir "app"

# Copy individual files.
# NOTE: auth-config.json is intentionally NOT copied here. The dev auth-config.json
# in the repo root is a placeholder; copying it would ship a non-functional config.
# Instead, prod SSO config is shipped from the packaging-owned, gitignored
# packaging/auth-config.prod.json (see below). When that file is absent, the dist
# ships no auth-config.json at all, so the app falls back to dev-login (correct for
# a build without prod credentials).
$filesToCopy = @("server.js", "package.json", "package-lock.json")
foreach ($f in $filesToCopy) {
    $src = Join-Path $RepoRoot $f
    if (Test-Path $src) {
        Copy-Item $src -Destination $appDist
    }
}

# Ship prod SSO config only if the packaging-owned file exists. This file is
# gitignored (it holds tenant/client IDs) and lives at packaging/auth-config.prod.json.
$prodAuthConfig = Join-Path $PackagingDir "auth-config.prod.json"
if (Test-Path $prodAuthConfig) {
    Copy-Item $prodAuthConfig -Destination (Join-Path $appDist "auth-config.json")
    Write-Host "Bundled prod SSO config from packaging/auth-config.prod.json" -ForegroundColor Green
} else {
    Write-Host "No packaging/auth-config.prod.json found - dist ships without auth-config.json (dev-login default)" -ForegroundColor Yellow
}

# Copy directories (excluding unwanted). 'agents' carries the bundled
# dashboard/datamapper agent scaffolds — omitting it breaks agent launches.
$dirsToCopy = @("lib", "public", "agents")
foreach ($d in $dirsToCopy) {
    $src = Join-Path $RepoRoot $d
    if (Test-Path $src) {
        Copy-Item $src -Destination (Join-Path $appDist $d) -Recurse
    }
}

# --- Step 4: Install production dependencies ---
Write-Host "Installing production dependencies..."
Push-Location $appDist
try {
    & npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# --- Step 5: Copy packaging assets ---
Copy-Item (Join-Path $PackagingDir "launcher.vbs") -Destination $DistDir
Copy-Item (Join-Path $PackagingDir "open-browser.js") -Destination $DistDir

$icoSrc = Join-Path $PackagingDir "dr-launcher.ico"
if (Test-Path $icoSrc) {
    Copy-Item $icoSrc -Destination $DistDir
} else {
    Write-Host "WARNING: dr-launcher.ico not found - installer will lack icon" -ForegroundColor Yellow
}

# --- Step 6: Compile C# launcher (optional) ---
if (-not $SkipCSharp) {
    $csFile = Join-Path $PackagingDir "Launcher.cs"
    if (Test-Path $csFile) {
        Write-Host "Compiling C# launcher..."
        $cscPath = Join-Path $env:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
        if (-not (Test-Path $cscPath)) {
            $cscPath = (Get-ChildItem -Path "$env:SystemRoot\Microsoft.NET\Framework64" -Filter "csc.exe" -Recurse | Select-Object -Last 1).FullName
        }
        if ($cscPath -and (Test-Path $cscPath)) {
            $exeOut = Join-Path $DistDir "DR-Launcher.exe"
            $icoFlag = ""
            if (Test-Path $icoSrc) { $icoFlag = "/win32icon:$icoSrc" }
            $cscArgs = @("/target:winexe", "/optimize", "/out:$exeOut")
            if ($icoFlag) { $cscArgs += $icoFlag }
            $cscArgs += $csFile
            & $cscPath $cscArgs
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Compiled DR-Launcher.exe" -ForegroundColor Green
            } else {
                Write-Host "C# compilation failed - installer will use VBS launcher" -ForegroundColor Yellow
            }
        } else {
            Write-Host "csc.exe not found - skipping C# launcher" -ForegroundColor Yellow
        }
    }
}

# --- Step 7: Compile Inno Setup installer ---
if (-not $SkipInstaller) {
    if (Test-Path $innoPath) {
        Write-Host "Compiling installer..."
        New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
        & $innoPath (Join-Path $PackagingDir "installer.iss")
        if ($LASTEXITCODE -eq 0) {
            $installerFile = Get-ChildItem $OutputDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            Write-Host "=== Build complete ===" -ForegroundColor Green
            $sizeMB = [math]::Round($installerFile.Length / 1048576, 1)
            Write-Host ('Installer: ' + $installerFile.FullName + ' (' + $sizeMB + ' MB)')
        } else {
            throw "Inno Setup compilation failed"
        }
    } else {
        Write-Host "Inno Setup not found at: $innoPath" -ForegroundColor Yellow
        Write-Host "Install via: winget install JRSoftware.InnoSetup" -ForegroundColor Yellow
        Write-Host "Dist directory is ready at: $DistDir"
    }
} else {
    Write-Host "Installer compilation skipped (-SkipInstaller)"
    Write-Host "Dist directory ready at: $DistDir"
}

Write-Host ""
Write-Host "Dist contents:"
Get-ChildItem $DistDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($DistDir.Length + 1)
    $sizeKB = [math]::Round($_.Length / 1024, 1)
    Write-Host ($rel + ' (' + $sizeKB + ' KB)')
}
