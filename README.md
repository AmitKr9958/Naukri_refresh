# Naukri Refresh

Local Playwright automation for a persistent Naukri browser session and configurable resume refresh.

## Safety and account protection

This tool is intended for personal use. Naukri can change its UI, require CAPTCHA/OTP, or apply anti-automation controls. Review Naukri's current Terms of Service before use. A 10-minute interval is intentionally configurable; if Naukri presents a warning, CAPTCHA, verification, or restriction, stop the tool rather than attempting to bypass it.

Your password, browser session, logs, and resume PDF are kept off GitHub by .gitignore.

## Windows setup

Install Node.js 18+.

Clone and install:

    git clone https://github.com/AmitKr9958/Naukri_refresh.git
    cd Naukri_refresh
    npm install
    npm run install-browser

Create your local configuration:

    Copy-Item .env.example .env

Edit .env:

    RESUME_PATH=C:\Users\YOUR_NAME\Documents\Resume.pdf
    REFRESH_INTERVAL_MINUTES=10
    HEADLESS=false

## First login

Run:

    npm run login

A normal Chromium window opens. Complete Naukri login, OTP and CAPTCHA yourself if requested. When your profile is visible, return to the terminal and press Enter.

The persistent browser session is saved locally in:

    naukri-browser-profile/

## Start the refresh loop

Run:

    npm start

The process attempts the configured resume upload, writes a timestamped result to logs/naukri-refresh.log, waits the configured number of minutes, and repeats.

Stop with Ctrl+C.

## If Naukri changes its UI

Run with HEADLESS=false and inspect the page. The upload logic is in refresh.js and uses a file input first, followed by common resume controls.

Do not try to bypass CAPTCHA or account verification. If the UI requires human verification, complete it manually.

## Security

Never commit .env, your browser session, logs, or your resume. These paths are already ignored.

This project does not automatically apply to jobs, message recruiters, or modify your employment history.
