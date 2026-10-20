import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkBuddyClient } from "../src/workbuddy/client.js";

test("Windows bridge paths, isolated environment and UTF-8 stdio survive EOF", {
  skip: process.platform !== "win32", timeout: 7000
}, async () => {
  const client = new WorkBuddyClient({ env: {
    Path: process.env.Path || process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    PATHEXT: process.env.PATHEXT,
    CLIENT_INFO_IDE_TYPE: "must-not-leak",
    ELECTRON_RUN_AS_NODE: "1"
  } });
  assert.equal(client.bridgePath, fileURLToPath(new URL("../modules/workbuddy-agent/bridge.py", import.meta.url)));
  assert.equal(client.python, fileURLToPath(new URL("../modules/workbuddy-agent/.venv/Scripts/python.exe", import.meta.url)));
  assert.ok(existsSync(client.python), "Run modules/workbuddy-agent/setup.ps1 first");
  const env = client.childEnv();
  assert.equal(env.SYSTEMROOT, process.env.SystemRoot);
  assert.equal(env.USERPROFILE, process.env.USERPROFILE);
  assert.ok(env.PATH.split(path.delimiter).includes(path.dirname(process.execPath)));
  assert.equal(env.CLIENT_INFO_IDE_TYPE, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);

  const child = spawn(client.python, ["-X", "utf8", client.bridgePath], {
    env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const finished = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    child.stdin.on("error", () => {});
    child.stdin.end([
      { id: 1, method: "中文未知方法", params: {} },
      { id: 2, method: "thread/loaded/list", params: {} },
      { id: 3, method: "shutdown", params: {} }
    ].map((request) => JSON.stringify(request)).join("\n") + "\n");
    assert.equal(await finished, 0, stderr);
    const responses = new Map(stdout.trim().split("\n").map((line) => {
      const response = JSON.parse(line); return [response.id, response];
    }));
    assert.match(responses.get(1).error.message, /未知方法: 中文未知方法/);
    assert.deepEqual(responses.get(2).result, { data: [], nextCursor: null });
    assert.deepEqual(responses.get(3).result, { ok: true });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
