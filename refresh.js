const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const PROFILE_URL = process.env.PROFILE_URL || "https://www.naukri.com/mnjuser/profile";
const RESUME_PATH = path.resolve(process.env.RESUME_PATH || "");
const INTERVAL_MINUTES = Math.max(1, Number(process.env.REFRESH_INTERVAL_MINUTES || 20));
const MAX_FAILURES = Math.max(1, Number(process.env.MAX_CONSECUTIVE_FAILURES || 3));
const HEADLESS = String(process.env.HEADLESS || "false").toLowerCase() === "true";
const DEBUG_PROFILE_UI = String(process.env.DEBUG_PROFILE_UI || "true").toLowerCase() === "true";
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
  await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await dismissPopups(page);
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

      // Naukri's current Resume > Update control opens a native file chooser.
      // Handle that chooser through Playwright so Windows does not show the
      // file-picker window. Playwright recommends waiting for the filechooser
      // event before clicking the upload control.
      const fileChooserPromise = page
        .waitForEvent("filechooser", { timeout: 3000 })
        .catch(() => null);

      await control.click({ timeout: 5000 }).catch(() => {});

      const fileChooser = await fileChooserPromise;

      if (fileChooser) {
        if (!RESUME_PATH || !fs.existsSync(RESUME_PATH)) {
          throw new Error("RESUME_PATH does not exist: " + RESUME_PATH);
        }

        await fileChooser.setFiles(RESUME_PATH);
        await page.waitForTimeout(2000);
        log("Native file chooser handled automatically; resume file supplied.");
        return { attempted: true, resumeUploaded: true };
      }

      await page.waitForTimeout(1000);
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

  await openProfile(page);

  let input = page.locator('input[type="file"]').first();

  if (await input.count()) {
    await input.setInputFiles(RESUME_PATH);
    return;
  }

  const candidates = [
    page.getByText(/Update resume/i).first(),
    page.getByText(/Upload resume/i).first(),
    page.getByRole("button", { name: /resume/i }).first()
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) {
      await candidate.click().catch(() => {});
      await page.waitForTimeout(1000);
      input = page.locator('input[type="file"]').first();

      if (await input.count()) {
        await input.setInputFiles(RESUME_PATH);
        return;
      }
    }
  }

  throw new Error("Could not find Naukri resume upload control/input. The Naukri UI may have changed.");
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
          await page.waitForTimeout(2000);
          log("Cycle " + cycle + ": resume upload action completed");
        }

        failures = 0;
      } catch (error) {
        failures++;
        log("Cycle " + cycle + " failed: " + error.message);

        if (failures >= MAX_FAILURES) {
          log("Stopping after " + failures + " consecutive failures.");
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
    process.exit(1);
  }
})();