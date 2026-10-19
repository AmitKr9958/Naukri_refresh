# Installs Naukri Refresh and a periodic Windows wake-timer task.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $repo "run-background.ps1"
$wakeScript = Join-Path $repo "wake-computer.ps1"
$taskName = "Naukri Refresh Background"
$wakeTaskName = "Naukri Refresh Wake Timer"

if (-not (Test-Path $runner)) { throw "Missing run-background.ps1" }
if (-not (Test-Path $wakeScript)) { throw "Missing wake-computer.ps1" }

# Allow Windows wake timers on the active power plan (AC and battery).
# Some devices/firmware do not support waking from every sleep state.
try {
    & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
    & powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
    & powercfg.exe /setactive SCHEME_CURRENT | Out-Null
    Write-Host "Enabled wake timers for the active power plan." -ForegroundColor Green
} catch {
    Write-Warning "Could not configure power-plan wake timers. Check Windows power settings."
}

$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# Wake the machine periodically so the already-running refresh loop can resume.
# The task itself does not touch the Naukri browser profile or start a second Node process.
$wakeArgument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wakeScript + '"'
$wakeAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $wakeArgument
$wakeAt = (Get-Date).AddMinutes(1)
$wakeTrigger = New-ScheduledTaskTrigger -Once -At $wakeAt -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 365)
$wakeSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $wakeTaskName -Action $wakeAction -Trigger $wakeTrigger -Settings $wakeSettings -Principal $principal -Force | Out-Null

Write-Host ""
Write-Host "Naukri Refresh background tasks installed." -ForegroundColor Green
Write-Host "Main task: $taskName"
Write-Host "Wake task: $wakeTaskName (every 5 minutes)"
Write-Host "The wake task requests Windows to wake the laptop so the running loop can resume."
Write-Host "Actual wake-from-sleep/hibernate depends on Windows, wake-timer settings, and device firmware."
Write-Host "This cannot run while the laptop is shut down, out of power, or unsupported by firmware."
Write-Host "The main task starts automatically at user logon; the wake task does not require manual starting."
Write-Host ""
Write-Host "To start refresh now:"
Write-Host "  Start-ScheduledTask -TaskName 'Naukri Refresh Background'"
Write-Host ""
Write-Host "To check tasks:"
Write-Host "  Get-ScheduledTask -TaskName 'Naukri Refresh Background','Naukri Refresh Wake Timer' | Get-ScheduledTaskInfo"
