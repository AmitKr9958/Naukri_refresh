# Installs Naukri Refresh as a resilient Windows logon task.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $repo "run-background.ps1"
$taskName = "Naukri Refresh Background"

if (-not (Test-Path $runner)) { throw "Missing run-background.ps1" }

$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host ""
Write-Host "Naukri Refresh background task installed." -ForegroundColor Green
Write-Host "Task: $taskName"
Write-Host "It starts automatically when you log into Windows."
Write-Host "If refresh.js exits, run-background.ps1 restarts it after 60 seconds."
Write-Host "Task Scheduler also restarts the launcher if PowerShell exits unexpectedly."
Write-Host "The PowerShell launcher is hidden; Chromium runs headed because that is the currently verified working mode."
Write-Host "Keep the Windows user session available for the browser UI."
Write-Host ""
Write-Host "To start it now:"
Write-Host "  Start-ScheduledTask -TaskName 'Naukri Refresh Background'"
Write-Host ""
Write-Host "To check it:"
Write-Host "  Get-ScheduledTask -TaskName 'Naukri Refresh Background' | Get-ScheduledTaskInfo"
