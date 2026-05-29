# validate-mapper-spec.ps1
#
# PostToolUse hook — runs whenever Claude Code writes a file.
# If the file is a mapper spec under .agent/specs/, run the validator and
# surface results back into the conversation via stdout.
#
# The hook receives the tool-use payload as $env:CLAUDE_HOOK_PAYLOAD (JSON).
# We extract the file_path and only act on .agent/specs/*.json writes.

$ErrorActionPreference = "Stop"

try {
    $payload = $env:CLAUDE_HOOK_PAYLOAD | ConvertFrom-Json
} catch {
    # No payload, nothing to do
    exit 0
}

$filePath = $payload.tool_input.file_path
if (-not $filePath) { exit 0 }

# Only act on spec files under .agent/specs/
if ($filePath -notmatch '\.agent[/\\]specs[/\\].*\.json$') { exit 0 }
if (-not (Test-Path $filePath)) { exit 0 }

# Resolve workspace root from spec path (.agent/specs/<file>.json → workspace)
$specDir = Split-Path -Parent $filePath
$agentDir = Split-Path -Parent $specDir
$workspaceRoot = Split-Path -Parent $agentDir

$validator = Join-Path $workspaceRoot ".agent/scripts/validate-spec.js"
$templateGlob = Join-Path $workspaceRoot ".agent/tmp/template-*.json"
$functionsPath = Join-Path $workspaceRoot ".agent/tmp/formula-functions.json"

if (-not (Test-Path $validator)) {
    Write-Output "[validate-mapper-spec] validator not found at $validator — skipping"
    exit 0
}

# Pick the most recent template file (if any)
$template = $null
try {
    $template = (Get-ChildItem $templateGlob -ErrorAction Stop | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
} catch {}

$args = @($validator, $filePath)
if ($template) { $args += $template }
if (Test-Path $functionsPath) { $args += $functionsPath }

# Try to detect the server from any existing tmp file (best effort)
$serverFile = Join-Path $workspaceRoot ".agent/tmp/server.txt"
if (Test-Path $serverFile) {
    $server = (Get-Content $serverFile -Raw).Trim()
    if ($server) { $args += "--server"; $args += $server }
}

Write-Output "=== Auto-validating mapper spec: $filePath ==="
& node @args
exit $LASTEXITCODE
