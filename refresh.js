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
const DEBUG_PROFILE_UI = String(process.env.DEBUG_PROFILE_UI || "false").toLowerCase() === "true";
const ALERT_EMAIL = String(process.env.ALERT_EMAIL || "").trim();
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const ALERT_COOLDOWN_MINUTES = Math.max(1, Number(process.env.ALERT_COOLDOWN_MINUTES || 60));
const TELEGRAM_ENABLED = String(process.env.TELEGRAM_ENABLED || "false").toLowerCase() === "true";
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const LOG_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024));
const INSTANCE_LOCK_PATH = path.resolve("naukri-refresh.lock");
const HEALTH_PATH = path.resolve("naukri-refresh-health.json");
const NAVIGATION_RETRIES = 3;
const UPLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
let lastAlertAt = 0;

const emailAlertsEnabled =
  Boolean(ALERT_EMAIL && SMTP_HOST && SMTP_USER && SMTP_PASS);

const telegramAlertsEnabled =
  TELEGRAM_ENABLED &&
  Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

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


async function sendTelegramMessage(text, eventLabel) {
  if (!telegramAlertsEnabled) {
    return false;
  }

  try {
    const response = await fetch(
      "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true
        })
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        "Telegram API " + response.status + ": " + responseText.slice(0, 1000)
      );
    }

    log("Telegram " + eventLabel + " message sent.");
    return true;
  } catch (error) {
    log("Could not send Telegram " + eventLabel + " message: " + error.message);
    return false;
  }
}

async function sendTelegramSuccess(cycle) {
  const message =
    "🟢 Naukri Automation — SUCCESS\n\n" +
    "Run: #" + cycle + "\n" +
    "Profile update: Completed/attempted\n" +
    "Resume upload: Completed successfully\n" +
    "Interval: " + INTERVAL_MINUTES + " minutes\n" +
    "Time: " +
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + "\n\n" +
    "Status: Running normally";

  await sendTelegramMessage(message, "success");
}

async function sendTelegramFailure(cycle, errorMessage, recoveryStatus = "") {
  const recoveryLine = recoveryStatus ? "\nRecovery: " + recoveryStatus : "";
  const message =
    "🔴 Naukri Automation — FAILED\n\n" +
    "Run: #" + cycle + "\n" +
    "Error: " + errorMessage + recoveryLine + "\n" +
    "Time: " +
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  await sendTelegramMessage(message, "failure");
}

async function sendTelegramRecovery(cycle) {
  const message =
    "🟡 Naukri Automation — RECOVERED\n\n" +
    "Run: #" + cycle + "\n" +
    "The browser session was unexpectedly closed.\n" +
    "Chromium session was successfully relaunched.\n\n" +
    "Automation is continuing normally.\n" +
    "Time: " +
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  await sendTelegramMessage(message, "recovery");
}

const profileDir = path.resolve("naukri-browser-profile");
const logDir = path.resolve("logs");

fs.mkdirSync(logDir, { recursive: true });

function rotateLogIfNeeded() {
  const logPath = path.join(logDir, "naukri-refresh.log");
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size >= LOG_MAX_BYTES) {
      const rotatedPath = logPath + ".1";
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }
      fs.renameSync(logPath, rotatedPath);
    }
  } catch {}
}

function log(message) {
  const line = "[" + new Date().toISOString() + "] " + message;
  console.log(line);
  rotateLogIfNeeded();
  fs.appendFileSync(path.join(logDir, "naukri-refresh.log"), line + "\n");
}

function writeHealth(status, cycle, details = {}) {
  try {
    const payload = {
      status,
      cycle,
      pid: process.pid,
      interval_minutes: INTERVAL_MINUTES,
      updated_at: new Date().toISOString(),
      ...details
    };
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(payload, null, 2) + "\n");
  } catch (error) {
    console.log("[health] Could not write health state: " + error.message);
  }
}

function acquireInstanceLock() {
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  try {
    fs.writeFileSync(INSTANCE_LOCK_PATH, payload, { flag: "wx" });
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  try {
    const existing = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, "utf8"));
    const existingPid = Number(existing.pid);
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0);
        throw new Error("Another refresh.js instance is already running (PID " + existingPid + ").");
      } catch (probeError) {
        if (probeError && probeError.message && /another refresh\.js instance/i.test(probeError.message)) {
          throw probeError;
        }
      }
    }
  } catch (error) {
    if (error && /another refresh\.js instance/i.test(String(error.message || ""))) {
      throw error;
    }
  }

  fs.unlinkSync(INSTANCE_LOCK_PATH);
  fs.writeFileSync(INSTANCE_LOCK_PATH, payload, { flag: "wx" });
}

function releaseInstanceLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, "utf8"));
    if (Number(existing.pid) === process.pid) {
      fs.unlinkSync(INSTANCE_LOCK_PATH);
    }
  } catch {}
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

function contextIsClosed(ctx) {
  try {
    return !ctx || (typeof ctx.isClosed === "function" && ctx.isClosed());
  } catch {
    return true;
  }
}

async function recoverBrowserContext(currentContext) {
  if (currentContext) {
    await currentContext.close().catch(() => {});
  }

  log("Browser context is closed; relaunching the saved Naukri Chromium session.");
  return await launchBrowserContext();
}

(async () => {
  if (!fs.existsSync(profileDir)) {
    throw new Error("No saved Naukri session. Run: npm run login");
  }

  let context;

  try {
    acquireInstanceLock();
    writeHealth("STARTING", 0);
    context = await launchBrowserContext();
    writeHealth("RUNNING", 0, { next_cycle: 1 });

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
      writeHealth("RUNNING", cycle, { phase: "starting_cycle" });

      try {
        // The long-running Chromium session can occasionally disappear after
        // many cycles. Never keep using a closed BrowserContext: recover it
        // before creating the next page so one transient browser crash does not
        // turn into repeated "Target page, context or browser has been closed"
        // failures for every subsequent cycle.
        if (contextIsClosed(context)) {
          context = await recoverBrowserContext(context);
        }

        let page = null;
        try {
          page = context.pages().find(candidate => !candidate.isClosed()) || null;
        } catch {
          page = null;
        }

        if (!page) {
          page = await context.newPage();
        }

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
        writeHealth("SUCCESS", cycle, {
          phase: "waiting",
          last_success_at: new Date().toISOString(),
          next_cycle: cycle + 1,
          next_cycle_after_minutes: INTERVAL_MINUTES
        });
        await sendTelegramSuccess(cycle);
      } catch (error) {
        const errorMessage = String(error && error.message || error);
        const contextClosedError =
          /browserContext\.newPage: Target page, context or browser has been closed/i.test(errorMessage) ||
          /Target page, context or browser has been closed/i.test(errorMessage) ||
          /browser context.*closed/i.test(errorMessage);

        if (contextClosedError) {
          log("Cycle " + cycle + " detected a closed browser context; recovering Chromium session.");
          try {
            context = await recoverBrowserContext(context);
            failures = 0;
            log("Cycle " + cycle + ": browser session recovered successfully.");
            writeHealth("RECOVERED", cycle, { phase: "waiting", recovery_at: new Date().toISOString(), next_cycle: cycle + 1 });
            await sendTelegramRecovery(cycle);
          } catch (recoveryError) {
            failures++;
            log("Cycle " + cycle + ": browser session recovery failed: " + recoveryError.message);
            await sendFailureAlert(
              "Naukri Refresh - browser recovery failed",
              recoveryError.message
            );
            await sendTelegramFailure(
              cycle,
              recoveryError.message,
              "Browser recovery failed"
            );
          }
        } else {
          failures++;
          log("Cycle " + cycle + " failed: " + errorMessage);
          writeHealth("FAILED", cycle, { phase: "error", error: errorMessage });
          await sendFailureAlert(
            "Naukri Refresh - cycle " + cycle + " failed",
            errorMessage
          );
          await sendTelegramFailure(cycle, errorMessage);
        }

        if (failures >= MAX_FAILURES) {
          log("Stopping after " + failures + " consecutive failures.");
          await sendFailureAlert(
            "Naukri Refresh - automation stopped",
            failures + " consecutive failures. Last error: " + error.message
          );
          await sendTelegramFailure(
            cycle,
            failures + " consecutive failures. Last error: " + error.message,
            "Automation stopped after " + failures + " consecutive failures"
          );
          writeHealth("STOPPED", cycle, { phase: "max_consecutive_failures", failures });
          await context.close().catch(() => {});
          process.exit(1);
        }
      }

      writeHealth("WAITING", cycle, { phase: "waiting", next_cycle: cycle + 1, next_cycle_after_minutes: INTERVAL_MINUTES });
      log("Cycle " + cycle + ": waiting " + INTERVAL_MINUTES + " minutes");
      await new Promise(resolve =>
        setTimeout(resolve, INTERVAL_MINUTES * 60 * 1000)
      );
    }
  } catch (error) {
    writeHealth("STARTUP_FAILED", 0, { phase: "startup", error: error.message });
    log("Startup failed: " + error.message);
    await sendFailureAlert(
      "Naukri Refresh - startup failure",
      error.message
    );
    await sendTelegramFailure(0, error.message, "Startup failed");
    process.exit(1);
  } finally {
    releaseInstanceLock();
  }
})();