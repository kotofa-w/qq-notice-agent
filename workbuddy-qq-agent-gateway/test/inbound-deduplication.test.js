import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { SessionStore } from "../src/storage/session-store.js";
import { InboundDeduplicator } from "../src/qq/inbound-deduplicator.js";
import { SubscriptionStore } from "../src/storage/subscription-store.js";
import { normalizeOneBotGroupMessage, normalizeOneBotPrivateMessage } from "../src/qq/message-normalizer.js";

const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const handlerSource = serverSource.slice(serverSource.indexOf("async function handleOneBotEvent("), serverSource.indexOf("async function hydrateMessage("));
const payload = { post_type: "message", message_type: "group", group_id: 54321, user_id: 99887, self_id: 100000002, message_id: 7, sender: { nickname: "member", role: "member" }, message: [{ type: "text", data: { text: "notice" } }] };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "inbound-dedupe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const subscriptionStore = new SubscriptionStore({ filePath: join(directory, "subscriptions.json") });
  await subscriptionStore.init();
  await subscriptionStore.upsertSubscription({ targetType: "group", targetId: "12345", sourceGroupId: "54321", mode: "AUTO", intakeMode: "ALL", collectionDelayMinutes: 2 });
  const inboundMessages = new InboundDeduplicator({ ttlMs: 600_000 });
  const context = vm.createContext({
    OWNER_QQ_ID: '100000001',
    subscriptionStore, normalizeOneBotGroupMessage, normalizeOneBotPrivateMessage,
    removingTargets: new Set(), allowedGroups: [],
    inboundMessages, Date, console,
    groupMemberDirectory: { record: async () => {} },
    hydrateMessage: async () => {}, mediaManager: { removeMessages: async () => {} },
    recordEvent: () => {}, checkSubscriptionSchedule: async () => {}, ...overrides
  });
  vm.runInContext(handlerSource, context);
  return context;
}

test("hydration failure permits same-ID redelivery and stores the source once", async (t) => {
  let hydration = 0;
  const context = await fixture(t, { hydrateMessage: async () => { if (++hydration === 1) throw new Error("hydration failed"); } });
  await assert.rejects(context.handleOneBotEvent(payload), /hydration failed/);
  const retry = await context.handleOneBotEvent(payload);
  assert.equal(retry.status, "accepted");
  const disk = JSON.parse(await readFile(context.subscriptionStore.filePath, "utf8"));
  assert.deepEqual(disk.sources["54321"].messages.map((item) => item.messageId), ["7"]);
});

test("concurrent same-ID deliveries share a failed attempt and allow one retry", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let hydration = 0;
  const context = await fixture(t, { hydrateMessage: async () => { if (++hydration === 1) { await blocked; throw new Error("first attempt failed"); } } });
  const first = context.handleOneBotEvent(payload);
  const second = context.handleOneBotEvent(payload);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((item) => item.status), ["rejected", "rejected"]);
  const accepted = await context.handleOneBotEvent(payload);
  assert.equal(accepted.status, "accepted");
  assert.equal(hydration, 2);
  assert.equal(context.subscriptionStore.snapshot().sources["54321"].messages.length, 1);
  assert.equal((await context.handleOneBotEvent(payload)).duplicate, true);
});

test("failure after durable source intake resumes cleanup and scheduling without receiving again", async (t) => {
  let hydration = 0;
  let cleanup = 0;
  let scheduled = 0;
  const context = await fixture(t, {
    hydrateMessage: async () => { hydration++; },
    mediaManager: { removeMessages: async () => { if (++cleanup === 1) throw new Error("cleanup failed"); } },
    checkSubscriptionSchedule: async () => { scheduled++; }
  });
  await assert.rejects(context.handleOneBotEvent(payload), /cleanup failed/);
  const retry = await context.handleOneBotEvent(payload);
  assert.equal(retry.status, "accepted");
  assert.equal(hydration, 1);
  assert.equal(scheduled, 1);
  assert.equal(context.subscriptionStore.snapshot().nextSequence, 2);
});

test("concurrent successful deliveries append once and keep the completion TTL", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let hydration = 0;
  let now = 0;
  const context = await fixture(t, {
    inboundMessages: new InboundDeduplicator({ ttlMs: 600_000, clock: () => now }),
    hydrateMessage: async () => { hydration++; await blocked; }
  });
  const first = context.handleOneBotEvent(payload);
  const second = context.handleOneBotEvent(payload);
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((item) => item.status === "accepted"));
  assert.equal(hydration, 1);
  assert.equal(context.subscriptionStore.snapshot().nextSequence, 2);
  now = 600_000;
  assert.equal((await context.handleOneBotEvent(payload)).duplicate, true);
  now = 600_001;
  await context.handleOneBotEvent(payload);
  assert.equal(hydration, 2, "completed TTL expiry permits a new receive attempt");
  assert.equal(context.subscriptionStore.snapshot().nextSequence, 2, "durable source identity still avoids a second append");
});

test("a scheduler failure after durable source intake can be retried without a second receipt", async (t) => {
  let scheduled = 0;
  let hydration = 0;
  const context = await fixture(t, {
    hydrateMessage: async () => { hydration++; },
    checkSubscriptionSchedule: async () => { if (++scheduled === 1) throw new Error("scheduler unavailable"); }
  });
  await assert.rejects(context.handleOneBotEvent(payload), /scheduler unavailable/);
  assert.equal((await context.handleOneBotEvent(payload)).status, "accepted");
  assert.equal(hydration, 1);
  assert.equal(scheduled, 2);
  assert.equal(context.subscriptionStore.snapshot().nextSequence, 2);
});

test("private redelivery after trigger failure resumes scheduling without appending twice", async (t) => {
  let hydration = 0;
  let scheduled = 0;
  const context = await fixture(t, {
    OWNER_QQ_ID: "100000001",
    targetAllowlist: { isRemoved: () => false }, privateMetadata: {},
    hydrateMessage: async () => { hydration++; },
    stickerManager: { collectFromMessage: async () => [] },
    dailyStyle: { capture: async () => {} }, parseOwnerControlCommand: () => null,
    privateTriggerManager: { request: async () => { if (++scheduled === 1) throw new Error("trigger failed"); } }
  });
  context.privateStore = new SessionStore({ filePath: join(context.subscriptionStore.filePath, "..", "private.json") });
  await context.privateStore.init({ allowedGroups: ["99887"] });
  const privatePayload = { ...payload, message_type: "private" };
  await assert.rejects(context.handleOneBotEvent(privatePayload), /trigger failed/);
  assert.equal((await context.handleOneBotEvent(privatePayload)).status, "accepted");
  assert.equal(hydration, 1);
  assert.equal(scheduled, 2);
  assert.equal(context.privateStore.snapshot("99887").pendingMessages.length, 1);
  const disk = JSON.parse(await readFile(context.privateStore.filePath, "utf8"));
  assert.equal(disk.groups["99887"].pendingMessages.length, 1);
});

for (const targetType of ["groups", "private"]) {
  test(`the ${targetType} UI retry route schedules failed subscription automation receipts`, async () => {
    const source = serverSource.slice(serverSource.indexOf("  const targetAction ="), serverSource.indexOf("  const deleteTarget ="));
    const requests = [];
    const context = vm.createContext({
      assertTarget: () => {},
      subscriptionStore: { retryFailedForTarget: async () => 0 },
      store: { retrySubscriptionAutomations: async () => 1 },
      privateStore: { retrySubscriptionAutomations: async () => 1 },
      triggerManager: { request: async (...args) => requests.push(args) },
      privateTriggerManager: { request: async (...args) => requests.push(args) },
      sendJson: (res, code, body) => Object.assign(res, { code, body }),
      appendUiOwnerMessage: async () => { throw new Error("unexpected ordinary message retry"); }
    });
    vm.runInContext(`async function retryRoute(req, url, res) { ${source} }`, context);
    const response = {};
    await context.retryRoute({ method: "POST" }, { pathname: `/api/qq/${targetType}/12345/retry` }, response);
    assert.equal(response.code, 202);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], "12345");
    assert.equal(requests[0][1], "subscription_auto");
    assert.equal(response.body.automationRetries, 1);
  });
}

test("private retry after a durable receipt was recalled does not schedule the recalled message", async (t) => {
  let scheduled = 0;
  const context = await fixture(t, {
    OWNER_QQ_ID: "100000001", targetAllowlist: { isRemoved: () => false }, privateMetadata: {},
    stickerManager: { collectFromMessage: async () => [] }, dailyStyle: { capture: async () => {} },
    parseOwnerControlCommand: () => null,
    privateTriggerManager: { request: async () => { scheduled++; throw new Error("trigger failed"); } }
  });
  context.privateStore = new SessionStore({ filePath: join(context.subscriptionStore.filePath, "..", "private.json") });
  await context.privateStore.init({ allowedGroups: ["99887"] });
  const privatePayload = { ...payload, message_type: "private" };
  await assert.rejects(context.handleOneBotEvent(privatePayload), /trigger failed/);
  await context.privateStore.recallMessage("99887", "7");
  assert.equal((await context.handleOneBotEvent(privatePayload)).status, "ignored");
  assert.equal(scheduled, 1);
});


test("redelivery after a failed session append preserves the durable followup wake", async (t) => {
  let followupWake;
  const context = await fixture(t, {
    allowedGroups: ["12345"], stickerManager: { collectFromMessage: async () => [] },
    dailyStyle: { capture: async () => {} }, parseOwnerControlCommand: () => null,
    qzone: { shouldWakeForOwnerRequest: () => false },
    triggerManager: { considerMessage: async (message) => { followupWake = message.followupWake; } }
  });
  context.store = new SessionStore({ filePath: join(context.subscriptionStore.filePath, "..", "group.json") });
  await context.store.init({ allowedGroups: ["12345"] });
  const group = context.store.ensureGroup("12345");
  group.busy = true;
  group.processing = { kind: "agent" };
  await context.store.armReplyFollowup("12345");
  const obstruction = `${context.store.filePath}.tmp-${process.pid}`;
  await mkdir(obstruction);
  const groupPayload = { ...payload, group_id: 12345 };
  await assert.rejects(context.handleOneBotEvent(groupPayload));
  await rm(obstruction, { recursive: true });
  assert.equal((await context.handleOneBotEvent(groupPayload)).status, "accepted");
  assert.equal(followupWake, true);
  assert.equal(context.store.snapshot("12345").pendingMessages.length, 1);
});
