import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarRemindersAvailable, normalizeCalendarRemindersEnabled, resolvePersonaFiles, validateRuntimeConfig } from "../src/security/runtime-config.js";
import * as runtimeConfig from "../src/security/runtime-config.js";
import { buildAutoSubscriptionPrompt, parseAutoSubscriptionResult } from "../src/security/subscription-policy.js";
const valid = { ownerId: "100000001", botId: "100000002", host: "127.0.0.1",
  authDisabled: false, apiToken: "synthetic-test-token", oneBotToken: "synthetic-onebot-token" };

const caldavEnv = {
  CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER: "caldav",
  CODEX_REMOTE_CONTACT_CALDAV_URL: "https://dav.example.test/calendars/test/calendar/",
  CODEX_REMOTE_CONTACT_CALDAV_USERNAME: "synthetic-device",
  CODEX_REMOTE_CONTACT_CALDAV_PASSWORD: "synthetic-password"
};

test("calendar provider defaults to disabled and rejects removed providers", () => {
  for (const platform of ["win32", "linux"]) {
    const config = runtimeConfig.resolveCalendarAutomationConfig({}, platform);
    assert.equal(config.provider, "none");
    assert.equal(config.available, false);
    assert.equal(runtimeConfig.resolveCalendarAutomationConfig({ CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER: "none" }, platform).available, false);
  }
  assert.throws(() => runtimeConfig.resolveCalendarAutomationConfig({ CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER: "typo" }), /CALENDAR_PROVIDER/);
  assert.throws(() => runtimeConfig.resolveCalendarAutomationConfig({ CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER: "macos" }), /CALENDAR_PROVIDER/);
});

test("configured CalDAV enables Windows capability without exposing connection credentials publicly", () => {
  const config = runtimeConfig.resolveCalendarAutomationConfig(caldavEnv, "win32");
  assert.equal(config.provider, "caldav");
  assert.equal(config.available, true);
  assert.equal(config.caldav.reminderMinutes, 30);
  assert.equal(config.caldav.calendarDisplayName, "fruux");
  const customConfig = runtimeConfig.resolveCalendarAutomationConfig({ ...caldavEnv,
    CODEX_REMOTE_CONTACT_CALDAV_CALENDAR_NAME: "学校日程", CODEX_REMOTE_CONTACT_CALDAV_REMINDER_MINUTES: "15" }, "win32");
  assert.equal(customConfig.caldav.calendarDisplayName, "学校日程");
  assert.equal(customConfig.caldav.reminderMinutes, 15);
  const publicConfig = runtimeConfig.publicCalendarAutomationConfig(config);
  assert.deepEqual(publicConfig, {
    calendarRemindersAvailable: true,
    calendarRemindersProvider: "caldav",
    calendarRemindersProviderLabel: "fruux（CalDAV）",
    calendarRemindersMinutes: 30
  });
  const serialized = JSON.stringify(publicConfig);
  for (const secret of [caldavEnv.CODEX_REMOTE_CONTACT_CALDAV_URL, caldavEnv.CODEX_REMOTE_CONTACT_CALDAV_USERNAME, caldavEnv.CODEX_REMOTE_CONTACT_CALDAV_PASSWORD]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("explicit CalDAV rejects incomplete or unsafe configuration instead of falling back", () => {
  const resolve = (env) => runtimeConfig.resolveCalendarAutomationConfig(env, "win32");
  for (const key of ["URL", "USERNAME", "PASSWORD"]) {
    assert.throws(() => resolve({ ...caldavEnv, [`CODEX_REMOTE_CONTACT_CALDAV_${key}`]: "" }), /CALDAV/);
  }
  for (const url of ["not a URL", "http://dav.example.test/calendar/", "https://user:secret@dav.example.test/calendar/", "https://dav.example.test/calendar/?token=secret", "https://dav.example.test/calendar/#secret"]) {
    assert.throws(() => resolve({ ...caldavEnv, CODEX_REMOTE_CONTACT_CALDAV_URL: url }), (error) => {
      assert.match(error.message, /CALDAV_URL/);
      assert.equal(error.message.includes(url), false);
      return true;
    });
  }
  for (const reminder of ["-1", "1.5", "NaN", "Infinity"]) {
    assert.throws(() => resolve({ ...caldavEnv, CODEX_REMOTE_CONTACT_CALDAV_REMINDER_MINUTES: reminder }), /REMINDER_MINUTES/);
  }
  assert.equal(resolve({ ...caldavEnv, CODEX_REMOTE_CONTACT_CALDAV_REMINDER_MINUTES: "0" }).caldav.reminderMinutes, 0);
});

test("automation factory selects CalDAV or no client without starting external actions", async () => {
  const { createAutomationClient } = await import("../src/automation/client.js");
  const resolve = runtimeConfig.resolveCalendarAutomationConfig;
  assert.equal(createAutomationClient(resolve({}, "win32")), null);
  assert.equal(createAutomationClient(resolve({ CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER: "none" })), null);
  assert.equal(createAutomationClient(resolve(caldavEnv, "win32")).constructor.name, "CaldavActionClient");
});
test("disabled automation capability overrides legacy settings and unsolicited model actions", () => {
  assert.equal(calendarRemindersAvailable, false);
  for (const value of [true, false, undefined]) {
    assert.equal(normalizeCalendarRemindersEnabled(value, false), false);
    assert.equal(normalizeCalendarRemindersEnabled(value, true), value !== false);
  }
  const contexts = [{ sourceGroupId: "100000003", messages: [{ messageId: "fixture-1", timestamp: "2026-10-16T02:00:00Z", text: "明天12时提交作业" }] }];
  const output = JSON.stringify({ noticeSummaries: [], actions: [{ type: "reminder", sourceGroupId: "100000003", sourceMessageId: "fixture-1", sourceItemQuote: "提交作业", title: "提交作业", due: "2026-10-17T12:00:00+08:00", timeEvidence: { due: "明天12时提交作业" } }] });
  for (const targetType of ["group", "private"]) {
    const options = { targetType, targetId: "100000001", allowAutomations: normalizeCalendarRemindersEnabled(true, false) };
    for (const sharedSystemInstructions of [true, false]) {
      assert.match(buildAutoSubscriptionPrompt(contexts, { ...options, sharedSystemInstructions }), /actions 必须为空数组/);
    }
    assert.deepEqual(parseAutoSubscriptionResult(output, contexts, options).actions, []);
    assert.equal(parseAutoSubscriptionResult(output, contexts, { ...options, allowAutomations: true }).actions.length, 1);
  }
});
test("public release requires distinct explicitly configured identities and credentials", () => {
  assert.doesNotThrow(() => validateRuntimeConfig(valid));
  for (const overrides of [{ ownerId: "" }, { botId: "" }, { ownerId: valid.botId },
    { apiToken: "" }, { oneBotToken: "" }, { ownerId: "not-a-number" }]) {
    assert.throws(() => validateRuntimeConfig({ ...valid, ...overrides }));
  }
});
test("unauthenticated mode cannot bind to a public or LAN address", () => {
  for (const host of ["0.0.0.0", "192.168.1.20", "::"]) {
    assert.throws(() => validateRuntimeConfig({ ...valid, authDisabled: true, host }));
  }
  assert.doesNotThrow(() => validateRuntimeConfig({ ...valid, authDisabled: true, apiToken: "" }));
});
test("unconfigured sender cannot acquire OWNER trust", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import {trustForSender} from "./src/security/policy.js"; console.log(trustForSender(""), trustForSender("100000001"))'],
    { env: { ...process.env, CODEX_REMOTE_CONTACT_OWNER_QQ_ID: "" }, encoding: "utf8" });
  assert.equal(output.trim(), "UNTRUSTED UNTRUSTED");
});

test("private personality overrides resolve relative to the project, not the shell directory", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "qq-persona-config-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (const directory of ["persona", "config/private/persona"]) {
    const root = join(project, directory);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "core.json"), JSON.stringify({ name: "Test Agent" }));
    await writeFile(join(root, "examples.json"), JSON.stringify({ examples: [] }));
  }
  assert.equal(resolvePersonaFiles(project).corePath, join(project, "persona/core.json"));
  const privateFiles = resolvePersonaFiles(project, "config/private/persona");
  assert.equal(privateFiles.corePath, join(project, "config/private/persona/core.json"));
  assert.deepEqual(resolvePersonaFiles(project, join(project, "config/private/persona")), privateFiles);
});

test("a broken private personality never silently falls back to public templates", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "qq-persona-invalid-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const root = join(project, "config/private/persona");
  await mkdir(root, { recursive: true });
  const load = () => resolvePersonaFiles(project, "config/private/persona");
  assert.throws(load, /missing or invalid/);
  await writeFile(join(root, "core.json"), JSON.stringify({ name: "Test Agent" }));
  await writeFile(join(root, "examples.json"), "invalid json");
  assert.throws(load, /missing or invalid/);
  await writeFile(join(root, "examples.json"), JSON.stringify({ examples: {} }));
  assert.throws(load, /missing or invalid/);
  await writeFile(join(root, "examples.json"), JSON.stringify({ examples: [] }));
  await writeFile(join(root, "core.json"), JSON.stringify({ name: "" }));
  assert.throws(load, /missing or invalid/);
});
