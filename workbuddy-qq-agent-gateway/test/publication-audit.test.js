import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const audit = fileURLToPath(new URL("../scripts/audit-public.mjs", import.meta.url));

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "qq-publication-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: root.replaceAll("\\", "/") };
  for (const args of [["init", "-q"], ["add", "--all"]]) {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return () => spawnSync(process.execPath, [audit], { cwd: root, env, encoding: "utf8" });
}

test("publication audit permits reviewed outer deployment source without exporting runtime state", async (t) => {
  const run = await fixture(t, {
    "README.md": "# Project\n",
    "workbuddy-qq-agent-gateway/src/example.js": "export const ready = true;\n",
    "runtime/runtime-control.ps1": "param([string]$Action)\n",
    "runtime/caldav-fruux/verify-project.mjs": "export const synthetic = true;\n"
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test("publication audit rejects nested private data, machine credentials and local status without leaking values", async (t) => {
  const secret = "ghp_" + "a".repeat(36);
  const run = await fixture(t, {
    "workbuddy-qq-agent-gateway/runtime/private/account.json": "{}\n",
    "workbuddy-qq-agent-gateway/Data/queue.json": "{}\n",
    "runtime/caldav-fruux/private/credential.clixml": "<credential />\n",
    "Runtime/Private/credential.CLIXML": "<credential />\n",
    "checkpoint_status.md": "local machine status\n",
    "src/credential.js": `export const token = ${JSON.stringify(secret)};\n`
  });
  const result = run();
  assert.notEqual(result.status, 0);
  for (const name of ["account.json", "queue.json", "credential.clixml", "credential.CLIXML", "checkpoint_status.md"]) assert.ok(result.stderr.includes(name), name);
  assert.ok(!result.stderr.includes(secret));
});
