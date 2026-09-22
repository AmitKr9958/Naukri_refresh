# Installs Naukri Refresh as a Windows logon background task.
# Run this script once from PowerShell in the repository folder.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $repo "run-background.ps1"
$taskName = "Naukri Refresh Background"

if (-not (Test-Path $runner)) {
  throw "Missing run-background.ps1"
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host ""
Write-Host "Naukri Refresh background task installed." -ForegroundColor Green
Write-Host "Task: $taskName"
Write-Host "It starts automatically when you log into Windows."
Write-Host "The Playwright browser runs headless; no browser window is intended to appear."
Write-Host ""
Write-Host "To start it now:"
Write-Host "  Start-ScheduledTask -TaskName `"$taskName`""
Write-Host ""
Write-Host "To check it:"
Write-Host "  Get-ScheduledTask -TaskName `"$taskName`" | Get-ScheduledTaskInfo"
