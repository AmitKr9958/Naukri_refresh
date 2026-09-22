const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const PROFILE_URL=process.env.PROFILE_URL||"https://www.naukri.com/mnjuser/profile";
const RESUME_PATH=path.resolve(process.env.RESUME_PATH||"");
const INTERVAL_MINUTES=Math.max(1,Number(process.env.REFRESH_INTERVAL_MINUTES||10));
const MAX_FAILURES=Math.max(1,Number(process.env.MAX_CONSECUTIVE_FAILURES||3));
const HEADLESS=String(process.env.HEADLESS||"false").toLowerCase()==="true";
const profileDir=path.resolve("naukri-browser-profile");
const logDir=path.resolve("logs"); fs.mkdirSync(logDir,{recursive:true});
function log(m){const line="["+new Date().toISOString()+"] "+m; console.log(line); fs.appendFileSync(path.join(logDir,"naukri-refresh.log"),line+"\n");}
async function dismissPopups(page){for(const t of ["Not Now","Skip","Close","Maybe Later"]){try{const x=page.getByText(t,{exact:true}).first();if(await x.isVisible({timeout:700}).catch(()=>false))await x.click({timeout:1500}).catch(()=>{});}catch{}}}
async function uploadResume(page){
 if(!RESUME_PATH||!fs.existsSync(RESUME_PATH))throw new Error("RESUME_PATH does not exist: "+RESUME_PATH);
 await page.goto(PROFILE_URL,{waitUntil:"domcontentloaded",timeout:60000}); await page.waitForTimeout(2500); await dismissPopups(page);
 let input=page.locator('input[type="file"]').first();
 if(await input.count()){await input.setInputFiles(RESUME_PATH);return;}
 const candidates=[page.getByText(/Update resume/i).first(),page.getByText(/Upload resume/i).first(),page.getByRole("button",{name:/resume/i}).first()];
 for(const c of candidates){if(await c.isVisible({timeout:1000}).catch(()=>false)){await c.click().catch(()=>{});await page.waitForTimeout(1000);input=page.locator('input[type="file"]').first();if(await input.count()){await input.setInputFiles(RESUME_PATH);return;}}}
 throw new Error("Could not find Naukri resume upload control/input. The Naukri UI may have changed.");
}
(async()=>{
 if(!fs.existsSync(profileDir))throw new Error("No saved Naukri session. Run: npm run login");
 const context=await chromium.launchPersistentContext(profileDir,{headless:HEADLESS,viewport:{width:1440,height:900},args:["--disable-blink-features=AutomationControlled"]});
 let cycle=0,failures=0;
 process.on("SIGINT",async()=>{log("Stopping...");await context.close();process.exit(0);});
 while(true){cycle++;try{const page=context.pages()[0]||await context.newPage();log("Cycle "+cycle+": uploading resume");await uploadResume(page);await page.waitForTimeout(2000);log("Cycle "+cycle+": resume upload action completed");failures=0;}catch(e){failures++;log("Cycle "+cycle+" failed: "+e.message);if(failures>=MAX_FAILURES){log("Stopping after "+failures+" consecutive failures.");await context.close();process.exit(1);}}await new Promise(r=>setTimeout(r,INTERVAL_MINUTES*60*1000));}
})();
