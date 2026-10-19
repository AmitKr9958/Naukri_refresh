# Lightweight scheduled wake task for Naukri Refresh.
# It deliberately does not start Node or touch the saved Chromium profile.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $repo "logs"
$logFile = Join-Path $logDir "wake-timer.log"

try {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Add-Content -LiteralPath $logFile -Value ("[" + (Get-Date -Format o) + "] Wake timer task ran. The managed refresh loop should resume if Windows woke successfully.")
} catch {
    # Logging must not prevent the wake task from exiting.
}
