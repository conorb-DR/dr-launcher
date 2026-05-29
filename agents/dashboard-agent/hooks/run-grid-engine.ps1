$data = $input | Out-String | ConvertFrom-Json
$f = $data.tool_input.file_path

# Only fire for spec files in the specs directory
if ($f -notmatch 'specs' -or $f -notmatch '\.json$') {
    exit 0
}

# Run the grid engine — writes layout back to the spec file, outputs the visual grid to stderr.
# Capture stderr+stdout WITHOUT a trailing pipeline so $LASTEXITCODE reflects node
# (a `| Out-String` pipeline would overwrite it with Out-String's exit code).
$output = node "[[SCRIPTS_DIR]]grid-engine.js" "$f" --write 2>&1
$code = $LASTEXITCODE
$output = ($output | Out-String)

# Surface non-zero exit instead of silently presenting a "success" message.
if ($code -ne 0) {
    $context = "Grid engine FAILED on $f (exit $code) — the spec was NOT laid out. Fix the reported validation/overlap errors below and re-save:`n`n$output"
} else {
    $context = "Grid engine ran on $f`n`n$output"
}

# Return output to Claude as additional context
$result = @{
    hookSpecificOutput = @{
        hookEventName     = "PostToolUse"
        additionalContext = $context
    }
} | ConvertTo-Json -Compress

Write-Output $result
