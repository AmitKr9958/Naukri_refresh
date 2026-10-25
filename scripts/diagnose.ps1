# Read-only diagnostics for the Naukri Refresh scheduled task.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
$taskName = "Naukri Refresh Background"

Write-Host "=== Scheduled task ===" -ForegroundColor Cyan
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  $task | Select-Object TaskName, State
  Get-ScheduledTaskInfo -TaskName $taskName |
    Select-Object LastRunTime, LastTaskResult, NextRunTime
} else {
  Write-Host "Task not found: $taskName"
}

Write-Host "`n=== Health ===" -ForegroundColor Cyan
$healthPath = Join-Path $repo "naukri-refresh-health.json"
if (Test-Path $healthPath) {
  Get-Item $healthPath | Select-Object LastWriteTime, Length
  Get-Content $healthPath -Raw
} else {
  Write-Host "Health file missing: $healthPath"
}

Write-Host "`n=== Recent cycle log ===" -ForegroundColor Cyan
$logPath = Join-Path $repo "logs\naukri-refresh.log"
if (Test-Path $logPath) {
  Get-Item $logPath | Select-Object LastWriteTime, Length
  Get-Content $logPath -Tail 100 |
    Select-String -Pattern "Cycle|failed|error|timeout|closed|upload|waiting|launched|completed" |
    Select-Object -Last 50
} else {
  Write-Host "Log file missing: $logPath"
}

Write-Host "`n=== AC sleep settings ===" -ForegroundColor Cyan
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
powercfg /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE
