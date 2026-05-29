$data = $input | Out-String | ConvertFrom-Json
$f = $data.tool_input.file_path

# Only fire for spec files in the specs directory
if ($f -notmatch 'specs' -or $f -notmatch '\.json$') {
    exit 0
}

# Run the grid engine — writes layout back to the spec file, outputs the visual grid to stderr
$output = node "[[SCRIPTS_DIR]]grid-engine.js" "$f" --write 2>&1 | Out-String

# Return output to Claude as additional context
$result = @{
    hookSpecificOutput = @{
        hookEventName     = "PostToolUse"
        additionalContext = "Grid engine ran on $f`n`n$output"
    }
} | ConvertTo-Json -Compress

Write-Output $result
