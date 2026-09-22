# Naukri Refresh

Local Playwright automation for a persistent Naukri browser session and configurable profile/resume refresh.

## Normal foreground mode

Run:

    npm start

The recommended working configuration is HEADLESS=false. The current Naukri UI/session was verified with headed Chromium; headless mode did not expose the required profile/update and resume controls.

## Windows background mode

The repository includes run-background.ps1, install-background.ps1, and uninstall-background.ps1.

The background task hides the PowerShell terminal, but intentionally does not force Chromium into headless mode because the current Naukri UI works with the verified headed session.

Install once:

    powershell -ExecutionPolicy Bypass -File .\install-background.ps1

Start now:

    Start-ScheduledTask -TaskName "Naukri Refresh Background"

Check status:

    Get-ScheduledTask -TaskName "Naukri Refresh Background" | Get-ScheduledTaskInfo

Uninstall:

    powershell -ExecutionPolicy Bypass -File .\uninstall-background.ps1

### Important

- The PowerShell/terminal window is hidden.
- Chromium is headed and may be visible because this is the verified working mode.
- This is not intended to hide automation from Naukri or bypass anti-bot controls.
- Keep the Windows user session available for the browser UI.
- The task cannot run while the laptop is powered off.
- If Naukri presents CAPTCHA, OTP, verification, or a restriction, stop and complete the required human verification manually.

## Security

Never commit .env, your browser session, logs, or your resume.
