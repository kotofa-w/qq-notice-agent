import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubscriptionStore } from "../src/storage/subscription-store.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "notice-roles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-10-17T10:00:00Z");
  const store = new SubscriptionStore({ filePath: join(directory, "subscriptions.json"), clock: () => new Date(now) });
  await store.init();
  const subscribe = async (extra = {}) => (await store.upsertSubscription({ targetId: "12345", sourceGroupId: "54321", intakeMode: "RESPONSIBLE_ONLY", collectionDelayMinutes: 0.1, ...extra })).subscription;
  return { store, subscribe, advance: (ms) => { now = new Date(+now + ms); } };
}
const message = (id, timestamp = "2026-10-17T10:00:00Z", senderId = "99887") => ({ groupId: "54321", messageId: id, senderId, senderName: "张同学", senderRole: "member", text: `通知 ${id}`, timestamp });
const decision = (id, extra = {}) => ({ sourceGroupId: "54321", sourceMessageId: id, classification: "notice", quote: `通知 ${id}`, reason: "明确安排", publicationRole: "publisher", ...extra });

test("responsible collection includes ordinary members but roles stay group scoped and revocations stale claims", async (t) => {
  const { store, subscribe, advance } = await fixture(t);
  const sub = await subscribe();
  await subscribe({ sourceGroupId: "54322", targetId: "12346" });
  const role = await store.setNoticeRole({ sourceGroupId: "54321", senderId: "99887", status: "confirmed", displayName: "张同学" });
  assert.equal(role.status, "confirmed");
  assert.deepEqual(store.noticeRolesForSource("54322").members, []);
  await store.appendSourceMessage(message("1"));
  await store.appendSourceMessage(message("2", undefined, "99888"));
  advance(7000);
  const [context] = await store.claimForTarget("group", "12345");
  assert.equal(sub.intakeMode, "RESPONSIBLE_ONLY");
  assert.deepEqual(context.messages.map((item) => item.messageId), ["1", "2"]);
  assert.deepEqual(context.responsibleSenderIds, ["99887"]);
  assert.equal(store.isNoticeContextCurrent(context), true);
  await store.setNoticeRole({ sourceGroupId: "54321", senderId: "99887", status: "revoked" });
  assert.equal(store.isNoticeContextCurrent(context), false);
  assert.equal(store.isNoticeContextCurrent({ intakeMode: "ALL" }), true);
  const reloaded = new SubscriptionStore({ filePath: store.filePath, clock: store.clock });
  await reloaded.init();
  assert.equal(reloaded.noticeRolesForSource("54321").members[0].status, "revoked");
  await assert.rejects(store.setNoticeRole({ sourceGroupId: "54323", senderId: "99887", status: "confirmed" }), /source|来源/i);
  await assert.rejects(store.setNoticeRole({ sourceGroupId: "54321", senderId: "bad", status: "confirmed" }), /id/i);
});

test("notice evidence is deduplicated across targets, uncertain retained, recall removes evidence and rejection persists", async (t) => {
  const { store, subscribe, advance } = await fixture(t);
  await subscribe();
  await subscribe({ targetId: "12346" });
  for (const [id, timestamp] of [["1", "2026-10-16T15:59:00Z"], ["2", "2026-10-16T16:00:00Z"], ["3", "2026-10-16T17:00:00Z"], ["4", "2026-10-17T10:00:00Z"]]) await store.appendSourceMessage(message(id, timestamp));
  advance(7000);
  const first = await store.claimForTarget("group", "12345");
  const second = await store.claimForTarget("group", "12346");
  const decisions = [decision("1"), decision("2"), decision("3", { publicationRole: "forwarder" }), decision("4", { classification: "uncertain" })];
  await store.recordNoticeDecisions(first, decisions);
  await store.recordNoticeDecisions(second, decisions);
  let roles = store.noticeRolesForSource("54321");
  assert.equal(roles.candidates.length, 1);
  assert.equal(roles.candidates[0].evidence.length, 3);
  assert.equal(roles.pendingReviews.length, 1);
  assert.deepEqual(first[0].responsibleSenderIds, [], "candidate cannot grant notification eligibility");
  await store.recallSourceMessage("54321", "1");
  assert.equal(store.noticeRolesForSource("54321").candidates.length, 0);
  await store.setNoticeRole({ sourceGroupId: "54321", senderId: "99887", status: "rejected" });
  await store.recordNoticeDecisions(first, decisions);
  roles = store.noticeRolesForSource("54321");
  assert.equal(roles.candidates.length, 0);
  assert.equal(roles.members[0].status, "rejected");
  assert.equal(roles.pendingReviews.length, 1);
  await store.recallSourceMessage("54321", "4");
  assert.equal(store.noticeRolesForSource("54321").pendingReviews.length, 0);
  advance(31 * 86400000);
  assert.equal(store.noticeRolesForSource("54321").candidates.length, 0);
  assert.equal(store.noticeRolesForSource("54321").members[0].status, "rejected");
});

test("unknown new modes reject, unknown persisted modes are explicitly disabled, and save failures recover", async (t) => {
  const { store, subscribe } = await fixture(t);
  await assert.rejects(subscribe({ intakeMode: "TYPO" }), /intake|mode/i);
  const sub = await subscribe();
  const obstruction = `${store.filePath}.tmp-${process.pid}`;
  await mkdir(obstruction);
  await assert.rejects(store.setNoticeRole({ sourceGroupId: "54321", senderId: "99887", status: "confirmed" }));
  await rm(obstruction, { recursive: true });
  await store.setNoticeRole({ sourceGroupId: "54321", senderId: "99887", status: "confirmed" });
  const state = JSON.parse(await readFile(store.filePath, "utf8"));
  state.subscriptions[sub.id].intakeMode = "UNKNOWN_PERSISTED";
  await writeFile(store.filePath, JSON.stringify(state));
  const reloaded = new SubscriptionStore({ filePath: store.filePath });
  await reloaded.init();
  const migrated = reloaded.listSubscriptions()[0];
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.intakeMode, "RESPONSIBLE_ONLY");
  assert.match(migrated.migrationWarning, /UNKNOWN_PERSISTED/);
});

test("media-only uncertainty remains reviewable and marking viewed survives repeated model decisions", async (t) => {
  const { store, subscribe, advance } = await fixture(t);
  await subscribe();
  await store.appendSourceMessage({ ...message("media"), text: "", images: [{ file: "notice.png" }] });
  advance(7000);
  const contexts = await store.claimForTarget("group", "12345");
  const decisions = [decision("media", { classification: "uncertain", quote: "", reason: "图片内容无法可靠确认" })];
  await store.recordNoticeDecisions(contexts, decisions);
  assert.equal(store.noticeRolesForSource("54321").pendingReviews.length, 1);
  const reviewed = await store.resolveNoticeReview({ sourceGroupId: "54321", sourceMessageId: "media" });
  assert.ok(reviewed.reviewedAt);
  await store.recordNoticeDecisions(contexts, decisions);
  assert.equal(store.noticeRolesForSource("54321").pendingReviews.length, 0);
  assert.deepEqual(store.noticeRolesForSource("54321").members, []);
});

test("notice evidence and review records share a bounded window and expire without erasing manual roles", async (t) => {
  const { store, subscribe, advance } = await fixture(t);
  await subscribe();
  await store.setNoticeRole({ sourceGroupId: "54321", senderId: "99888", status: "confirmed" });
  for (let id = 0; id < 260; id++) await store.appendSourceMessage(message(String(id), id % 2 ? "2026-10-17T09:00:00Z" : "2026-10-16T09:00:00Z"));
  advance(7000);
  const contexts = await store.claimForTarget("group", "12345");
  await store.recordNoticeDecisions(contexts, contexts[0].messages.map((item) => decision(item.messageId, { classification: Number(item.messageId) % 5 ? "notice" : "uncertain" })));
  let roles = store.noticeRolesForSource("54321");
  assert.equal(roles.candidates[0].evidence.length + roles.pendingReviews.length, 256);
  advance(31 * 86400000);
  roles = store.noticeRolesForSource("54321");
  assert.equal(roles.pendingReviews.length, 0);
  assert.equal(roles.candidates.length, 0);
  assert.equal(roles.members[0].status, "confirmed");
});

test("redirecting a subscription invalidates the frozen decision for its previous target", async (t) => {
  const { store, subscribe, advance } = await fixture(t);
  await subscribe();
  await store.appendSourceMessage(message("before-redirect"));
  advance(7000);
  const [context] = await store.claimForTarget("group", "12345");
  assert.equal(store.isNoticeContextCurrent(context), true);
  await store.completeClaims([context]);
  const current = store.listSubscriptions()[0];
  await store.upsertSubscription({ ...current, targetId: "22222" });
  assert.equal(store.isNoticeContextCurrent(context), false);
});

test("optional validated classifications on legacy collection modes collect evidence without granting roles", async (t) => {
  const { store, subscribe, advance } = await fixture(t);
  await subscribe({ intakeMode: "ALL" });
  await store.appendSourceMessage(message("legacy"));
  advance(7000);
  const contexts = await store.claimForTarget("group", "12345");
  await store.recordNoticeDecisions(contexts, [decision("legacy")]);
  assert.deepEqual(store.noticeRolesForSource("54321").candidates, []);
  assert.deepEqual(store.noticeRolesForSource("54321").members, []);
  assert.equal(store.noticeRolesForSource("54321").revision, 0);
  assert.ok(store.noticeRolesForSource("54321").observationStartedAt);
});
