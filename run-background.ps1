# Runs Naukri Refresh from Windows Task Scheduler.
# The PowerShell launcher and the automation Chromium window are hidden.
# Chromium remains headed because this is the mode verified to work with Naukri.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo
$env:HEADLESS = "false"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NaukriPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
}
"@

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NaukriWindow {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@

$profileMarker = [IO.Path]::GetFullPath((Join-Path $repo "naukri-browser-profile"))
$profileMarker = $profileMarker.TrimEnd([IO.Path]::DirectorySeparatorChar)

$node = (Get-Command node.exe -ErrorAction Stop).Source
$refreshScript = Join-Path $repo "refresh.js"

function Get-NaukriAutomationProcesses {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and (
                $_.CommandLine.IndexOf($profileMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                (
                    $_.Name -eq "node.exe" -and
                    $_.CommandLine.IndexOf($refreshScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
                )
            )
        }
}

function Stop-NaukriAutomationBrowsers {
    # Chromium uses a process tree (browser + renderer/GPU/network/utility
    # children). Killing only chrome.exe can leave a child holding the
    # persistent profile lock. Use taskkill /T only for processes whose
    # command line contains this automation's exact profile path.
    try {
        $processes = @(Get-NaukriAutomationProcesses)

        foreach ($processInfo in $processes) {
            try {
                & taskkill.exe /PID ([string]$processInfo.ProcessId) /T /F 2>$null | Out-Null
                Write-Host "Stopped automation Chromium process tree rooted at PID $($processInfo.ProcessId)."
            } catch {}
        }

        # Wait briefly for Chromium child processes to disappear.
        for ($attempt = 1; $attempt -le 10; $attempt++) {
            $remaining = @(Get-NaukriAutomationProcesses)
            if (-not $remaining) {
                return
            }
            Start-Sleep -Milliseconds 500
        }

        $remaining = @(Get-NaukriAutomationProcesses)
        if ($remaining) {
            Write-Host "Warning: $($remaining.Count) automation Chromium process(es) still remain after cleanup."
        }
    } catch {
        Write-Host "Could not clean automation Chromium process tree: $($_.Exception.Message)"
    }
}

function Clear-StaleNaukriProfileLock {
    # Chromium can leave Singleton* lock artifacts after an unexpected crash.
    # Only remove them after every managed refresh.js/Chromium process has been
    # terminated. The launcher owns this entire automation profile.
    try {
        $activeProcesses = @(Get-NaukriAutomationProcesses)

        if (-not $activeProcesses) {
            foreach ($lockName in @("SingletonLock", "SingletonCookie", "SingletonSocket")) {
                $lockPath = Join-Path $profileMarker $lockName
                if (Test-Path -LiteralPath $lockPath) {
                    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
                    Write-Host "Removed stale Chromium profile lock artifact: $lockName"
                }
            }

            return
        }

        Write-Host "Managed automation process still present; stale profile lock cleanup deferred."
    } catch {
        Write-Host "Could not clear stale Chromium profile locks: $($_.Exception.Message)"
    }
}

function Reset-NaukriProfileLocks {
    # Last-resort self-healing path. Only runs after the launcher has verified
    # that no managed refresh.js/Chromium process is alive.
    Stop-NaukriAutomationBrowsers
    Clear-StaleNaukriProfileLock

    $remaining = @(Get-NaukriAutomationProcesses)
    if ($remaining) {
        Write-Host "Warning: managed process(es) still remain after reset attempt."
    }
}

function Hide-NaukriBrowserWindows {
    try {
        $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf($profileMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $_.Name -match "^(chrome|msedge|chromium)(\.exe)?$"
            }
        foreach ($processInfo in $processes) {
            try {
                $p = Get-Process -Id ([int]$processInfo.ProcessId) -ErrorAction SilentlyContinue
                if ($p -and $p.MainWindowHandle -ne 0) {
                    [NaukriWindow]::ShowWindowAsync([IntPtr]$p.MainWindowHandle, 0) | Out-Null
                }
            } catch {}
        }
    } catch {}
}

[NaukriPower]::SetThreadExecutionState(
    [NaukriPower]::ES_CONTINUOUS -bor [NaukriPower]::ES_SYSTEM_REQUIRED
) | Out-Null

$exitCode = 1

try {
    # Keep Node automation alive independently of Task Scheduler restart policy.
    # If refresh.js exits, restart it after 60 seconds.
    while ($true) {
        # Ensure only one managed refresh.js process exists.
        try {
            $existingRefresh = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.ProcessId -ne $PID -and
                    $_.Name -eq "node.exe" -and
                    $_.CommandLine -and
                    $_.CommandLine -like "*$refreshScript*"
                })

            foreach ($existing in $existingRefresh) {
                try {
                    & taskkill.exe /PID ([string]$existing.ProcessId) /T /F 2>$null | Out-Null
                    Write-Host "Stopped stale refresh.js process tree rooted at PID $($existing.ProcessId)."
                } catch {}
            }

            for ($attempt = 1; $attempt -le 10; $attempt++) {
                $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.ProcessId -ne $PID -and
                        $_.Name -eq "node.exe" -and
                        $_.CommandLine -and
                        $_.CommandLine -like "*$refreshScript*"
                    })
                if (-not $remaining) { break }
                Start-Sleep -Milliseconds 500
            }
        } catch {
            Write-Host "Could not clean stale refresh.js processes: $($_.Exception.Message)"
        }

        # Clean the complete managed process tree and any stale
        # persistent-profile locks BEFORE launching refresh.js.
        Reset-NaukriProfileLocks
        Hide-NaukriBrowserWindows
        try {
            $nodeProcess = Start-Process -FilePath $node -ArgumentList @($refreshScript) -WorkingDirectory $repo -PassThru -WindowStyle Hidden
            while (-not $nodeProcess.HasExited) {
                Hide-NaukriBrowserWindows
                Start-Sleep -Milliseconds 750
                try { $nodeProcess.Refresh() } catch {}
            }
            Hide-NaukriBrowserWindows
            $exitCode = $nodeProcess.ExitCode

            # refresh.js can exit while headed Chromium survives as an orphan.
            # Clean the complete process tree, then clear stale profile locks
            # before the next restart.
            Reset-NaukriProfileLocks

            Write-Host "Naukri Refresh exited with code $exitCode. Restarting in 60 seconds."
            Start-Sleep -Seconds 60
        } catch {
            Write-Host "Could not start Naukri Refresh: $($_.Exception.Message)"
            Start-Sleep -Seconds 60
        }
    }
}
finally {
    [NaukriPower]::SetThreadExecutionState([NaukriPower]::ES_CONTINUOUS) | Out-Null
}

exit $exitCode
