# Runs Naukri Refresh without a visible browser or VS Code terminal.
# Intended to be launched by Windows Task Scheduler.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

# Override the local .env value for background operation.
$env:HEADLESS = "true"

$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $repo "refresh.js")
exit $LASTEXITCODE
