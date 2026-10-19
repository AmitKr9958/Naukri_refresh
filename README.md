# Naukri Refresh

Local Playwright automation for a persistent Naukri browser session and configurable profile/resume refresh.

## Normal foreground mode

Run:

    npm start

The recommended working configuration is HEADLESS=false. The current Naukri UI/session was verified with headed Chromium; headless mode did not expose the required profile/update and resume controls.

## Windows background mode

The repository includes run-background.ps1, install-background.ps1, uninstall-background.ps1, and wake-computer.ps1.

The background task hides the PowerShell terminal. Chromium remains headed internally because the current Naukri UI works with the verified headed session. It is launched minimized and off-screen.

### Sleep / hibernate wake support

Run the installer after pulling the update:

    powershell -ExecutionPolicy Bypass -File .\install-background.ps1

The installer creates two tasks:
- `Naukri Refresh Background`: starts the managed browser loop at user logon and restarts it if it exits.
- `Naukri Refresh Wake Timer`: requests a Windows wake every five minutes and logs each time it runs. It does not start a second Node process or access the saved browser profile.

The installer also attempts to enable wake timers for the active Windows power plan on AC and battery. Verify the scheduled wake task in Task Scheduler if the laptop does not wake.

**Important limitation:** a program cannot execute while Windows is actually suspended. This approach asks Windows to wake the laptop periodically so the existing loop can resume. Whether Windows can wake from Sleep or Hibernate depends on power settings, device firmware, Modern Standby/S3 support, and whether wake timers are allowed. Hibernate wake is not supported on every device. It cannot run while the laptop is shut down, powered off, or out of battery. This is a best-effort local-computer workaround, not a guarantee of continuous execution in every power state.

The wake task may wake the laptop every five minutes, which can reduce battery life. Use AC power for long unattended runs. The display may turn off normally.

Runtime logs are written to `logs\naukri-refresh.log`; wake-task activity is written to `logs\wake-timer.log`. The automation also maintains `naukri-refresh-health.json` with the latest cycle/status and rotates the main log after it reaches the configured size.

### Self-healing background execution

- Windows Task Scheduler starts the launcher at user logon.
- If refresh.js exits, the launcher restarts it.
- If PowerShell exits unexpectedly, Task Scheduler has its own restart policy.
- Only one scheduled-task instance is allowed at a time.
- The existing Naukri navigation/upload retry logic remains unchanged.
- `refresh.js` has its own PID lock, so a second copy cannot create a competing Chromium profile session.
- Browser-context failures are recovered automatically when possible.
- Successful cycles, failures, and browser recovery events can be sent to Telegram at no cost.
- The log is rotated automatically to prevent unbounded disk growth.

Start now:

    Start-ScheduledTask -TaskName "Naukri Refresh Background"

Check status:

    Get-ScheduledTask -TaskName "Naukri Refresh Background","Naukri Refresh Wake Timer" | Get-ScheduledTaskInfo

Uninstall:

    powershell -ExecutionPolicy Bypass -File .\uninstall-background.ps1

### Important

- The PowerShell/terminal window is hidden.
- Chromium is headed internally for compatibility and launched minimized/off-screen; Windows may still show its taskbar entry depending on system behavior.
- The wake task is best-effort and cannot guarantee wake from Hibernate on all laptops.
- The laptop must remain powered and the Windows user session available for the browser UI.
- The window-hiding is local desktop behavior only; it is not intended to hide automation from Naukri or bypass anti-bot controls.
- If Naukri presents CAPTCHA, OTP, verification, or a restriction, stop and complete the required human verification manually.

### Telegram notifications

Set `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in your local `.env`. Telegram configuration is optional; notification failure does not mark the Naukri cycle as failed.

### Verification

    node --check refresh.js
    git status --short

Do not run `node refresh.js` manually while the scheduled task is already running. The built-in PID lock and launcher protect the saved Chromium profile; one managed instance is the intended operating mode.

## Security

Never commit .env, your browser session, logs, or your resume.
