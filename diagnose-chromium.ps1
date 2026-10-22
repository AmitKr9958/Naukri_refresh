# Safe diagnostics for Chromium startup hangs. Does not stop processes,
# delete profile files, print .env, or change the saved Naukri profile.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$profile = Join-Path $repo "naukri-browser-profile"
$log = Join-Path $repo "logs\naukri-refresh.log"

Write-Host "`n=== Managed Chromium processes ==="
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match "^(chrome|chromium|msedge)\.exe$" -and $_.CommandLine -and $_.CommandLine.Contains("naukri-browser-profile") } |
  Select-Object ProcessId, ParentProcessId, CreationDate, Name, @{Name="CommandLine";Expression={ if ($_.CommandLine.Length -gt 260) {$_.CommandLine.Substring(0,260)+"..."} else {$_.CommandLine} }} |
  Format-List

Write-Host "`n=== Chromium processes overall ==="
Get-Process chrome,chromium -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime, CPU, WorkingSet64 | Format-Table -AutoSize

Write-Host "`n=== Profile lock markers (inspection only) ==="
$locks = foreach ($name in @("SingletonLock","SingletonCookie","SingletonSocket")) { $p = Join-Path $profile $name; [PSCustomObject]@{ Name=$name; Exists=(Test-Path -LiteralPath $p); Path=$p } }
$locks | Format-Table -AutoSize

Write-Host "`n=== Profile size ==="
if (Test-Path $profile) { $measure = Get-ChildItem $profile -File -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum; [PSCustomObject]@{FileCount=$measure.Count; SizeMB=[math]::Round(($measure.Sum / 1MB),2)} | Format-List }

Write-Host "`n=== Latest startup log lines ==="
if (Test-Path $log) { Select-String -Path $log -Pattern "Startup:|launchPersistentContext|Timeout 90000|STARTUP_FAILED|persistent Chromium launched successfully" | Select-Object -Last 20 | ForEach-Object { $_.Line } }

Write-Host "`n=== Scheduled task ==="
Get-ScheduledTaskInfo -TaskName "Naukri Refresh Background" -ErrorAction SilentlyContinue | Format-List LastRunTime,LastTaskResult,NextRunTime
Write-Host "`nDiagnostics complete. No processes or profile files were changed."
