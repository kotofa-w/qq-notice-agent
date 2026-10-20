import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { SubscriptionStore } from "../src/storage/subscription-store.js";

const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const apiSource = source.slice(source.indexOf("async function handleApi("), source.indexOf("async function handleOneBotEvent("));
const parser = source.slice(source.indexOf("function parseJson("), source.indexOf("function sendJson("));
const validator = source.slice(source.indexOf("function validateQqId("), source.indexOf("function validateCodexConfig("));

test("authenticated role and review routes use the already-read JSON body and persist their result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "notice-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const subscriptionStore = new SubscriptionStore({ filePath: join(directory, "subscriptions.json") });
  await subscriptionStore.init();
  await subscriptionStore.upsertSubscription({ targetType: "group", targetId: "12345", sourceGroupId: "54321", intakeMode: "RESPONSIBLE_ONLY" });
  class HttpError extends Error { constructor(statusCode, message) { super(message); this.statusCode = statusCode; } }
  const handleApi = runInNewContext(`${apiSource}\n${parser}\n${validator}\nhandleApi`, {
    process, subscriptionStore, HttpError, recordEvent() {},
    readRawBody: async (req) => Buffer.from(JSON.stringify(req.body)),
    isAuthorized: (req) => req.headers.authorization === "Bearer synthetic-test-token",
    sendJson: (res, status, body) => Object.assign(res, { status, body })
  });
  const request = async (path, body, authorized = true) => {
    const response = {};
    await handleApi({ method: "POST", body, headers: { "content-type": "application/json", authorization: authorized ? "Bearer synthetic-test-token" : "" } }, response, { pathname: path });
    return response;
  };
  const role = { sourceGroupId: "54321", senderId: "99888", status: "confirmed", displayName: "课代表" };
  assert.equal((await request("/api/qq/notice-roles", role, false)).status, 401);
  assert.equal(subscriptionStore.noticeRolesForSource("54321").members.length, 0);
  assert.equal((await request("/api/qq/notice-roles", role)).status, 200);
  assert.equal(subscriptionStore.noticeRolesForSource("54321").members[0].displayName, "课代表");
  await subscriptionStore.recordNoticeDecisions([{ sourceGroupId: "54321", messages: [{ messageId: "m1", senderId: "99888", senderName: "课代表", text: "具体安排再确认", timestamp: new Date().toISOString() }] }], [{ sourceGroupId: "54321", sourceMessageId: "m1", classification: "uncertain", quote: "具体安排再确认", reason: "安排未明确", publicationRole: "unknown" }]);
  assert.equal((await request("/api/qq/notice-reviews/resolve", { sourceGroupId: "54321", sourceMessageId: "m1" })).status, 200);
  assert.equal(subscriptionStore.noticeRolesForSource("54321").pendingReviews.length, 0);
  await assert.rejects(request("/api/qq/notice-roles", { ...role, status: "OWNER" }), { statusCode: 400 });
  const restored = new SubscriptionStore({ filePath: join(directory, "subscriptions.json") });
  await restored.init();
  assert.equal(restored.noticeRolesForSource("54321").members[0].status, "confirmed");
  assert.equal(restored.noticeRolesForSource("54321").pendingReviews.length, 0);
});
