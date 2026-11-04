"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function inspectProcess(pid, scriptPath) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    if (error && error.code !== "EPERM") return false;
  }

  if (process.platform === "win32") {
    const command = [
      "$p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:NAUKRI_LOCK_PID) -ErrorAction Stop;",
      "if ($p -and $p.CommandLine -and $p.CommandLine.IndexOf($env:NAUKRI_LOCK_SCRIPT, [StringComparison]::OrdinalIgnoreCase) -ge 0) { exit 0 }",
      "exit 1"
    ].join(" ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, NAUKRI_LOCK_PID: String(pid), NAUKRI_LOCK_SCRIPT: scriptPath }
    });
    if (result.error || result.status === null) {
      return null;
    }
    return result.status === 0;
  }

  try {
    const commandLine = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ");
    return commandLine.includes(scriptPath);
  } catch {
    return null;
  }
}

function acquireInstanceLock(lockPath, options = {}) {
  const absoluteLockPath = path.resolve(lockPath);
  const scriptPath = path.resolve(options.scriptPath || process.argv[1] || "");
  const checkProcess = options.inspectProcess || inspectProcess;
  const owner = {
    pid: process.pid,
    token: crypto.randomBytes(24).toString("hex"),
    script_path: scriptPath,
    cwd: process.cwd(),
    started_at: new Date().toISOString()
  };
  const payload = JSON.stringify(owner) + "\n";
  fs.mkdirSync(path.dirname(absoluteLockPath), { recursive: true });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(absoluteLockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, payload, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return owner;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }

    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(absoluteLockPath, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      existing = null;
    }

    const existingPid = Number(existing && existing.pid);
    if (Number.isInteger(existingPid) && existingPid > 0) {
      const identity = checkProcess(existingPid, path.resolve(existing.script_path || scriptPath));
      if (identity === true) {
        const duplicate = new Error("Another refresh.js instance is already running (PID " + existingPid + ").");
        duplicate.code = "EINSTANCELOCK";
        duplicate.ownerPid = existingPid;
        throw duplicate;
      }
      if (identity === null) {
        const uncertain = new Error("Cannot safely verify the owner of the existing refresh lock (PID " + existingPid + "); refusing to remove it.");
        uncertain.code = "ELOCKUNVERIFIED";
        throw uncertain;
      }
    }

    // Rename the stale/corrupt lock out of the way atomically. A competing
    // starter must still win the subsequent exclusive-create operation.
    const stalePath = absoluteLockPath + ".stale-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    try {
      fs.renameSync(absoluteLockPath, stalePath);
      try { fs.unlinkSync(stalePath); } catch {}
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "EEXIST" || error.code === "EPERM")) {
        continue;
      }
      throw error;
    }
  }

  const busy = new Error("Could not acquire the Naukri Refresh lock after concurrent/stale-lock recovery attempts.");
  busy.code = "ELOCKBUSY";
  throw busy;
}

function releaseInstanceLock(lockPath, owner) {
  if (!owner || !owner.token) return false;
  const absoluteLockPath = path.resolve(lockPath);
  try {
    const current = JSON.parse(fs.readFileSync(absoluteLockPath, "utf8"));
    if (current.pid !== owner.pid || current.token !== owner.token) return false;
    fs.unlinkSync(absoluteLockPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { acquireInstanceLock, releaseInstanceLock, inspectProcess };
