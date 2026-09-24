const { chromium } = require("playwright");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const PROFILE_URL = process.env.PROFILE_URL || "https://www.naukri.com/mnjuser/profile";
const RESUME_PATH = path.resolve(process.env.RESUME_PATH || "");
const INTERVAL_MINUTES = Math.max(1, Number(process.env.REFRESH_INTERVAL_MINUTES || 20));
const MAX_FAILURES = Math.max(1, Number(process.env.MAX_CONSECUTIVE_FAILURES || 3));
const HEADLESS = String(process.env.HEADLESS || "false").toLowerCase() === "true";
const DEBUG_PROFILE_UI = String(process.env.DEBUG_PROFILE_UI || "true").toLowerCase() === "true";
const ALERT_EMAIL = String(process.env.ALERT_EMAIL || "").trim();
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const ALERT_COOLDOWN_MINUTES = Math.max(1, Number(process.env.ALERT_COOLDOWN_MINUTES || 60));
const NAVIGATION_RETRIES = 3;
const UPLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
let lastAlertAt = 0;

const emailAlertsEnabled =
  Boolean(ALERT_EMAIL && SMTP_HOST && SMTP_USER && SMTP_PASS);

const mailer = emailAlertsEnabled
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
  : null;

async function sendFailureAlert(subject, errorMessage) {
  if (!mailer) {
    log("Email alerts are not configured; skipping failure email.");
    return;
  }

  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MINUTES * 60 * 1000) {
    log("Failure email suppressed by alert cooldown.");
    return;
  }

  const logTail = fs.readFileSync(
    path.join(logDir, "naukri-refresh.log"),
    "utf8"
  ).split(/\r?\n/).slice(-25).join("\n");

  try {
    await mailer.sendMail({
      from: SMTP_USER,
      to: ALERT_EMAIL,
      subject,
      text:
        "Naukri Refresh automation failure.\n\n" +
        "Error:\n" + errorMessage + "\n\n" +
        "Recent log:\n" + logTail
    });
    lastAlertAt = now;
    log("Failure alert email sent to " + ALERT_EMAIL);
  } catch (mailError) {
    log("Could not send failure alert email: " + mailError.message);
  }
}

const profileDir = path.resolve("naukri-browser-profile");
const logDir = path.resolve("logs");

fs.mkdirSync(logDir, { recursive: true });

function log(message) {
  const line = "[" + new Date().toISOString() + "] " + message;
  console.log(line);
  fs.appendFileSync(path.join(logDir, "naukri-refresh.log"), line + "\n");
}

async function dismissPopups(page) {
  for (const text of ["Not Now", "Skip", "Close", "Maybe Later"]) {
    try {
      const locator = page.getByText(text, { exact: true }).first();
      if (await locator.isVisible({ timeout: 700 }).catch(() => false)) {
        await locator.click({ timeout: 1500 }).catch(() => {});
      }
    } catch {}
  }
}

async function openProfile(page) {
  let lastError;

  for (let attempt = 1; attempt <= NAVIGATION_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        log("Profile navigation retry " + attempt + "/" + NAVIGATION_RETRIES);
        await page.waitForTimeout(RETRY_DELAY_MS);
      }

      await page.goto(PROFILE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      await page.waitForTimeout(2500);
      await dismissPopups(page);
      return;
    } catch (error) {
      lastError = error;
      log(
        "Profile navigation attempt " + attempt + "/" + NAVIGATION_RETRIES +
        " failed: " + error.message
      );
    }
  }

  throw new Error(
    "Could not open Naukri profile after " +
    NAVIGATION_RETRIES +
    " attempts. Last error: " +
    (lastError ? lastError.message : "unknown navigation error")
  );
}

async function setResumeFile(page, fileChooser = null) {
  if (!RESUME_PATH || !fs.existsSync(RESUME_PATH)) {
    throw new Error("RESUME_PATH does not exist: " + RESUME_PATH);
  }

  if (fileChooser) {
    await fileChooser.setFiles(RESUME_PATH);
    return true;
  }

  const input = page.locator('input[type="file"]').first();

  if (await input.count()) {
    await input.setInputFiles(RESUME_PATH);
    return true;
  }

  return false;
}

async function tryNormalProfileUpdate(page) {
  // Only use a normal, visible Naukri control. No CAPTCHA/OTP bypass,
  // hidden activity simulation, or other access-control circumvention.
  const selectors = [
    page.getByRole("button", { name: /^Update Profile$/i }).first(),
    page.getByRole("link", { name: /^Update Profile$/i }).first(),
    page.getByRole("button", { name: /^Update$/i }).first(),
    page.getByRole("link", { name: /^Update$/i }).first(),
    page.getByText(/^Update$/i).first(),
    page.getByText(/^Update Profile$/i).first()
  ];

  for (const control of selectors) {
    if (await control.isVisible({ timeout: 1000 }).catch(() => false)) {
      log("Profile/resume update control found; clicking it.");

      const fileChooserPromise = page
        .waitForEvent("filechooser", { timeout: 10000 })
        .catch(() => null);

      await control.click({ timeout: 5000 }).catch(() => {});

      const fileChooser = await fileChooserPromise;

      if (fileChooser) {
        await setResumeFile(page, fileChooser);
        await page.waitForTimeout(2000);
        log("Native file chooser handled automatically; resume file supplied.");
        return { attempted: true, resumeUploaded: true };
      }

      await page.waitForTimeout(2500);

      if (await setResumeFile(page)) {
        await page.waitForTimeout(2000);
        log("Resume file input detected after profile update; resume supplied.");
        return { attempted: true, resumeUploaded: true };
      }

      return { attempted: true, resumeUploaded: false };
    }
  }

  log("No visible profile update control found on the current Naukri profile page.");

  if (DEBUG_PROFILE_UI) {
    const labels = await page.locator("button, a").evaluateAll(elements =>
      elements
        .map(el => (el.innerText || el.getAttribute("aria-label") || "").trim())
        .filter(text => text && /profile|update|edit|resume/i.test(text))
        .slice(0, 30)
    ).catch(() => []);

    if (labels.length) {
      log("Relevant visible UI labels: " + labels.join(" | "));
    } else {
      log("No relevant profile/update/edit/resume button or link labels detected.");
    }

    await page.screenshot({
      path: path.join(logDir, "profile-ui-cycle-" + Date.now() + ".png"),
      fullPage: true
    }).catch(() => {});
  }

  return { attempted: false, resumeUploaded: false };
}

async function uploadResume(page) {
  if (!RESUME_PATH || !fs.existsSync(RESUME_PATH)) {
    throw new Error("RESUME_PATH does not exist: " + RESUME_PATH);
  }

  let lastError = null;

  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        log("Resume upload retry " + attempt + "/" + UPLOAD_RETRIES);
        await page.waitForTimeout(RETRY_DELAY_MS);
        await openProfile(page);
      }

      let input = page.locator('input[type="file"]').first();

      if (await input.count()) {
        await input.setInputFiles(RESUME_PATH);
        await page.waitForTimeout(2000);
        return;
      }

      const candidates = [
        page.getByText(/Update resume/i).first(),
        page.getByText(/Upload resume/i).first(),
        page.getByRole("button", { name: /resume/i }).first(),
        page.getByRole("link", { name: /resume/i }).first()
      ];

      let clicked = false;

      for (const candidate of candidates) {
        if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
          clicked = true;

          const fileChooserPromise = page
            .waitForEvent("filechooser", { timeout: 10000 })
            .catch(() => null);

          await candidate.click({ timeout: 5000 }).catch(() => {});

          const fileChooser = await fileChooserPromise;

          if (fileChooser) {
            await setResumeFile(page, fileChooser);
            await page.waitForTimeout(2000);
            return;
          }

          await page.waitForTimeout(2500);

          if (await setResumeFile(page)) {
            await page.waitForTimeout(2000);
            return;
          }
        }
      }

      if (!clicked) {
        // Give the page a little more time in case the resume control is
        // rendered asynchronously after the profile page loads.
        await page.waitForTimeout(3000);
      }

      lastError = new Error(
        "Could not find Naukri resume upload control/input on attempt " +
        attempt + "/" + UPLOAD_RETRIES
      );
    } catch (error) {
      lastError = error;
      log(
        "Resume upload attempt " + attempt + "/" + UPLOAD_RETRIES +
        " failed: " + error.message
      );
    }
  }

  if (DEBUG_PROFILE_UI) {
    await page.screenshot({
      path: path.join(logDir, "resume-upload-failure-" + Date.now() + ".png"),
      fullPage: true
    }).catch(() => {});

    const labels = await page.locator("button, a, input").evaluateAll(elements =>
      elements
        .map(el => ({
          tag: el.tagName,
          text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim(),
          type: el.getAttribute("type") || ""
        }))
        .filter(item => item.text || item.type === "file")
        .slice(0, 80)
    ).catch(() => []);

    if (labels.length) {
      log("Resume upload UI snapshot: " + JSON.stringify(labels));
    }
  }

  throw new Error(
    "Could not find Naukri resume upload control/input after " +
    UPLOAD_RETRIES +
    " attempts. The Naukri UI may be temporarily unavailable or may have changed." +
    (lastError ? " Last error: " + lastError.message : "")
  );
}

async function launchBrowserContext() {
  try {
    return await chromium.launchPersistentContext(profileDir, {
      headless: HEADLESS,
      viewport: { width: 1440, height: 900 },
      // Naukri currently requires headed Chromium. Keep the real browser engine
      // active, but start its window off-screen so no Chromium window is visible
      // during normal background operation. File uploads are handled by
      // Playwright's filechooser API, so no native file-picker window is needed.
      args: [
        "--disable-blink-features=AutomationControlled",
        "--start-minimized",
        "--window-position=-32000,-32000"
      ]
    });
  } catch (error) {
    const message = String(error && error.message || error);

    if (/existing browser session|profile is already in use|user-data-dir/i.test(message)) {
      throw new Error(
        "The saved Naukri Chromium profile is already open in another browser/process. " +
        "Close every browser window using this automation session (especially the Naukri automation window), " +
        "then run npm start again. Your saved login/session is not being deleted."
      );
    }

    throw error;
  }
}

(async () => {
  if (!fs.existsSync(profileDir)) {
    throw new Error("No saved Naukri session. Run: npm run login");
  }

  let context;

  try {
    context = await launchBrowserContext();

    let cycle = 0;
    let failures = 0;

    const stop = async () => {
      log("Stopping...");
      if (context) await context.close().catch(() => {});
      process.exit(0);
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    while (true) {
      cycle++;

      try {
        const page = context.pages()[0] || await context.newPage();

        log("Cycle " + cycle + ": opening profile");
        await openProfile(page);

        const profileUpdateResult = await tryNormalProfileUpdate(page);
        log(
          "Cycle " + cycle + ": profile update " +
          (profileUpdateResult.attempted ? "attempted" : "not available")
        );

        if (profileUpdateResult.resumeUploaded) {
          log("Cycle " + cycle + ": resume upload action completed");
        } else {
          log("Cycle " + cycle + ": uploading resume");
          await uploadResume(page);
          log("Cycle " + cycle + ": resume upload action completed");
        }

        failures = 0;
      } catch (error) {
        failures++;
        log("Cycle " + cycle + " failed: " + error.message);
        await sendFailureAlert(
          "Naukri Refresh - cycle " + cycle + " failed",
          error.message
        );

        if (failures >= MAX_FAILURES) {
          log("Stopping after " + failures + " consecutive failures.");
          await sendFailureAlert(
            "Naukri Refresh - automation stopped",
            failures + " consecutive failures. Last error: " + error.message
          );
          await context.close().catch(() => {});
          process.exit(1);
        }
      }

      log("Cycle " + cycle + ": waiting " + INTERVAL_MINUTES + " minutes");
      await new Promise(resolve =>
        setTimeout(resolve, INTERVAL_MINUTES * 60 * 1000)
      );
    }
  } catch (error) {
    log("Startup failed: " + error.message);
    await sendFailureAlert(
      "Naukri Refresh - startup failure",
      error.message
    );
    process.exit(1);
  }
})();