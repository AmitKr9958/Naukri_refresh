const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const profileDir = path.resolve("naukri-browser-profile");
const profileUrl = process.env.PROFILE_URL || "https://www.naukri.com/mnjuser/profile";
(async () => {
  fs.mkdirSync(profileDir, { recursive: true });

  let context = null;
  let finished = false;

  const closeContext = async (exitCode = 0) => {
    if (finished) return;
    finished = true;

    try {
      if (context) {
        await context.close();
      }
    } catch (error) {
      console.error("Could not close Naukri browser session: " + error.message);
      exitCode = 1;
    }

    process.exit(exitCode);
  };

  process.once("SIGINT", () => { void closeContext(130); });
  process.once("SIGTERM", () => { void closeContext(143); });

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1440, height: 900 },
      args: ["--start-maximized"]
    });

    const page = context.pages()[0] || await context.newPage();

    console.log("Opening Naukri. Complete login/OTP/CAPTCHA manually if prompted.");
    await page.goto(profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    console.log("When your profile/dashboard is visible, press Enter here.");
    process.stdin.resume();

    process.stdin.once("data", async () => {
      console.log("Closing browser and saving session...");
      await closeContext(0);
      console.log("Session saved in ./naukri-browser-profile");
    });
  } catch (error) {
    console.error("Naukri login session failed: " + error.message);
    await closeContext(1);
  }
})();
