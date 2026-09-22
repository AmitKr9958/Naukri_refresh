# Naukri Refresh

Local Playwright automation for a persistent Naukri browser session and configurable profile/resume refresh.

## Safety and account protection

This tool is intended for personal use. Naukri can change its UI, require CAPTCHA/OTP, or apply anti-automation controls. Review Naukri's current Terms of Service before use. If Naukri presents a warning, CAPTCHA, verification, or restriction, stop the tool rather than attempting to bypass it.

Your password, browser session, logs, and resume are kept off GitHub by .gitignore.

## Windows setup

Install Node.js 18+.

Clone and install:

    git clone https://github.com/AmitKr9958/Naukri_refresh.git
    cd Naukri_refresh
    npm install
    npm run install-browser

Create your local configuration:

    Copy-Item .env.example .env

Edit .env with your own resume path and desired interval.

## First login

Run:

    npm run login

A normal Chromium window opens. Complete Naukri login, OTP and CAPTCHA yourself if requested. When your profile is visible, return to the terminal and press Enter.

The persistent browser session is saved locally in:

    naukri-browser-profile/

## Normal foreground mode

Run:

    npm start

This uses the HEADLESS value from .env.

## Windows background mode

The repository includes:

    run-background.ps1
    install-background.ps1
    uninstall-background.ps1

The background runner forces Playwright into headless mode, so no browser window is intended to appear.

After the first manual login, install the Windows Task Scheduler task once:

    powershell -ExecutionPolicy Bypass -File .\install-background.ps1

Then start it immediately:

    Start-ScheduledTask -TaskName "Naukri Refresh Background"

The task is configured to start when your Windows user logs in and to restart if the process exits unexpectedly.

Check its status:

    Get-ScheduledTask -TaskName "Naukri Refresh Background" | Get-ScheduledTaskInfo

Stop/uninstall the task:

    powershell -ExecutionPolicy Bypass -File .\uninstall-background.ps1

Important: Windows Task Scheduler runs only while the laptop is powered on and the Windows user session is available. It does not run while the laptop is shut down.

## If Naukri changes its UI

For troubleshooting, temporarily use HEADLESS=false and inspect the page. The automation uses normal visible profile/update controls and the resume file input.

Do not bypass CAPTCHA or account verification. If the UI requires human verification, complete it manually.

## Security

Never commit .env, your browser session, logs, or your resume. These paths are already ignored.

This project does not automatically apply to jobs, message recruiters, or modify your employment history.
