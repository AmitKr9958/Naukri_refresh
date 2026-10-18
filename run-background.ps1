# Runs Naukri Refresh from Windows Task Scheduler.
# The PowerShell launcher and the automation Chromium window are hidden.
# Chromium remains headed because this is the mode verified to work with Naukri.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo
$env:HEADLESS = "false"

# Task Scheduler hides this PowerShell window, so persist all startup/recovery
# output to a daily log. This makes stuck recovery loops diagnosable.
$launcherLogDir = Join-Path $repo "logs"
New-Item -ItemType Directory -Path $launcherLogDir -Force | Out-Null
# Use a per-process log and do not use Start-Transcript: transcript keeps the
# file open and conflicts with Add-Content when the launcher runs hidden.
$launcherLogPath = Join-Path $launcherLogDir ("run-background-" + (Get-Date -Format "yyyy-MM-dd") + "-" + $PID + ".log")

function Write-LauncherLog {
    param([string]$Message)
    try {
        Add-Content -LiteralPath $launcherLogPath -Value ("[" + (Get-Date -Format o) + "] " + $Message) -ErrorAction Stop
    } catch {
        # Diagnostics must never prevent the automation from starting.
    }
}
Write-LauncherLog ("Launcher started. PID=$PID; repo=$repo; Node=" + (Get-Command node.exe -ErrorAction SilentlyContinue).Source)
Write-LauncherLog "Stage 1: direct file logging initialized."

Write-LauncherLog "Stage 2: compiling NaukriPower native helper."
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

Write-LauncherLog "Stage 3: NaukriPower helper compiled; compiling window helper."
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NaukriWindow {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int X, int Y, int cx, int cy, uint flags);

    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_TOOLWINDOW = 0x00000080L;
    public const long WS_EX_APPWINDOW = 0x00040000L;
    public const int SW_HIDE = 0;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_FRAMECHANGED = 0x0020;

    // Enumerate top-level windows by PID; Get-Process.MainWindowHandle alone
    // can miss Chromium's window during startup/recovery.
    public static int HideWindowsForProcess(uint targetPid) {
        int changed = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint ownerPid;
            GetWindowThreadProcessId(hWnd, out ownerPid);
            if (ownerPid != targetPid) return true;

            long style = GetWindowLongPtr(hWnd, GWL_EXSTYLE).ToInt64();
            long newStyle = (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
            SetWindowLongPtr(hWnd, GWL_EXSTYLE, new IntPtr(newStyle));
            SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
            ShowWindowAsync(hWnd, SW_HIDE);
            changed++;
            return true;
        }, IntPtr.Zero);
        return changed;
    }
}
"@

Write-LauncherLog "Stage 4: native helpers compiled; resolving profile and Node paths."
$profileMarker = [IO.Path]::GetFullPath((Join-Path $repo "naukri-browser-profile"))
$profileMarker = $profileMarker.TrimEnd([IO.Path]::DirectorySeparatorChar)
$profileMarkerNormalized = $profileMarker.Replace("/", "\").TrimEnd("\")
$profileMarkerForward = $profileMarkerNormalized.Replace("\", "/")

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $node = $nodeCommand.Source
} else {
    $nodeCandidates = @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
    )

    $node = $nodeCandidates |
        Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
        Select-Object -First 1

    if (-not $node) {
        throw "node.exe was not found. Install Node.js or add node.exe to the scheduled-task PATH."
    }
}

Write-LauncherLog ("Stage 5: Node resolved to " + $node)
$refreshScript = Join-Path $repo "refresh.js"
$healthPath = Join-Path $repo "naukri-refresh-health.json"

function Get-NaukriProcessTree {
    param([int]$RootPid)

    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $result = @()
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    $pending = New-Object 'System.Collections.Generic.Queue[int]'

    [void]$seen.Add($RootPid)
    $pending.Enqueue($RootPid)

    while ($pending.Count -gt 0) {
        $currentPid = $pending.Dequeue()
        foreach ($processInfo in ($all | Where-Object { $_.ParentProcessId -eq $currentPid })) {
            $childPid = [int]$processInfo.ProcessId
            if ($seen.Add($childPid)) {
                $result += $processInfo
                $pending.Enqueue($childPid)
            }
        }
    }

    $result
}

function Test-NaukriManagedProcess {
    param([object]$ProcessInfo)

    if (-not $ProcessInfo) { return $false }

    if (
        $ProcessInfo.Name -eq "node.exe" -and
        $ProcessInfo.CommandLine -and
        $ProcessInfo.CommandLine.IndexOf($refreshScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
        return $true
    }

    if (
        $ProcessInfo.CommandLine -and
        $ProcessInfo.CommandLine.IndexOf($profileMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0
    ) {
        return $true
    }

    return $false
}

function Test-NaukriProfileProcess {
    param([object]$ProcessInfo)

    if (-not $ProcessInfo -or -not $ProcessInfo.CommandLine) { return $false }

    $commandLine = $ProcessInfo.CommandLine.Replace("/", "\")
    $commandLineNormalized = $commandLine.ToLowerInvariant()

    return (
        $commandLineNormalized.IndexOf($profileMarkerNormalized.ToLowerInvariant(), [StringComparison]::Ordinal) -ge 0 -or
        $commandLineNormalized.IndexOf($profileMarkerForward.ToLowerInvariant(), [StringComparison]::Ordinal) -ge 0 -or
        $commandLineNormalized.IndexOf("--user-data-dir=$($profileMarkerNormalized.ToLowerInvariant())", [StringComparison]::Ordinal) -ge 0
    )
}

function Get-NaukriProfileProcesses {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    @(
        $all | Where-Object {
            $_.Name -match "^(chrome|msedge|chromium)(\.exe)?$" -and
            (Test-NaukriProfileProcess $_)
        }
    )
}

function Get-NaukriAutomationProcesses {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $roots = @($all | Where-Object { Test-NaukriManagedProcess $_ })
    $result = @($roots)

    foreach ($root in @($roots | Where-Object {
        $_.Name -eq "node.exe" -and
        $_.CommandLine -and
        $_.CommandLine.IndexOf($refreshScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })) {
        foreach ($child in @(Get-NaukriProcessTree -RootPid ([int]$root.ProcessId))) {
            if ($result.ProcessId -notcontains $child.ProcessId) {
                $result += $child
            }
        }
    }

    foreach ($profileProcess in @(Get-NaukriProfileProcesses)) {
        if ($result.ProcessId -notcontains $profileProcess.ProcessId) {
            $result += $profileProcess
        }
    }

    $result
}

function Stop-NaukriAutomationBrowsers {
    # Use one process snapshot per cleanup pass. The previous implementation
    # repeatedly walked every process tree and could stall before Node started.
    try {
        $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $targets = @($all | Where-Object {
            (
                $_.Name -eq "node.exe" -and
                $_.CommandLine -and
                $_.CommandLine.IndexOf($refreshScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
            ) -or (
                $_.Name -match "^(chrome|msedge|chromium)(\.exe)?$" -and
                (Test-NaukriProfileProcess $_)
            )
        })

        foreach ($target in $targets) {
            try {
                Write-Host "Stopping managed Naukri process PID $($target.ProcessId) ($($target.Name))."
                & taskkill.exe /PID ([string]$target.ProcessId) /T /F 2>$null | Out-Null
            } catch {
                Write-Host "Could not stop managed PID $($target.ProcessId): $($_.Exception.Message)"
            }
        }

        if ($targets.Count -gt 0) {
            Start-Sleep -Milliseconds 750
        }
    } catch {
        Write-Host "Could not scan managed Naukri processes: $($_.Exception.Message)"
    }
}

function Clear-StaleNaukriProfileLock {
    try {
        $activeProcesses = @(Get-NaukriAutomationProcesses)
        if ($activeProcesses) {
            Write-Host "Managed Naukri automation process still present; lock cleanup deferred."
            return $false
        }

        foreach ($lockName in @("SingletonLock", "SingletonCookie", "SingletonSocket")) {
            $lockPath = Join-Path $profileMarker $lockName
            if (Test-Path -LiteralPath $lockPath) {
                try {
                    Remove-Item -LiteralPath $lockPath -Force -Recurse -ErrorAction Stop
                    Write-Host "Removed stale Chromium lock: $lockName"
                } catch {
                    Write-Host "Could not remove Chromium lock $lockName : $($_.Exception.Message)"
                    return $false
                }
            }
        }

        return $true
    } catch {
        Write-Host "Could not clear stale Chromium profile locks: $($_.Exception.Message)"
        return $false
    }
}

function Reset-NaukriProfileLocks {
    for ($pass = 1; $pass -le 8; $pass++) {
        Write-Host "Naukri profile cleanup pass $pass/8"
        Stop-NaukriAutomationBrowsers
        Start-Sleep -Milliseconds 750
        $remaining = @(Get-NaukriAutomationProcesses)
        if ($remaining) { Start-Sleep -Seconds 1; continue }
        if (Clear-StaleNaukriProfileLock) {
            Start-Sleep -Milliseconds 500
            $lockFilesRemain = @("SingletonLock", "SingletonCookie", "SingletonSocket") | Where-Object { Test-Path -LiteralPath (Join-Path $profileMarker $_) }
            if (-not $lockFilesRemain) { Write-Host "Naukri Chromium profile is clean and unlocked."; return $true }
        }
        Start-Sleep -Seconds 1
    }
    Write-Host "Naukri profile cleanup did not complete after 8 passes."
    return $false
}

function Start-NaukriRefreshWithRecovery {
    param([int]$MaxAttempts = 5)
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        Write-Host "Starting Naukri Refresh attempt $attempt/$MaxAttempts."
        if (-not (Reset-NaukriProfileLocks)) { Start-Sleep -Seconds 5; continue }
        try {
            $nodeProcess = Start-Process -FilePath $node -ArgumentList @($refreshScript) -WorkingDirectory $repo -PassThru -WindowStyle Hidden

            # Do not consider Node "started" merely because the process exists.
            # Playwright can launch Chromium and then remain stuck in
            # launchPersistentContext while the saved profile is unhealthy.
            # Require refresh.js to publish a non-STARTING health state first.
            $startupHealthy = $false
            for ($healthAttempt = 1; $healthAttempt -le 12; $healthAttempt++) {
                Start-Sleep -Seconds 5
                try { $nodeProcess.Refresh() } catch {}

                if ($nodeProcess.HasExited) {
                    Write-Host "Naukri Refresh exited during startup. Cleaning and retrying."
                    break
                }

                try {
                    if (Test-Path -LiteralPath $healthPath) {
                        $health = Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json
                        if ([int]$health.pid -eq [int]$nodeProcess.Id -and
                            [string]$health.status -ne "STARTING") {
                            Write-Host "Naukri Refresh startup health confirmed: $($health.status)."
                            $startupHealthy = $true
                            break
                        }
                    }
                } catch {
                    # Health file may be mid-write; retry on the next pass.
                }

                Write-Host "Waiting for refresh.js startup health ($healthAttempt/12)."
            }

            if ($startupHealthy -and -not $nodeProcess.HasExited) {
                Write-Host "Naukri Refresh started successfully."
                return $nodeProcess
            }

            Write-Host "Naukri Refresh did not reach healthy startup state. Terminating its process tree and cleaning the profile."
            try {
                & taskkill.exe /PID ([string]$nodeProcess.Id) /T /F 2>$null | Out-Null
            } catch {}
            Start-Sleep -Seconds 2
            Reset-NaukriProfileLocks
        } catch { Write-Host ("Could not start Naukri Refresh. Retrying. Error: " + $_.Exception.Message) }
        Start-Sleep -Seconds 5
    }
    throw "Naukri Refresh could not be started after clean startup attempts."
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
                # Enumerate actual top-level windows for each dedicated-profile
                # Chromium PID. Do not depend on MainWindowHandle being populated.
                [void][NaukriWindow]::HideWindowsForProcess([uint32]$processInfo.ProcessId)
            } catch {
                try {
                    Add-Content -LiteralPath (Join-Path $repo "logs\naukri-window-hide.log") -Value (
                        "[" + (Get-Date -Format o) + "] PID " + $processInfo.ProcessId +
                        " hide error: " + $_.Exception.Message
                    )
                } catch {}
            }
        }
    } catch {
        try {
            Add-Content -LiteralPath (Join-Path $repo "logs\naukri-window-hide.log") -Value (
                "[" + (Get-Date -Format o) + "] hide scan error: " + $_.Exception.Message
            )
        } catch {}
    }
}

Write-LauncherLog "Stage 6: entering launcher main loop."
[NaukriPower]::SetThreadExecutionState(
    [NaukriPower]::ES_CONTINUOUS -bor [NaukriPower]::ES_SYSTEM_REQUIRED
) | Out-Null

$exitCode = 1

try {
    # Keep Node automation alive independently of Task Scheduler restart policy.
    # If refresh.js exits, restart it after 60 seconds.
    while ($true) {
        Write-LauncherLog "Main loop: beginning process/profile cleanup."
        # Ensure only one managed refresh.js process exists and reset the
        # complete automation domain before every launch.
        try {
            Reset-NaukriProfileLocks
            Write-LauncherLog "Main loop: initial profile cleanup returned."

            $existingRefresh = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.ProcessId -ne $PID -and
                    $_.Name -eq "node.exe" -and
                    $_.CommandLine -and
                    $_.CommandLine -like "*$refreshScript*"
                })

            if ($existingRefresh) {
                foreach ($existing in $existingRefresh) {
                    try {
                        & taskkill.exe /PID ([string]$existing.ProcessId) /T /F 2>$null | Out-Null
                        Write-Host "Stopped stale refresh.js process tree rooted at PID $($existing.ProcessId)."
                    } catch {}
                }
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

            # A stale Node process can be outside the profile-marker query, so
            # perform the profile reset once more after the Node guard.
            Reset-NaukriProfileLocks
            Write-LauncherLog "Main loop: profile cleanup complete."
        } catch {
            Write-LauncherLog ("Main loop cleanup exception: " + $_.Exception.Message)
            Write-Host "Could not clean stale refresh.js processes: $($_.Exception.Message)"
        }

        Hide-NaukriBrowserWindows
        try {
            Write-LauncherLog "Main loop: starting refresh.js recovery routine."
            $nodeProcess = Start-NaukriRefreshWithRecovery -MaxAttempts 5
            while (-not $nodeProcess.HasExited) {
                Hide-NaukriBrowserWindows
                Start-Sleep -Milliseconds 750
                try { $nodeProcess.Refresh() } catch {}
            }
            Hide-NaukriBrowserWindows
            $exitCode = $nodeProcess.ExitCode
            Reset-NaukriProfileLocks
            Write-Host "Naukri Refresh exited. Restarting in 30 seconds."
            Start-Sleep -Seconds 30
        } catch {
            Write-LauncherLog ("Refresh start exception: " + $_.Exception.ToString())
            Write-Host ("Could not start Naukri Refresh cleanly. Retrying. Error: " + $_.Exception.Message)
            Reset-NaukriProfileLocks
            Start-Sleep -Seconds 30
        }
    }
}
finally {
    [NaukriPower]::SetThreadExecutionState([NaukriPower]::ES_CONTINUOUS) | Out-Null
}

exit $exitCode
