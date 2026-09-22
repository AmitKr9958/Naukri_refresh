# Runs Naukri Refresh from Windows Task Scheduler.
# The terminal is hidden, but Chromium remains headed because this is the mode
# verified to work with the current Naukri UI/session.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo
$env:HEADLESS = "false"

$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $repo "refresh.js")
exit $LASTEXITCODE
