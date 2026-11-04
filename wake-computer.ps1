# Lightweight scheduled wake task for Naukri Refresh.
# The scheduled task is configured with WakeToRun. Once Windows wakes,
# request that the system remain awake briefly so the already-running
# refresh.js process can finish its next browser cycle. The display is not
# requested, so the screen can remain off.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $repo "logs"
$logFile = Join-Path $logDir "wake-timer.log"
$awakeSeconds = 150

try {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Add-Content -LiteralPath $logFile -Value ("[" + (Get-Date -Format o) + "] Wake timer task started; requesting up to $awakeSeconds seconds awake time.")
} catch {
    # Logging must not prevent the wake task from running.
}

$powerRequestActive = $false
try {
    if (-not ("NaukriWakePower" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NaukriWakePower {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction Stop
    }

    # ES_CONTINUOUS | ES_SYSTEM_REQUIRED = keep the system awake.
    # Deliberately omit ES_DISPLAY_REQUIRED so the monitor may turn off.
    $result = [NaukriWakePower]::SetThreadExecutionState(0x80000000 -bor 0x00000001)
    if ($result -eq 0) {
        throw "SetThreadExecutionState failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    }

    $powerRequestActive = $true
    Start-Sleep -Seconds $awakeSeconds
} catch {
    try {
        Add-Content -LiteralPath $logFile -Value ("[" + (Get-Date -Format o) + "] Wake/awake request failed: " + $_.Exception.Message)
    } catch {}
} finally {
    if ($powerRequestActive) {
        # ES_CONTINUOUS without SYSTEM_REQUIRED releases this task's request.
        [void][NaukriWakePower]::SetThreadExecutionState(0x80000000)
    }
    try {
        Add-Content -LiteralPath $logFile -Value ("[" + (Get-Date -Format o) + "] Wake task finished; temporary awake request released.")
    } catch {}
}
