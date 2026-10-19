$taskNames = @(
    "Naukri Refresh Background",
    "Naukri Refresh Wake Timer"
)

foreach ($taskName in $taskNames) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed task if present: $taskName"
}

Write-Host "Naukri Refresh background and wake tasks removed." -ForegroundColor Green
