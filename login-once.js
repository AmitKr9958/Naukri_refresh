const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const profileDir = path.resolve("naukri-browser-profile");
const profileUrl = process.env.PROFILE_URL || "https://www.naukri.com/mnjuser/profile";
(async () => {
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, { headless:false, viewport:{width:1440,height:900}, args:["--start-maximized"] });
  const page = context.pages()[0] || await context.newPage();
  console.log("Opening Naukri. Complete login/OTP/CAPTCHA manually if prompted.");
  await page.goto(profileUrl, {waitUntil:"domcontentloaded", timeout:60000});
  console.log("When your profile/dashboard is visible, press Enter here.");
  process.stdin.resume();
  process.stdin.once("data", async () => { await context.close(); console.log("Session saved in ./naukri-browser-profile"); });
})();
