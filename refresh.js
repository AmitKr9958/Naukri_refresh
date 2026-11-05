const { chromium } = require("playwright");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { acquireInstanceLock, releaseInstanceLock } = require("./instance-lock");
require("dotenv").config();

function readPositiveNumberEnv(name, fallback, minimum = 1, integer = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return integer ? Math.floor(parsed) : parsed;
}

const PROFILE_URL = process.env.PROFILE_URL || "https://www.naukri.com/mnjuser/profile";
const RESUME_PATH = path.resolve(process.env.RESUME_PATH || "");
const INTERVAL_MINUTES = 5; // Required fixed interval: begin a new cycle every five minutes.
const MAX_FAILURES = readPositiveNumberEnv("MAX_CONSECUTIVE_FAILURES", 3, 1, true);
// Naukri profile/resume controls are not reliably visible under headless Chromium.
// Prefer headed mode. run-background.ps1 forces HEADLESS=false for the scheduled task.
const HEADLESS = String(process.env.HEADLESS || "false").toLowerCase() === "true";
const DEBUG_PROFILE_UI = String(process.env.DEBUG_PROFILE_UI || "false").toLowerCase() === "true";
if (HEADLESS) {
  // Emitted once at process load so logs clearly explain missing UI controls.
  console.log(
    "[" +
      new Date().toISOString() +
      "] WARNING: HEADLESS=true. Naukri resume/profile update controls often fail in headless mode. " +
      "Use HEADLESS=false (run-background.ps1 forces this for the scheduled task)."
  );
}
const ALERT_EMAIL = String(process.env.ALERT_EMAIL || "").trim();
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = readPositiveNumberEnv("SMTP_PORT", 587, 1, true);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const ALERT_COOLDOWN_MINUTES = readPositiveNumberEnv("ALERT_COOLDOWN_MINUTES", 60, 1, true);
const TELEGRAM_ENABLED = String(process.env.TELEGRAM_ENABLED || "false").toLowerCase() === "true";
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const LOG_MAX_BYTES = readPositiveNumberEnv("LOG_MAX_BYTES", 5 * 1024 * 1024, 1024 * 1024, true);
const NOTIFICATION_TIMEOUT_MS = readPositiveNumberEnv("NOTIFICATION_TIMEOUT_MS", 15000, 1000, true);
const TELEGRAM_RETRIES = readPositiveNumberEnv("TELEGRAM_RETRIES", 3, 1, true);
const TELEGRAM_RETRY_DELAY_MS = readPositiveNumberEnv("TELEGRAM_RETRY_DELAY_MS", 3000, 250, true);
const TELEGRAM_QUEUE_PATH = path.resolve("telegram-notification-queue.json");
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
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: NOTIFICATION_TIMEOUT_MS,
      greetingTimeout: NOTIFICATION_TIMEOUT_MS,
      socketTimeout: NOTIFICATION_TIMEOUT_MS
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


function queueTelegramNotification(text, eventLabel) {
  if (!telegramAlertsEnabled) return;
  try {
    const queue = readTelegramQueue();

    queue.push({
      event_label: eventLabel,
      text,
      queued_at: new Date().toISOString()
    });

    // Keep the queue bounded so a prolonged Telegram outage cannot grow it forever.
    const boundedQueue = queue.slice(-100);
    fs.writeFileSync(TELEGRAM_QUEUE_PATH, JSON.stringify(boundedQueue, null, 2) + "\n");
    log("Telegram " + eventLabel + " notification queued for retry.");
  } catch (error) {
    log("Could not persist Telegram " + eventLabel + " notification: " + error.message);
  }
}

async function sendTelegramMessage(text, eventLabel, queueOnFailure = true) {
  if (!TELEGRAM_ENABLED) {
    log("Telegram " + eventLabel + " notification skipped: TELEGRAM_ENABLED is not true.");
    return false;
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log(
      "Telegram " + eventLabel +
      " notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing."
    );
    return false;
  }

  if (!telegramAlertsEnabled) {
    log("Telegram " + eventLabel + " notification skipped: Telegram configuration is incomplete.");
    return false;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= TELEGRAM_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), NOTIFICATION_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(
          "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: TELEGRAM_CHAT_ID,
              text,
              disable_web_page_preview: true
            }),
            signal: controller.signal
          }
        );
      } finally {
        clearTimeout(timeout);
      }

      const responseText = await response.text();

      let responseJson = null;
      try {
        responseJson = JSON.parse(responseText);
      } catch {}

      if (!response.ok) {
        throw new Error(
          "Telegram API " + response.status + ": " + responseText.slice(0, 1000)
        );
      }

      if (!responseJson || responseJson.ok !== true) {
        throw new Error(
          "Telegram API returned an unsuccessful response: " + responseText.slice(0, 1000)
        );
      }

      log(
        "Telegram " + eventLabel +
        " message sent successfully (HTTP " + response.status +
        ", attempt " + attempt + "/" + TELEGRAM_RETRIES + ")."
      );
      return true;
    } catch (error) {
      lastError = error;
      const detail = error && error.name === "AbortError"
        ? "request timed out after " + NOTIFICATION_TIMEOUT_MS + " ms"
        : error.message;

      log(
        "Telegram " + eventLabel +
        " attempt " + attempt + "/" + TELEGRAM_RETRIES +
        " failed: " + detail
      );

      if (attempt < TELEGRAM_RETRIES) {
        await new Promise(resolve =>
          setTimeout(resolve, TELEGRAM_RETRY_DELAY_MS * attempt)
        );
      }
    }
  }

  const finalDetail = lastError && lastError.name === "AbortError"
    ? "request timed out after " + NOTIFICATION_TIMEOUT_MS + " ms"
    : (lastError && lastError.message) || "unknown Telegram error";

  log("Could not send Telegram " + eventLabel + " message after " + TELEGRAM_RETRIES + " attempts: " + finalDetail);

  if (queueOnFailure) {
    queueTelegramNotification(text, eventLabel);
  }

  return false;
}

function readTelegramQueue() {
  if (!fs.existsSync(TELEGRAM_QUEUE_PATH)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(TELEGRAM_QUEUE_PATH, "utf8");
    if (!raw || !String(raw).trim()) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    log(
      "Telegram notification queue is corrupt or unreadable (" +
        error.message +
        "); resetting queue file."
    );
    try {
      fs.unlinkSync(TELEGRAM_QUEUE_PATH);
    } catch {}
    return [];
  }
}

async function flushPendingTelegramNotifications() {
  if (!telegramAlertsEnabled || !fs.existsSync(TELEGRAM_QUEUE_PATH)) {
    return;
  }

  const queue = readTelegramQueue();
  if (!queue.length) {
    return;
  }

  log("Retrying " + queue.length + " queued Telegram notification(s).");

  const remaining = [];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    const sent = await sendTelegramMessage(item.text, item.event_label + " (queued)", false);
    if (!sent) {
      // Preserve the failed item and every notification after it.
      remaining.push(...queue.slice(index));
      break;
    }
  }

  try {
    if (remaining.length > 0) {
      fs.writeFileSync(TELEGRAM_QUEUE_PATH, JSON.stringify(remaining, null, 2) + "\n");
      log(remaining.length + " Telegram notification(s) remain queued.");
    } else {
      fs.unlinkSync(TELEGRAM_QUEUE_PATH);
      log("Telegram notification queue cleared.");
    }
  } catch (error) {
    log("Could not update Telegram notification queue: " + error.message);
  }
}

async function sendTelegramSuccess(cycle, confirmation) {
  const initial = confirmation.operation === "initial_upload";
  const heading = initial ? "Naukri Automation — INITIAL RESUME UPLOAD VERIFIED" : "Naukri Automation — DELETE AND RE-UPLOAD VERIFIED";
  const action = initial ? "Action: Profile was confirmed empty; configured resume uploaded." : "Action: Existing resume deleted and verified; configured resume uploaded again.";
  const message =
    "🟢 " + heading + "\n\n" +
    "Run: #" + cycle + "\n" +
    "Resume: " + confirmation.filename + "\n" +
    action + "\n" +
    "Verification: " + confirmation.method + "\n" +
    "Next cycle: in " + INTERVAL_MINUTES + " minutes\n" +
    "Time: " + new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  await sendTelegramMessage(message, initial ? "initial_upload_success" : "replacement_success");
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
      if (page.isClosed()) {
        throw new Error("Naukri profile page is closed.");
      }

      if (attempt > 1) {
        log("Profile navigation retry " + attempt + "/" + NAVIGATION_RETRIES);
        await page.waitForTimeout(RETRY_DELAY_MS);
      }

      // Do not wait for DOMContentLoaded: Naukri's analytics/third-party
      // resources can hold that event open even after the profile response
      // has committed. Wait for navigation commit, then for the real resume
      // upload control that proves the profile application is usable.
      await page.goto(PROFILE_URL, {
        waitUntil: "commit",
        timeout: 30000
      });

      await page.locator('input#attachCV[type="file"][aria-label="Upload resume"]')
        .waitFor({ state: "attached", timeout: 45000 });

      await page.waitForFunction(() => {
        const input = document.querySelector('input#attachCV[type="file"][aria-label="Upload resume"]');
        return Boolean(input && input.isConnected && !input.disabled);
      }, undefined, { timeout: 15000 });

      await page.waitForTimeout(1500);
      await dismissPopups(page);

      const currentUrl = page.url();
      if (/login|signin|sign-in/i.test(currentUrl)) {
        throw new Error("Naukri redirected to login; the saved session may have expired.");
      }

      log("Naukri profile is ready; the dedicated resume upload input is attached and enabled.");
      return;
    } catch (error) {
      lastError = error;
      log(
        "Profile navigation attempt " + attempt + "/" + NAVIGATION_RETRIES +
        " failed: " + error.message
      );

      // Reuse the page on retry. A failed DOMContentLoaded wait must not be
      // treated as proof that the profile itself failed to load.
    }
  }

  throw new Error(
    "Could not open a usable Naukri profile after " +
    NAVIGATION_RETRIES +
    " attempts. Last error: " +
    (lastError ? lastError.message : "unknown navigation error")
  );
}

async function maximizeChromiumWindow(context, page) {
  if (!context || contextIsClosed(context) || !page || page.isClosed()) return false;

  // Background mode must not issue CDP maximize commands: they can restore
  // a window that the Windows launcher has deliberately hidden.
  if (String(process.env.HIDE_BROWSER_WINDOW || "false").toLowerCase() === "true") {
    log("Background mode enabled; leaving Chromium window state to the launcher hider.");
    return true;
  }

  let session;
  try {
    session = await context.newCDPSession(page);
    const target = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId: target.windowId,
      bounds: { windowState: "maximized" }
    });
    log("Chromium desktop window maximized successfully.");
    return true;
  } catch (error) {
    log("Could not maximize Chromium through the desktop window API: " + error.message);
    return false;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

async function createFreshPage(context) {
  if (contextIsClosed(context)) {
    throw new Error("Naukri browser context is closed.");
  }

  const existingPages = context.pages();

  // Reuse only a healthy existing page; close stale/extra pages so a failed
  // navigation cannot accumulate hidden tabs over many cycles.
  let healthyPage = null;

  for (const candidate of existingPages) {
    if (candidate.isClosed()) continue;

    if (!healthyPage) {
      healthyPage = candidate;
    } else {
      await candidate.close().catch(() => {});
    }
  }

  if (healthyPage) {
    await maximizeChromiumWindow(context, healthyPage);
    return healthyPage;
  }

  const page = await context.newPage();
  await maximizeChromiumWindow(context, page);
  return page;
}

const MAX_RESUME_BYTES = readPositiveNumberEnv("MAX_RESUME_BYTES", 2 * 1024 * 1024, 1024, true);

function getResumeFileInfo() {
  if (!RESUME_PATH || !fs.existsSync(RESUME_PATH)) {
    throw new Error("RESUME_PATH does not exist: " + RESUME_PATH);
  }
  const stat = fs.statSync(RESUME_PATH);
  if (!stat.isFile()) throw new Error("RESUME_PATH is not a file: " + RESUME_PATH);
  if (stat.size > MAX_RESUME_BYTES) {
    throw new Error(
      "Resume file exceeds Naukri's 2 MB limit shown on the profile. " +
      "File: " + path.basename(RESUME_PATH) +
      "; current size: " + (stat.size / (1024 * 1024)).toFixed(2) + " MB. " +
      "Compress the DOCX or point RESUME_PATH to a file no larger than 2 MB."
    );
  }
  return {
    name: path.basename(RESUME_PATH),
    size: stat.size,
    size_mb: Number((stat.size / (1024 * 1024)).toFixed(2))
  };
}

async function setResumeFile(uploadTarget) {
  const info = getResumeFileInfo();
  if (!uploadTarget) throw new Error("Naukri's identified resume upload input was not available.");

  // Naukri's current UI identifies the resume input as #attachCV. Its visible
  // dummy button overlays the input, so clicking the button is intercepted.
  // setInputFiles on this exact input avoids pointer interaction and does not
  // touch the separate profile-photo input.
  if (uploadTarget.kind === "file-input") {
    await uploadTarget.locator.setInputFiles(RESUME_PATH);
  } else if (uploadTarget.kind === "file-chooser") {
    await uploadTarget.chooser.setFiles(RESUME_PATH);
  } else {
    throw new Error("Unsupported Naukri resume upload target.");
  }

  log("Resume file supplied to Naukri's identified resume control: " +
      info.name + " (" + info.size_mb + " MB).");
  return info;
}

async function clickNaukriResumeUploadControl(page) {
  const selectors = [
    'input#attachCV[type="file"][aria-label="Upload resume"]',
    'input[type="file"][aria-label="Upload resume"]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      if (!(await locator.isEnabled().catch(() => false))) {
        throw new Error("Naukri's identified resume input is disabled: " + selector);
      }
      log("Identified Naukri resume input using selector: " + selector);
      return { kind: "file-input", locator };
    }
  }

  // Strict fallback: use only the explicit resume-upload text and a real
  // file chooser. Do not click generic buttons or arbitrary file inputs.
  const control = page.getByText(/^Upload resume$/i).first();
  if (await control.isVisible({ timeout: 1200 }).catch(() => false)) {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 }).catch(() => null);
    await control.click({ timeout: 5000 }).catch(error => {
      log("Visible Upload resume text click did not open chooser: " + error.message);
    });
    const chooser = await chooserPromise;
    if (chooser) return { kind: "file-chooser", chooser };
  }

  throw new Error(
    "Naukri's specific resume input (#attachCV with aria-label Upload resume) " +
    "and its associated file chooser were not found. No unrelated file input was used."
  );
}

async function waitForResumeUploadConfirmation(page, fileInfo, previousBodyText = "", replacementConfirmed = false) {
  const patterns = [
    /resume uploaded successfully/i,
    /resume has been uploaded/i,
    /resume updated successfully/i,
    /successfully uploaded.*resume/i,
    /resume upload successful/i,
    /file uploaded successfully/i
  ];
  const deadline = Date.now() + 60000;
  let bodyText = "";
  const filenameWasAlreadyVisible = String(previousBodyText).toLowerCase().includes(fileInfo.name.toLowerCase());

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("Naukri page closed before upload confirmation.");

    // Naukri sometimes dismisses its replacement prompt by re-rendering the
    // profile SPA. During that transition body.innerText can temporarily be
    // empty. Treat that as a loading state, not as a failed upload.
    bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const match = patterns.find(pattern => pattern.test(bodyText));
    if (match) {
      return { confirmed: true, method: "Naukri success message", filename: fileInfo.name };
    }

    const lowerBody = bodyText.toLowerCase();
    const hasFilename = lowerBody.includes(fileInfo.name.toLowerCase());
    const hasUploadedDate = /uploaded on/i.test(bodyText);

    if (!filenameWasAlreadyVisible && hasFilename && hasUploadedDate) {
      return { confirmed: true, method: "Newly displayed uploaded resume entry", filename: fileInfo.name };
    }

    if (replacementConfirmed && hasFilename && hasUploadedDate) {
      return {
        confirmed: true,
        method: "Replacement accepted and uploaded resume entry re-rendered",
        filename: fileInfo.name
      };
    }

    await page.waitForTimeout(1000);
  }

  // Recovery path: after a successful "Yes, upload new" click, Naukri may
  // leave the SPA body blank even though the upload has completed. Re-open
  // the profile and verify the server-persisted resume before declaring failure
  // or starting another upload attempt. This avoids repeatedly selecting the
  // same file and creating duplicate replacement prompts.
  if (replacementConfirmed || !filenameWasAlreadyVisible) {
    log("Upload confirmation UI did not settle; reopening the profile once to verify the persisted resume.");
    await page.goto(PROFILE_URL, { waitUntil: "commit", timeout: 30000 });
    await page.locator('input#attachCV[type="file"][aria-label="Upload resume"]')
      .waitFor({ state: "attached", timeout: 45000 });

    const persisted = await page.waitForFunction(filename => {
        const visible = element => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" &&
            Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        };
        const filenameNodes = Array.from(document.querySelectorAll("body *")).filter(element =>
          element.children.length === 0 &&
          (element.textContent || "").trim() === filename && visible(element)
        );
        return filenameNodes.some(filenameNode => {
          let section = filenameNode;
          for (let depth = 0; depth < 10 && section; depth++, section = section.parentElement) {
            const text = (section.innerText || "").replace(/\s+/g, " ").trim();
            if (/uploaded on\s*[:：]?\s*\w{3,9}\s+\d{1,2},?\s+\d{4}/i.test(text) ||
                /uploaded on\s*[:：]?\s*\d{1,2}[-/ ]\w{3,9}[-/ ]\d{2,4}/i.test(text)) return true;
          }
          return false;
        });
      }, fileInfo.name, { timeout: 45000 }).then(() => true).catch(() => false);

    if (persisted) {
      return {
        confirmed: true,
        method: "Profile reopened after upload; configured resume is persisted on Naukri",
        filename: fileInfo.name
      };
    }

    bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  }

  throw new Error(
    "The configured file was selected, but Naukri did not show a verifiable upload confirmation or persisted resume entry. " +
    "No success notification will be sent. Sensitive profile text was intentionally omitted from this error."
  );
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

async function deleteExistingResume(page, fileInfo, recheckedAfterReload = false, deletionRetryCount = 0) {
  // Naukri normally stores one active resume, but its filename may differ from
  // the local configured filename. Find a visible resume document by extension
  // and click only the Delete/Remove control adjacent to that exact entry.
  // Never click a generic Delete button elsewhere on the profile.
  const existingEntry = await page.locator("body *").evaluateAll(elements => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    };

    const filenamePattern = /^[^\r\n]{1,240}\.(pdf|doc|docx|rtf|odt)$/i;
    const leaves = elements.filter(element =>
      element.children.length === 0 &&
      isVisible(element) &&
      filenamePattern.test((element.textContent || "").trim())
    );

    for (const filenameElement of leaves) {
      const filename = (filenameElement.textContent || "").trim();
      let container = filenameElement;

      for (let depth = 0; depth < 10 && container; depth++, container = container.parentElement) {
        const candidates = Array.from(container.querySelectorAll('a,button,[role="button"]'));
        const match = candidates.find(element => {
          if (!isVisible(element)) return false;
          const label = [
            element.innerText,
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-tooltip")
          ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();

          return /(^|\b)(delete|remove)(\b|$)/i.test(label) ||
            /deleteonetheme/i.test(label);
        });

        if (match) {
          const all = Array.from(document.querySelectorAll('a,button,[role="button"]'));
          return {
            filename,
            deleteIndex: all.indexOf(match)
          };
        }
      }
    }

    return null;
  }).catch(() => null);

  if (!existingEntry) {
    if (!recheckedAfterReload) {
      log("No visible resume entry was detected on the first profile render. Reloading once and checking again before allowing any upload.");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(async error => {
        log("Profile reload before resume deletion check did not reach DOMContentLoaded: " + error.message);
      });
      await page.locator('input#attachCV[type="file"][aria-label="Upload resume"]')
        .waitFor({ state: "attached", timeout: 45000 });
      await page.waitForTimeout(4000);
      return await deleteExistingResume(page, fileInfo, true);
    }

    log(
      "No existing resume filename was detected after a fresh profile reload. " +
      "The Naukri profile is already empty; proceeding with the configured resume upload."
    );
    return "already_empty";
  }

  if (existingEntry.deleteIndex < 0) {
    throw new Error(
      "An existing resume (" + existingEntry.filename +
      ") is visible, but its own Delete/Remove control could not be identified safely. " +
      "No unrelated Delete button was clicked and the new resume was not uploaded."
    );
  }

  const deleteControl = page.locator('a,button,[role="button"]').nth(existingEntry.deleteIndex);
  const deleteLabel = await deleteControl.evaluate(element => ({
    tag: element.tagName,
    text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
    ariaLabel: element.getAttribute("aria-label"),
    title: element.getAttribute("title")
  })).catch(() => ({}));

  log("Deleting the existing Naukri resume entry (" + existingEntry.filename +
      ") using its adjacent control: " + JSON.stringify(deleteLabel));

  const dialogHandler = async dialog => {
    await dialog.accept().catch(() => {});
  };
  page.once("dialog", dialogHandler);

  try {
    await deleteControl.click({ timeout: 8000 });

    // Naukri's confirmation popup is not consistently exposed with
    // role="dialog". Require the exact resume-deletion question, then click
    // only a visible control whose complete label is "Delete".
    const confirmationPrompt = page.getByText(
      /are you sure you want to delete the resume/i
    ).first();
    const promptVisible = await confirmationPrompt.isVisible({ timeout: 5000 }).catch(() => false);

    if (promptVisible) {
      const confirmCandidates = page.locator('button, [role="button"], a');
      let confirmed = false;

      for (let index = 0; index < await confirmCandidates.count(); index++) {
        const candidate = confirmCandidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;

        const label = await candidate.evaluate(element =>
          (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim()
        ).catch(() => "");

        if (/^delete$/i.test(label)) {
          await candidate.click({ timeout: 5000 });
          confirmed = true;
          log("Confirmed Naukri's resume deletion using the visible modal Delete button.");
          break;
        }
      }

      if (!confirmed) {
        throw new Error(
          "Naukri displayed the resume deletion confirmation prompt, but its visible Delete button could not be identified safely."
        );
      }
    } else {
      // Some Naukri UI versions may delete immediately without a confirmation
      // popup. The filename disappearance check below verifies that outcome.
      log("No resume deletion confirmation popup appeared; verifying whether deletion completed immediately.");
    }

    // Always verify deletion against a freshly loaded server-backed profile.
    // A disappearing DOM node alone is not sufficient evidence: Naukri may
    // optimistically remove it before the server has persisted the change.
    log("Reloading Naukri profile to verify that the previous resume was deleted on the server.");
    await page.goto(PROFILE_URL, { waitUntil: "commit", timeout: 30000 });
    await page.locator('input#attachCV[type="file"][aria-label="Upload resume"]')
      .waitFor({ state: "attached", timeout: 45000 });
    await page.waitForTimeout(4000);

    const deletionVerified = await page.waitForFunction(() => {
      const visible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0 &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const filenamePattern = /^[^\r\n]{1,240}\.(pdf|doc|docx|rtf|odt)$/i;
      const remaining = Array.from(document.querySelectorAll("body *")).filter(element =>
        element.children.length === 0 &&
        visible(element) &&
        filenamePattern.test((element.textContent || "").trim())
      );
      const body = (document.body && document.body.innerText || "").toLowerCase();
      return body.includes("resume") && remaining.length === 0;
    }, undefined, { timeout: 20000 }).then(() => true).catch(() => false);

    if (!deletionVerified) {
      const remainingNames = await page.locator("body *").evaluateAll(elements => {
        const visible = element => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || 1) > 0 &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const filenamePattern = /^[^\r\n]{1,240}\.(pdf|doc|docx|rtf|odt)$/i;
        return elements.filter(element =>
          element.children.length === 0 &&
          visible(element) &&
          filenamePattern.test((element.textContent || "").trim())
        ).map(element => (element.textContent || "").trim()).slice(0, 10);
      }).catch(() => []);

      if (deletionRetryCount < 2 && remainingNames.length > 0) {
        log(
          "The old resume is still present after the server reload. " +
          "Retrying the real Delete action (" + (deletionRetryCount + 2) + "/3) for: " +
          remainingNames.join(", ")
        );
        await page.waitForTimeout(1800);
        page.removeListener("dialog", dialogHandler);
        return await deleteExistingResume(page, fileInfo, true, deletionRetryCount + 1);
      }

      throw new Error(
        "Resume deletion was not verified after " + (deletionRetryCount + 1) +
        " delete attempt(s) and a fresh Naukri profile reload. " +
        "Visible resume entries still found: " +
        (remainingNames.length ? remainingNames.join(", ") : "profile resume section did not reach a verifiable empty state") +
        ". Upload was stopped to prevent a false-positive refresh."
      );
    }
  } finally {
    page.removeListener("dialog", dialogHandler);
  }

  log("Existing Naukri resume entry (" + existingEntry.filename + ") was deleted successfully.");
  await page.waitForTimeout(1500);
  return "deleted";
}

async function logResumeReplacementDiagnostics(page) {
  try {
    const diagnostics = await page.evaluate(() => {
      const describe = element => {
        if (!element) return null;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          id: element.id || null,
          className: typeof element.className === "string" ? element.className.slice(0, 240) : null,
          text: element.tagName === "BODY" ? "[redacted]" : (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240),
          style: {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            position: style.position,
            zIndex: style.zIndex
          },
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      };

      const links = Array.from(document.querySelectorAll("a")).filter(link =>
        (link.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase() === "yes, upload new"
      ).map(link => {
        const ancestors = [];
        let current = link;
        for (let depth = 0; depth < 6 && current; depth++, current = current.parentElement) {
          ancestors.push(describe(current));
        }
        return {
          link: describe(link),
          outerHTML: link.outerHTML.slice(0, 1200),
          ancestors
        };
      });

      const input = document.querySelector('input#attachCV[type="file"][aria-label="Upload resume"]');
      const resumeInput = input ? {
        id: input.id,
        type: input.type,
        ariaLabel: input.getAttribute("aria-label"),
        accept: input.getAttribute("accept"),
        disabled: input.disabled,
        fileCount: input.files ? input.files.length : 0,
        parentChain: (() => {
          const result = [];
          let current = input;
          for (let depth = 0; depth < 4 && current; depth++, current = current.parentElement) {
            result.push(describe(current));
          }
          return result;
        })()
      } : null;

      return {
        capturedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        replacementLinks: links,
        resumeInput
      };
    });

    log("Resume replacement diagnostics: " + JSON.stringify(diagnostics));
    if (DEBUG_PROFILE_UI) {
      const screenshotPath = path.join(logDir, "resume-replacement-diagnostics-" + Date.now() + ".png");
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      log("Resume replacement diagnostic screenshot saved: " + screenshotPath);
    }
  } catch (error) {
    log("Could not capture resume replacement diagnostics: " + error.message);
  }
}

async function confirmResumeReplacement(page) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("Naukri page closed while checking replacement dialog.");
    const dialogs = page.locator(".lightbox:visible .res360editconfirmationBox.profileSummaryConfirmation");
    for (let i = 0; i < await dialogs.count(); i++) {
      const dialog = dialogs.nth(i);
      const action = dialog.locator("a").filter({ hasText: /^Yes, upload new$/i }).first();
      if (!await action.count()) continue;
      const hierarchyVisible = await dialog.evaluate(el => {
        let node = el;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          const st = getComputedStyle(node), rect = node.getBoundingClientRect();
          if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity || 1) <= 0 || rect.width <= 0 || rect.height <= 0) return false;
        }
        return true;
      });
      if (hierarchyVisible && await action.isVisible().catch(() => false)) {
        await action.click({ timeout: 5000 });
        log("Clicked exact Yes, upload new action inside the genuinely visible resume dialog.");
        return true;
      }
    }
    await page.waitForTimeout(500);
  }
  log("No genuinely visible resume replacement dialog appeared; no hidden action was clicked.");
  await logResumeReplacementDiagnostics(page);
  return false;
}
async function uploadResume(page, context) {
  const fileInfo = getResumeFileInfo();
  let lastError = null;

  // Run the configured resume upload on every five-minute cycle.
  // Delete the currently visible resume entry first, regardless of its
  // filename. If deletion cannot be verified, stop before selecting the file.
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      if (!page || page.isClosed()) {
        if (!context || contextIsClosed(context)) {
          throw new Error("Cannot upload resume because the browser context is closed.");
        }
        page = await createFreshPage(context);
        await openProfile(page);
      }

      if (attempt > 1) {
        log("Resume upload retry " + attempt + "/" + UPLOAD_RETRIES);
        await page.waitForTimeout(RETRY_DELAY_MS);
        if (page.isClosed()) page = await createFreshPage(context);
        await openProfile(page);
      }

      // Delete the current resume entry (whatever its filename) before
      // uploading the configured file. deleteExistingResume throws if an
      // existing entry remains after a server-side profile reload.
      const resumeState = await deleteExistingResume(page, fileInfo);
      if (resumeState !== "already_empty" && resumeState !== "deleted") throw new Error("Resume state is ambiguous; upload blocked.");
      const operation = resumeState === "already_empty" ? "initial_upload" : "replacement";
      log(operation === "initial_upload" ? "Empty profile verified; starting initial resume upload." : "Old resume deletion verified; starting replacement upload.");

      const previousBodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      log("Starting Naukri resume upload after checking for the existing configured resume.");
      const uploadTarget = await clickNaukriResumeUploadControl(page);
      await setResumeFile(uploadTarget);

      const replacementConfirmed = await confirmResumeReplacement(page);
      const confirmation = await waitForResumeUploadConfirmation(
        page,
        fileInfo,
        previousBodyText,
        replacementConfirmed
      );

      // Reload the profile and verify the uploaded resume is persisted on the
      // server, not merely present in the current page's transient UI.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(async error => {
        log("Profile reload after upload did not reach DOMContentLoaded; waiting for resume entry instead: " + error.message);
      });
      await page.locator('input#attachCV[type="file"][aria-label="Upload resume"]')
        .waitFor({ state: "attached", timeout: 45000 });

      const persisted = await page.waitForFunction(filename => {
        const visible = element => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || 1) > 0 &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const filenameVisible = Array.from(document.querySelectorAll("body *")).some(element =>
          element.children.length === 0 &&
          (element.textContent || "").trim() === filename &&
          visible(element)
        );
        const body = (document.body && document.body.innerText || "").toLowerCase();
        return filenameVisible && body.includes("uploaded on");
      }, fileInfo.name, { timeout: 45000 }).then(() => true).catch(() => false);

      if (!persisted) {
        throw new Error("Naukri did not show the configured resume as a persisted profile entry after reloading the profile.");
      }

      const verified = {
        confirmed: true,
        filename: fileInfo.name,
        method: "Uploaded configured resume and verified the profile entry remained after reload"
      };
      verified.operation = operation;
      log("Naukri resume upload CONFIRMED: " + verified.filename + " (verification: " + verified.method + ").");
      return verified;
    } catch (error) {
      lastError = error;
      log("Resume upload attempt " + attempt + "/" + UPLOAD_RETRIES + " failed: " + error.message);
      if (page && page.isClosed() && context && !contextIsClosed(context)) {
        page = await createFreshPage(context).catch(() => page);
      }
    }
  }

  if (DEBUG_PROFILE_UI && page && !page.isClosed()) {
    await page.screenshot({
      path: path.join(logDir, "resume-upload-failure-" + Date.now() + ".png"),
      fullPage: true
    }).catch(() => {});
    const labels = await page.locator("button, a, input").evaluateAll(elements =>
      elements.map(el => ({
        tag: el.tagName,
        text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim(),
        type: el.getAttribute("type") || "",
        accept: el.getAttribute("accept") || ""
      })).filter(item => item.text || item.type === "file").slice(0, 80)
    ).catch(() => []);
    if (labels.length) log("Resume upload UI snapshot: " + JSON.stringify(labels));
  }

  throw new Error("Naukri resume upload was NOT verified after " + UPLOAD_RETRIES +
    " attempts. " + (lastError ? lastError.message : "Unknown upload error"));
}

async function launchBrowserContext() {
  // Bound browser startup so a hung Chromium spawn cannot leave health stuck
  // at STARTING forever. The launcher can then clean the managed profile and retry.
  // Root-cause hardening (Oct 2026):
  // - Explicit executablePath so Playwright and the launched binary stay aligned.
  // - Safer Chromium args that avoid first-run, default-browser, and recent
  //   DevTools-debugging restrictions that can leave the process alive while
  //   launchPersistentContext never returns.
  // - Chromium starts outside the visible desktop so headed mode does not flash a window.
  // - The Windows launcher then hides its top-level HWND while Playwright controls it.
  // - Clear distinction between true profile locks and generic launch timeouts.
  const launchTimeoutMs = readPositiveNumberEnv("BROWSER_LAUNCH_TIMEOUT_MS", 90000, 5000, true);
  let executablePath = null;
  try {
    executablePath = chromium.executablePath();
  } catch (e) {
    log("Startup: could not resolve chromium.executablePath(): " + (e && e.message || e));
  }

  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DevToolsDebuggingRestrictions",
    // Keep the browser headed for Naukri compatibility, but create its window
    // outside the visible desktop from the first frame. The launcher also
    // applies SW_HIDE as a second layer; no maximize/restore command is used.
    "--window-size=1365,900",
    "--window-position=-32000,-32000"
  ];

  log(
    "Startup: launching Chromium (headless=" +
      HEADLESS +
      ", timeout=" +
      launchTimeoutMs +
      "ms, executablePath=" +
      (executablePath || "default") +
      ")."
  );
  writeHealth("STARTING", 0, {
    phase: "launching_browser",
    launch_timeout_ms: launchTimeoutMs,
    executable_path: executablePath || "default"
  });

  try {
    const options = {
      headless: HEADLESS,
      timeout: launchTimeoutMs,
      // Use the browser window's configured dimensions while keeping it off-screen.
      viewport: null,
      // Keep the real headed Chromium engine for Naukri compatibility. Its
      // native window is created off-screen and hidden by run-background.ps1.
      // File uploads are handled by Playwright's file input API.
      args: launchArgs
    };
    if (executablePath) {
      options.executablePath = executablePath;
    }

    return await chromium.launchPersistentContext(profileDir, options);
  } catch (error) {
    const message = String(error && error.message || error);

    log("Startup: Chromium launch failed: " + message);

    // True profile-lock phrases only. Generic timeouts often mention the
    // user-data-dir path in Playwright's call log and must not be misclassified.
    const isProfileLock =
      /existing browser session|profile is already in use|process singleton|user data directory is already in use|another browser process is using the profile|SingletonLock/i.test(
        message
      ) && !/Timeout\s+\d+ms\s+exceeded/i.test(message);

    if (isProfileLock) {
      throw new Error(
        "The saved Naukri Chromium profile is currently locked by another process. " +
          "The background launcher will clean and retry automatically; no manual action is required."
      );
    }

    if (/Timeout\s+\d+ms\s+exceeded/i.test(message)) {
      throw new Error(
        "Chromium process started but Playwright could not complete launchPersistentContext " +
          "within " +
          launchTimeoutMs +
          "ms (CDP/handshake hang or slow profile load). " +
          "This is not classified as a profile lock. " +
          "Check antivirus interference, profile size/corruption, and that the scheduled-task " +
          "user session is interactive. Original: " +
          message
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
  if (String(process.env.TELEGRAM_TEST_ONLY || "false").toLowerCase() === "true") {
    const testMessage =
      "🧪 Naukri Automation — TELEGRAM TEST\\n\\n" +
      "This message was sent through the same Telegram notification function used by the background automation.\\n" +
      "Time: " + new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const sent = await sendTelegramMessage(testMessage, "test", false);
    process.exit(sent ? 0 : 1);
  }

  if (!fs.existsSync(profileDir)) {
    throw new Error("No saved Naukri session. Run: npm run login");
  }

  let context;
  let instanceLock = null;

  try {
    instanceLock = acquireInstanceLock(INSTANCE_LOCK_PATH, { scriptPath: path.resolve(__filename) });
    writeHealth("STARTING", 0, { phase: "launching_browser" });
    log("Startup: launching persistent Chromium with the saved Naukri profile.");
    context = await launchBrowserContext();
    log("Startup: persistent Chromium launched successfully in headed off-screen background mode.");
    writeHealth("RUNNING", 0, { phase: "browser_ready", browser_visible: false, browser_offscreen: true, next_cycle: 1 });

    let cycle = 0;
    let failures = 0;

    const stop = async () => {
      log("Stopping...");
      writeHealth("STOPPING", 0, { phase: "shutdown" });
      if (context) await context.close().catch(() => {});
      writeHealth("STOPPED", 0, { phase: "shutdown" });
      releaseInstanceLock(INSTANCE_LOCK_PATH, instanceLock);
      process.exit(0);
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    while (true) {
      cycle++;
      writeHealth("RUNNING", cycle, { phase: "starting_cycle" });
      await flushPendingTelegramNotifications();

      try {
        // The long-running Chromium session can occasionally disappear after
        // many cycles. Never keep using a closed BrowserContext: recover it
        // before creating the next page so one transient browser crash does not
        // turn into repeated "Target page, context or browser has been closed"
        // failures for every subsequent cycle.
        if (contextIsClosed(context)) {
          context = await recoverBrowserContext(context);
        }

        let page = await createFreshPage(context);

        log("Cycle " + cycle + ": opening profile");
        await openProfile(page);

        // Only use the explicit Naukri resume-upload entry point.
        // A generic file input or file selection is not proof of a saved upload.
        log("Cycle " + cycle + ": starting verified resume upload");
        const uploadConfirmation = await uploadResume(page, context);

        failures = 0;

        // Keep the persistent Chromium context alive between cycles.
        // Re-launching the same persistent profile every five minutes caused
        // intermittent launchPersistentContext/CDP timeouts after a clean
        // context.close(). Reuse the authenticated context and page instead.
        writeHealth("SUCCESS", cycle, {
          phase: "resume_uploaded",
          last_success_at: new Date().toISOString(),
          next_cycle: cycle + 1,
          next_cycle_after_minutes: INTERVAL_MINUTES,
          browser_closed: false,
          browser_reused_between_cycles: true
        });
        log("Cycle " + cycle + ": resume upload verified; keeping the authenticated Chromium context open and hidden for the next cycle. Sending Telegram confirmation.");
        await sendTelegramSuccess(cycle, uploadConfirmation);
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
              "Browser recovery failed; automation will restart so the launcher can clean the Chromium profile."
            );

            // Do not continue with a null/locked BrowserContext. Exit so
            // run-background.ps1 can clean the complete managed Chromium
            // process tree, remove stale Singleton* locks, and restart cleanly.
            throw new Error(
              "Browser recovery failed; restarting automation for clean Chromium profile recovery: " +
              recoveryError.message
            );
          }
        } else {
          failures++;
          log(
            "Cycle " + cycle + " failed: " + errorMessage +
            (error && error.stack ? " | Stack: " + String(error.stack).split("\n").slice(0, 7).join(" <- ") : "")
          );

          // Navigation/network failures are recoverable. Dispose of the
          // affected page and recreate the browser context before the next
          // retry cycle so a poisoned page/context cannot persist.
          const navigationFailure =
            /Could not open Naukri profile after|page.goto: Timeout|ERR_|Navigation timeout/i.test(errorMessage);

          let recoveredAfterNavigationFailure = false;
          let recoveryErrorMessage = "";

          if (navigationFailure) {
            try {
              if (context && !contextIsClosed(context)) {
                await context.close().catch(() => {});
              }
              context = null;
              writeHealth("RECOVERING", cycle, {
                phase: "browser_recovery",
                error: errorMessage
              });
              log("Cycle " + cycle + ": navigation failure; recreating Chromium session.");
              context = await launchBrowserContext();
              failures = 0;
              recoveredAfterNavigationFailure = true;
              log("Cycle " + cycle + ": Chromium session recreated successfully.");
              writeHealth("RECOVERED", cycle, {
                phase: "waiting",
                recovery_at: new Date().toISOString(),
                next_cycle: cycle + 1
              });
              await sendTelegramRecovery(cycle);
            } catch (recoveryError) {
              recoveryErrorMessage = recoveryError.message;
              log("Cycle " + cycle + ": Chromium session recreation failed: " + recoveryErrorMessage);
            }
          }

          if (!recoveredAfterNavigationFailure) {
            writeHealth("FAILED", cycle, {
              phase: "error",
              error: recoveryErrorMessage
                ? errorMessage + " | Recovery failed: " + recoveryErrorMessage
                : errorMessage,
              recovery_attempted: navigationFailure,
              next_action: recoveryErrorMessage
                ? "Automation will restart so the launcher can clean the Chromium profile"
                : "Fresh browser context will be used on the next cycle"
            });

            await sendFailureAlert(
              "Naukri Refresh - cycle " + cycle + " failed",
              recoveryErrorMessage
                ? errorMessage + "\nBrowser recovery failed: " + recoveryErrorMessage
                : errorMessage
            );
            await sendTelegramFailure(
              cycle,
              recoveryErrorMessage
                ? errorMessage + " | Browser recovery failed: " + recoveryErrorMessage
                : errorMessage
            );

            if (recoveryErrorMessage) {
              // A locked profile is an infrastructure/process-state failure.
              // Exit so the launcher can clean the managed Chromium tree and
              // restart refresh.js with a clean profile lock state.
              throw new Error(
                "Browser session recreation failed; restarting automation for clean Chromium profile recovery: " +
                recoveryErrorMessage
              );
            }
          }
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
          // A failed browser launch can leave context null. Guard cleanup so the
          // original Chromium error is preserved instead of being masked by a
          // secondary "Cannot read properties of null (reading close)" error.
          if (context && !contextIsClosed(context)) {
            await context.close().catch(() => {});
          }
          releaseInstanceLock(INSTANCE_LOCK_PATH, instanceLock);
          process.exit(1);
        }
      }

      // Keep a healthy authenticated Chromium context alive during the wait.
      // If Chromium crashed, contextIsClosed() on the next cycle triggers the
      // guarded recovery path before any Naukri page interaction.
      const waitAfterCompletionMs = INTERVAL_MINUTES * 60 * 1000;
      writeHealth("WAITING", cycle, {
        phase: "waiting",
        next_cycle: cycle + 1,
        next_cycle_after_minutes: INTERVAL_MINUTES
      });
      log("Cycle " + cycle + ": completed. Next profile/resume verification starts in " +
        INTERVAL_MINUTES + " minutes.");
      await new Promise(resolve => setTimeout(resolve, waitAfterCompletionMs));
    }
  } catch (error) {
    if (error && error.code === "EINSTANCELOCK") {
      log("Duplicate invocation refused; existing refresh.js process remains the sole owner (PID " + error.ownerPid + ").");
      return;
    }
    writeHealth("STARTUP_FAILED", 0, { phase: "startup", error: error.message });
    log("Startup failed: " + error.message);
    await sendFailureAlert(
      "Naukri Refresh - startup failure",
      error.message
    );
    await sendTelegramFailure(0, error.message, "Startup failed");
    releaseInstanceLock(INSTANCE_LOCK_PATH, instanceLock);
    process.exit(1);
  } finally {
    releaseInstanceLock(INSTANCE_LOCK_PATH, instanceLock);
  }
})();