import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Node dotenv preserves literal values and external environment overrides", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-launch-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "private.env");
  const value = "$(printf unexpected) /tmp/'quoted' ; printf unsafe";
  await writeFile(envFile, `CODEX_REMOTE_CONTACT_TEST_PATH="${value}"\nCODEX_REMOTE_CONTACT_ENGINE=from-file\n`);
  const output = execFileSync(process.execPath, ["--env-file=" + envFile, "-e",
    "process.stdout.write(JSON.stringify([process.env.CODEX_REMOTE_CONTACT_TEST_PATH, process.env.CODEX_REMOTE_CONTACT_ENGINE]))"], {
    encoding: "utf8", env: { ...process.env, CODEX_REMOTE_CONTACT_ENGINE: "from-environment" }
  });
  assert.deepEqual(JSON.parse(output), [value, "from-environment"]);
});

test("missing private env is an error rather than an empty successful startup", () => {
  const result = spawnSync(process.execPath, ["--env-file=" + join(tmpdir(), "nonexistent-qq-gateway-test.env"), "-e", "process.stdout.write('started')"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});
