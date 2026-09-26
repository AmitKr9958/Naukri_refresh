# Naukri Refresh

Local Playwright automation for a persistent Naukri browser session and configurable profile/resume refresh.

## Normal foreground mode

Run:

    npm start

The recommended working configuration is HEADLESS=false. The current Naukri UI/session was verified with headed Chromium; headless mode did not expose the required profile/update and resume controls.

## Windows background mode

The repository includes run-background.ps1, install-background.ps1, and uninstall-background.ps1.

The background task hides the PowerShell terminal and hides the automation Chromium window from the Windows desktop/taskbar. Chromium remains headed internally because the current Naukri UI works with the verified headed session.

The background launcher also requests that Windows keep the system awake while the automation is running. The display is not forced to stay on, so the screen can turn off normally.

### Self-healing background execution

- Windows Task Scheduler starts the launcher at user logon.
- If refresh.js exits, the launcher waits 60 seconds and starts it again.
- If PowerShell itself exits unexpectedly, Task Scheduler has its own restart policy.
- Only one scheduled-task instance is allowed at a time.
- The existing Naukri navigation/upload retry logic remains unchanged.
- A Node/browser failure therefore does not permanently stop the background service.

Install or repair the task after pulling updates:

    powershell -ExecutionPolicy Bypass -File .\\install-background.ps1

Start now:

    Start-ScheduledTask -TaskName "Naukri Refresh Background"

Check status:

    Get-ScheduledTask -TaskName "Naukri Refresh Background" | Get-ScheduledTaskInfo

Uninstall:

    powershell -ExecutionPolicy Bypass -File .\\uninstall-background.ps1

### Important

- The PowerShell/terminal window is hidden.
- Chromium is headed internally for compatibility, but the background launcher hides the automation window from the desktop/taskbar.
- The launcher prevents idle Windows sleep while the automation is running, while still allowing the display to turn off.
- A user-initiated Sleep/Hibernate, shutdown, reboot, battery depletion, or loss of power can still stop the automation.
- The task cannot run while the laptop is powered off.
- Keep the Windows user session available for the browser UI.
- The window-hiding is local desktop behavior only; it is not intended to hide automation from Naukri or bypass anti-bot controls.
- If Naukri presents CAPTCHA, OTP, verification, or a restriction, stop and complete the required human verification manually.

## Security

Never commit .env, your browser session, logs, or your resume.
