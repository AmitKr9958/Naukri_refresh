# Installs Naukri Refresh as a resilient Windows logon task.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $repo "run-background.ps1"
$taskName = "Naukri Refresh Background"
$wakeTaskName = "Naukri Refresh Wake Timer"

if (-not (Test-Path $runner)) { throw "Missing run-background.ps1" }

$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# Best-effort wake timer: wake the laptop every five minutes so the existing
# persistent Playwright process can resume after Windows Sleep/Hibernate.
# This task does not run the browser or access the Naukri session itself.
$wakeAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument "/c exit 0"
$wakeTrigger = New-ScheduledTaskTrigger -Daily -At (Get-Date).AddMinutes(1)
$wakeTrigger.Repetition.Interval = "PT5M"
$wakeTrigger.Repetition.Duration = "P1D"
$wakeSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$wakePrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $wakeTaskName -Action $wakeAction -Trigger $wakeTrigger -Settings $wakeSettings -Principal $wakePrincipal -Force | Out-Null

Write-Host ""
Write-Host "Naukri Refresh background task installed." -ForegroundColor Green
Write-Host "Task: $taskName"
Write-Host "Wake task: $wakeTaskName (best effort, every 5 minutes)"
Write-Host "The main task starts automatically when you log into Windows."
Write-Host "If refresh.js exits, run-background.ps1 restarts it after 60 seconds."
Write-Host "Task Scheduler also restarts the launcher if PowerShell exits unexpectedly."
Write-Host "The PowerShell launcher is hidden; Chromium runs headed because that is the currently verified working mode."
Write-Host ""
Write-Host "IMPORTANT: Windows power-plan wake timers must be enabled. Wake from Hibernate depends on your laptop/firmware and power settings."
Write-Host "Use AC power for this feature. Wake timers can wake the laptop periodically and may use battery."
Write-Host "This is not guaranteed to work on every device and cannot run while the laptop is shut down or has no power."
Write-Host ""
Write-Host "To start the main task now:"
Write-Host "  Start-ScheduledTask -TaskName 'Naukri Refresh Background'"
Write-Host ""
Write-Host "To check the tasks:"
Write-Host "  Get-ScheduledTask -TaskName 'Naukri Refresh Background','Naukri Refresh Wake Timer' | Get-ScheduledTaskInfo"
