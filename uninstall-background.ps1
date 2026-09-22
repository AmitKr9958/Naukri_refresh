$taskName = "Naukri Refresh Background"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Naukri Refresh background task removed." -ForegroundColor Green
