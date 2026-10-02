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

$refreshScript = Join-Path $repo "refresh.js"

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

    $result
}

function Stop-NaukriAutomationBrowsers {
    # Chromium uses a process tree (browser + renderer/GPU/network/utility
    # children). Kill only the automation domain, including descendants of
    # the managed refresh.js process even when a Chromium child does not expose
    # the profile path in its command line.
    try {
        for ($pass = 1; $pass -le 3; $pass++) {
            $processes = @(Get-NaukriAutomationProcesses)
            $refreshRoots = @(
                $processes |
                    Where-Object {
                        $_.Name -eq "node.exe" -and
                        $_.CommandLine -and
                        $_.CommandLine.IndexOf($refreshScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
                    }
            )

            foreach ($root in $refreshRoots) {
                foreach ($child in @(Get-NaukriProcessTree -RootPid ([int]$root.ProcessId) | Sort-Object @{Expression={ $_.ProcessId }; Descending=$true})) {
                    try {
                        & taskkill.exe /PID ([string]$child.ProcessId) /T /F 2>$null | Out-Null
                    } catch {}
                }

                try {
                    & taskkill.exe /PID ([string]$root.ProcessId) /T /F 2>$null | Out-Null
                    Write-Host "Stopped managed refresh.js process tree rooted at PID $($root.ProcessId)."
                } catch {}
            }

            foreach ($processInfo in @(Get-NaukriAutomationProcesses)) {
                try {
                    & taskkill.exe /PID ([string]$processInfo.ProcessId) /T /F 2>$null | Out-Null
                    Write-Host "Stopped remaining managed automation process tree rooted at PID $($processInfo.ProcessId)."
                } catch {}
            }

            for ($attempt = 1; $attempt -le 10; $attempt++) {
                $remaining = @(Get-NaukriAutomationProcesses)
                if (-not $remaining) {
                    return
                }
                Start-Sleep -Milliseconds 500
            }
        }

        $remaining = @(Get-NaukriAutomationProcesses)
        if ($remaining) {
            Write-Host "Warning: $($remaining.Count) managed automation process(es) still remain after cleanup."
        }
    } catch {
        Write-Host "Could not clean managed automation process tree: $($_.Exception.Message)"
    }
}

function Clear-StaleNaukriProfileLock {
    try {
        $activeProcesses = @(Get-NaukriAutomationProcesses)
        if ($activeProcesses) { Write-Host "Managed automation process still present; cleanup deferred."; return $false }
        foreach ($lockName in @("SingletonLock", "SingletonCookie", "SingletonSocket")) {
            $lockPath = Join-Path $profileMarker $lockName
            if (Test-Path -LiteralPath $lockPath) {
                try { Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop; Write-Host "Removed stale Chromium lock: $lockName" } catch { Write-Host "Could not remove Chromium lock: $lockName" }
            }
        }
        return $true
    } catch { Write-Host "Could not clear stale Chromium profile locks."; return $false }
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
            Start-Sleep -Seconds 10
            try { $nodeProcess.Refresh() } catch {}
            if (-not $nodeProcess.HasExited) { Write-Host "Naukri Refresh started successfully."; return $nodeProcess }
            Write-Host "Naukri Refresh exited during startup. Cleaning and retrying."
            Reset-NaukriProfileLocks
        } catch { Write-Host "Could not start Naukri Refresh. Retrying." }
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
        # Ensure only one managed refresh.js process exists and reset the
        # complete automation domain before every launch.
        try {
            Reset-NaukriProfileLocks

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
        } catch {
            Write-Host "Could not clean stale refresh.js processes: $($_.Exception.Message)"
        }

        Hide-NaukriBrowserWindows
        try {
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
            Write-Host "Could not start Naukri Refresh cleanly. Retrying."
            Reset-NaukriProfileLocks
            Start-Sleep -Seconds 30
        }
    }
}
finally {
    [NaukriPower]::SetThreadExecutionState([NaukriPower]::ES_CONTINUOUS) | Out-Null
}

exit $exitCode
