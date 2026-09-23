# Runs Naukri Refresh from Windows Task Scheduler.
# The PowerShell launcher and the automation Chromium window are hidden.
# Chromium remains headed because this is the mode verified to work with Naukri.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo
$env:HEADLESS = "false"

# Keep Windows awake while this automation is running.
# This prevents idle sleep without forcing the display to stay on.
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

# Hide only Chromium windows belonging to this automation's dedicated
# Playwright profile. This does not hide the user's normal Chrome windows.
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

function Hide-NaukriBrowserWindows {
    try {
        $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf($profileMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $_.Name -match '^(chrome|msedge|chromium)(\.exe)?$'
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

# ES_SYSTEM_REQUIRED prevents Windows from entering idle sleep while the
# refresh process is alive. ES_DISPLAY_REQUIRED is intentionally not used,
# so the display can still turn off normally.
[NaukriPower]::SetThreadExecutionState(
    [NaukriPower]::ES_CONTINUOUS -bor [NaukriPower]::ES_SYSTEM_REQUIRED
) | Out-Null

$exitCode = 1

try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $refreshScript = Join-Path $repo "refresh.js"
    $nodeProcess = Start-Process -FilePath $node -ArgumentList @($refreshScript) -WorkingDirectory $repo -PassThru -WindowStyle Hidden

    # Hide the headed Chromium window as soon as it appears, then keep enforcing
    # the hidden state while the long-running refresh process is alive.
    while (-not $nodeProcess.HasExited) {
        Hide-NaukriBrowserWindows
        Start-Sleep -Milliseconds 750
        try { $nodeProcess.Refresh() } catch {}
    }

    Hide-NaukriBrowserWindows
    $exitCode = $nodeProcess.ExitCode
}
finally {
    # Return Windows to its normal power-management behavior when the
    # automation stops.
    [NaukriPower]::SetThreadExecutionState([NaukriPower]::ES_CONTINUOUS) | Out-Null
}

exit $exitCode
