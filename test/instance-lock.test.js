"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireInstanceLock, releaseInstanceLock } = require("../instance-lock");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "naukri-lock-test-"));
  return { dir, lockPath: path.join(dir, "naukri-refresh.lock"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("creates an exclusive lock and releases only its own token", () => {
  const f = fixture();
  try {
    const owner = acquireInstanceLock(f.lockPath, { scriptPath: "/tmp/refresh.js", inspectProcess: () => false });
    assert.equal(JSON.parse(fs.readFileSync(f.lockPath, "utf8")).pid, process.pid);
    assert.equal(releaseInstanceLock(f.lockPath, { ...owner, token: "not-the-owner" }), false);
    assert.equal(fs.existsSync(f.lockPath), true);
    assert.equal(releaseInstanceLock(f.lockPath, owner), true);
    assert.equal(fs.existsSync(f.lockPath), false);
  } finally { f.cleanup(); }
});

test("refuses a verified live refresh owner without changing its lock", () => {
  const f = fixture();
  try {
    const existing = { pid: 4242, token: "live-owner", script_path: "/tmp/refresh.js" };
    fs.writeFileSync(f.lockPath, JSON.stringify(existing));
    assert.throws(
      () => acquireInstanceLock(f.lockPath, { scriptPath: "/tmp/refresh.js", inspectProcess: () => true }),
      error => error.code === "EINSTANCELOCK" && error.ownerPid === 4242
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(f.lockPath, "utf8")), existing);
  } finally { f.cleanup(); }
});

test("refuses to steal a lock when process identity cannot be verified", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.lockPath, JSON.stringify({ pid: 4242, token: "owner", script_path: "/tmp/refresh.js" }));
    assert.throws(
      () => acquireInstanceLock(f.lockPath, { scriptPath: "/tmp/refresh.js", inspectProcess: () => null }),
      error => error.code === "ELOCKUNVERIFIED"
    );
    assert.equal(fs.existsSync(f.lockPath), true);
  } finally { f.cleanup(); }
});

test("recovers a stale lock whose PID is not running", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.lockPath, JSON.stringify({ pid: 4242, token: "stale", script_path: "/tmp/refresh.js" }));
    const owner = acquireInstanceLock(f.lockPath, { scriptPath: "/tmp/refresh.js", inspectProcess: () => false });
    assert.equal(JSON.parse(fs.readFileSync(f.lockPath, "utf8")).token, owner.token);
    assert.equal(releaseInstanceLock(f.lockPath, owner), true);
  } finally { f.cleanup(); }
});
