# Naukri Refresh

Local Playwright automation for a persistent Naukri browser session and configurable profile/resume refresh.

## Normal foreground mode

Run:

    npm start

The recommended working configuration is HEADLESS=false. The current Naukri UI/session was verified with headed Chromium; headless mode did not expose the required profile/update and resume controls.

## Windows background mode

The repository includes run-background.ps1, install-background.ps1, and uninstall-background.ps1.

The background task hides the PowerShell terminal and hides the automation Chromium window from the Windows desktop/taskbar. Chromium remains headed internally because the current Naukri UI works with the verified headed session.

The background launcher also requests that Windows keep the system awake while the automation is running. The display is not forced to stay on, so the screen can turn off normally.\n\nRuntime logs are written to `logs\\naukri-refresh.log`. The automation also maintains `naukri-refresh-health.json` with the latest cycle/status and rotates the main log after it reaches the configured size.

### Self-healing background execution

- Windows Task Scheduler starts the launcher at user logon.
- If refresh.js exits, the launcher waits 60 seconds and starts it again.
- If PowerShell itself exits unexpectedly, Task Scheduler has its own restart policy.
- Only one scheduled-task instance is allowed at a time.
- The existing Naukri navigation/upload retry logic remains unchanged.\n- `refresh.js` has its own PID lock, so manually starting a second copy cannot create a competing Chromium profile session.\n- Browser-context failures are recovered automatically when possible.\n- Successful cycles, failures, and browser recovery events can be sent to Telegram at no cost.\n- The log is rotated automatically to prevent unbounded disk growth.
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

### Telegram notifications\n\nSet `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in your local `.env`. The bot receives a success heartbeat after each completed refresh cycle, plus failure and browser-recovery notifications. Telegram configuration is optional; notification failure does not mark the Naukri cycle as failed.\n\n### Verification\n\nBefore restarting the background task after a code update:\n\n    node --check refresh.js\n    git status --short\n\nDo not run `node refresh.js` manually while the scheduled task is already running. The built-in PID lock and the background launcher both protect the saved Chromium profile, but one managed instance is the intended operating mode.\n\n## Security

Never commit .env, your browser session, logs, or your resume.
