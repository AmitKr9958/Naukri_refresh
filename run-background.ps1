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

function Clear-StaleNaukriProfileLock {
    # Chromium can leave Singleton* lock artifacts after an unexpected crash.
    # Only remove them when no automation browser process is using this profile.
    try {
        $activeBrowsers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf($profileMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $_.Name -match "^(chrome|msedge|chromium)(\\.exe)?$"
            }

        if (-not $activeBrowsers) {
            foreach ($lockName in @("SingletonLock", "SingletonCookie", "SingletonSocket")) {
                $lockPath = Join-Path $profileMarker $lockName
                if (Test-Path -LiteralPath $lockPath) {
                    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
                    Write-Host "Removed stale Chromium profile lock artifact: $lockName"
                }
            }
        }
    } catch {
        Write-Host "Could not clear stale Chromium profile locks: $($_.Exception.Message)"
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
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $refreshScript = Join-Path $repo "refresh.js"

    # Keep Node automation alive independently of Task Scheduler restart policy.
    # If refresh.js exits, restart it after 60 seconds.
    while ($true) {
        # Ensure only one refresh.js instance belongs to this launcher.
        # A stale/orphan Node process can otherwise keep the same persistent
        # Chromium profile alive and create competing cycles.
        try {
            $existingRefresh = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.ProcessId -ne $PID -and
                    $_.Name -eq "node.exe" -and
                    $_.CommandLine -and
                    $_.CommandLine -like "*$refreshScript*"
                }

            foreach ($existing in $existingRefresh) {
                try {
                    Stop-Process -Id ([int]$existing.ProcessId) -Force -ErrorAction SilentlyContinue
                    Write-Host "Stopped stale refresh.js process $($existing.ProcessId) before starting a single managed instance."
                } catch {}
            }
        } catch {
            Write-Host "Could not inspect stale refresh.js processes: $($_.Exception.Message)"
        }

        # Clean any orphaned automation Chromium processes and stale Chromium
        # profile-lock artifacts BEFORE launching refresh.js. This is important
        # because a previous Node/Chromium crash can leave the persistent profile
        # locked even though no healthy automation session is running.
        try {
            $automationBrowsers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.CommandLine -and
                    $_.CommandLine.IndexOf($profileMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                    $_.Name -match "^(chrome|msedge|chromium)(\\.exe)?$"
                }

            if ($automationBrowsers) {
                Write-Host "Found $($automationBrowsers.Count) existing automation browser process(es)."
                foreach ($browser in $automationBrowsers) {
                    try {
                        Stop-Process -Id ([int]$browser.ProcessId) -Force -ErrorAction SilentlyContinue
                    } catch {}
                }

                Start-Sleep -Seconds 2
            }
        } catch {
            Write-Host "Could not inspect/clean automation browser processes before launch: $($_.Exception.Message)"
        }

        Clear-StaleNaukriProfileLock
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
            # Because the persistent profile can only be opened by one Chromium
            # process tree, clean up only browser processes belonging to this
            # automation profile before restarting. This runs only after the
            # Node process has already exited, so it cannot interrupt a healthy
            # refresh cycle or any normal Chrome session.
            try {
                $staleBrowsers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.CommandLine -and
                        $_.CommandLine.IndexOf($profileMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                        $_.Name -match "^(chrome|msedge|chromium)(\.exe)?$"
                    }

                foreach ($browser in $staleBrowsers) {
                    try {
                        Stop-Process -Id ([int]$browser.ProcessId) -Force -ErrorAction SilentlyContinue
                    } catch {}
                }

                if ($staleBrowsers) {
                    Write-Host "Cleaned up $($staleBrowsers.Count) orphan automation browser process(es) before restart."
                }
            } catch {
                Write-Host "Could not clean up orphan automation browser processes: $($_.Exception.Message)"
            }

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
