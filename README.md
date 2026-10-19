# Naukri Refresh

Local Playwright automation for a persistent Naukri browser session and configurable profile/resume refresh.

## Normal foreground mode

Run:

    npm start

The recommended working configuration is `HEADLESS=false`. The current Naukri UI/session was verified with headed Chromium; headless mode did not expose the required profile/update and resume controls.

## Windows background mode

The repository includes `run-background.ps1`, `install-background.ps1`, and `uninstall-background.ps1`.

The background task hides the PowerShell terminal. Chromium remains headed internally because the current Naukri UI works with the verified headed session. It is launched minimized and off-screen; the launcher does not compile or use a native window-hiding helper.

### Sleep / Hibernate support (best effort)

Windows suspends normal application execution during Sleep and Hibernate. This project cannot keep JavaScript/Chromium actively running while Windows is suspended. The installer now adds a separate **Naukri Refresh Wake Timer** scheduled task intended to wake the computer every five minutes so the existing refresh process can resume after a supported Sleep/Hibernate wake.

Important limitations:
- This is a best-effort wake-and-resume workaround, **not continuous execution while the laptop is suspended**.
- Wake timers must be enabled in the active Windows power plan. On some laptops, firmware, Modern Standby, or organizational policies may block scheduled wake-up.
- Wake from Hibernate depends on device and firmware support; it is not guaranteed.
- Keep the laptop connected to AC power. Periodic wake-ups can consume battery and may cause the laptop to stay awake until Windows' idle-sleep policy takes effect.
- It cannot work while Windows is shut down, the laptop is powered off, the battery is depleted, or power is disconnected.
- The current browser automation needs the Windows user session and a headed Chromium browser. Verify behavior on your own device before relying on it.

To check wake timer availability, run in PowerShell:

    powercfg /waketimers
    powercfg /a

In Windows, open **Control Panel → Power Options → Change plan settings → Change advanced power settings → Sleep → Allow wake timers** and enable wake timers (at least while plugged in, if that option is available). Menu names vary by Windows/device version. Do not assume hibernate wake is supported just because the task was installed.

## Install or update the background tasks

After pulling the repository updates, run PowerShell as your normal Windows user (not necessarily as Administrator):

    powershell -ExecutionPolicy Bypass -File .\\install-background.ps1

This installs:
- `Naukri Refresh Background`: starts the launcher when you log in and restarts it if the process exits.
- `Naukri Refresh Wake Timer`: a best-effort wake timer repeating every five minutes.

Start the main automation now:

    Start-ScheduledTask -TaskName "Naukri Refresh Background"

Check task state and last-run information:

    Get-ScheduledTask -TaskName "Naukri Refresh Background","Naukri Refresh Wake Timer" | Get-ScheduledTaskInfo

Check currently registered wake timers:

    powercfg /waketimers

Remove both tasks:

    powershell -ExecutionPolicy Bypass -File .\\uninstall-background.ps1

## Self-healing background execution

- Windows Task Scheduler starts the launcher at user logon.
- If `refresh.js` exits, the launcher retries it after a delay.
- If PowerShell itself exits unexpectedly, Task Scheduler has its own restart policy.
- Only one scheduled-task instance is allowed at a time.
- The existing Naukri navigation/upload retry logic remains unchanged.
- `refresh.js` has its own PID lock, so manually starting a second copy cannot create a competing Chromium profile session.
- Browser-context failures are recovered automatically when possible.
- Successful cycles, failures, and browser recovery events can be sent to Telegram at no cost.
- The log is rotated automatically to prevent unbounded disk growth.

## Important

- The PowerShell/terminal window is hidden.
- Chromium is headed internally for compatibility and launched minimized/off-screen; Windows may still show its taskbar entry depending on system behavior.
- A successful task installation does not prove that the laptop can wake from Sleep/Hibernate. Test a short sleep interval and check logs/health after resume.
- `WAITING` health status alone does not prove that Naukri saved the resume. Confirm the displayed resume and last-updated time on Naukri.
- Window hiding is local desktop behavior only; it is not intended to hide automation from Naukri or bypass anti-bot controls.
- If Naukri presents CAPTCHA, OTP, verification, or a restriction, stop and complete the required human verification manually.

## Runtime health and logs

Runtime logs are written to `logs\\naukri-refresh.log`. The automation also maintains `naukri-refresh-health.json` with the latest cycle/status and rotates the main log after it reaches the configured size.

## Telegram notifications

Set `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in your local `.env`. The bot receives a success heartbeat after each completed refresh cycle, plus failure and browser-recovery notifications. Telegram configuration is optional; notification failure does not mark the Naukri cycle as failed.

## Verification

Before relying on a code update:

    node --check refresh.js
    git status --short

Do not run `node refresh.js` manually while the scheduled task is already running. The built-in PID lock and background launcher both protect the saved Chromium profile, but one managed instance is the intended operating mode.

## Security

Never commit `.env`, your browser session, logs, or your resume.
