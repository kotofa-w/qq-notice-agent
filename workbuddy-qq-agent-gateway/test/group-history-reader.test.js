import test from "node:test";
import assert from "node:assert/strict";
import { OneBotClient } from "../src/qq/onebot-client.js";

const payload = (overrides = {}) => ({
  message_id: "-321", message_seq: "short-hash", real_id: "another-hash",
  real_seq: "9007199254740993", group_id: "12345", self_id: "67890",
  user_id: "23456", sender: { user_id: "23456", nickname: "成员", role: "admin" },
  time: 1800000000, message: [{ type: "text", data: { text: "正文不进入警告" } }],
  ...overrides
});
const read = async (messages, options = {}) => {
  const { GroupHistoryReader } = await import("../src/qq/group-history-reader.js");
  return new GroupHistoryReader({ oneBot: { getGroupMessageHistory: async () => messages } })
    .readPage({ sourceGroupId: "12345", accountId: "67890", ...options });
};

test("history client preserves cursor and requests a bounded read-only page", async () => {
  const calls = [];
  const client = new OneBotClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ retcode: 0, data: { messages: [payload()] } }) };
  } });
  assert.equal((await client.getGroupMessageHistory("12345", { cursor: "-987", count: 30 })).length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { group_id: 12345, message_seq: "-987", count: 30, reverse_order: true, disable_get_url: true });
  assert.equal(calls[0].url, "http://127.0.0.1:3000/get_group_msg_history");
  assert.ok(calls[0].options.signal);
  await client.getGroupMessageHistory("12345");
  assert.equal("message_seq" in JSON.parse(calls[1].options.body), false);
});

test("history client rejects failed retcodes and malformed responses", async () => {
  for (const body of [{ retcode: 7, data: { messages: [] } }, { retcode: false, data: { messages: [] } }, { retcode: "", data: { messages: [] } }, { retcode: 0, data: {} }, {}, { retcode: 0, data: { messages: null } }]) {
    const client = new OneBotClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) });
    await assert.rejects(() => client.getGroupMessageHistory("12345"));
  }
});

test("history reader normalizes real fields and retains payload without trusting historical role", async () => {
  const raw = payload();
  const page = await read([raw]);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].payload, raw);
  assert.equal(page.entries[0].message.accountId, "67890");
  assert.equal(page.entries[0].message.realSeq, "9007199254740993");
  assert.equal(page.entries[0].message.senderRole, "admin");
  assert.equal(page.entries[0].message.historicalRoleUnverified, true);
  assert.equal(page.entries[0].message.timestamp, "2027-01-15T08:00:00.000Z");
  assert.equal(page.oldestAt, "2027-01-15T08:00:00.000Z");
  assert.equal(page.nextCursor, "-321");
  assert.deepEqual(page.warnings, []);
  assert.equal(page.empty, false);
});

test("history page uses bigint real_seq order rather than hash or message id", async () => {
  const page = await read([
    payload({ real_seq: "9007199254740994", message_id: "1", time: 1800000060 }),
    payload({ real_seq: "9007199254740993", message_id: "999", time: 1800000000 })
  ]);
  assert.deepEqual(page.entries.map(({ message }) => message.messageId), ["999", "1"]);
  assert.equal(page.nextCursor, "999");
});

test("invalid metadata cannot fabricate timestamps or coverage and warnings omit text", async () => {
  for (const override of [{ time: undefined }, { time: 0 }, { time: true }, { time: "bad" }, { time: Infinity },
    { group_id: "99999" }, { self_id: "99999" }, { user_id: "invalid" },
    { message_id: null }, { real_seq: "hash" }, { real_seq: 9007199254740992 },
    { user_id: "23456", sender: { user_id: "99999" } }]) {
    const page = await read([payload(), payload({ ...override, message_id: override.message_id === null ? null : "-111" })]);
    assert.equal(page.entries.length, 1, JSON.stringify(override));
    assert.equal(page.oldestAt, null);
    assert.ok(page.warnings.length);
    assert.equal(page.warnings.join(" ").includes("正文不进入警告"), false);
    assert.equal(page.empty, false);
  }
});

test("missing self id is scoped explicitly and reported without modifying raw payload", async () => {
  const raw = payload({ self_id: undefined });
  const page = await read([raw]);
  assert.equal(page.entries[0].message.accountId, "67890");
  assert.equal(raw.self_id, undefined);
  assert.match(page.warnings.join(" "), /self_id/);
  assert.equal(page.oldestAt, null);
});

test("cursor comes from the raw oldest row even when that row cannot be normalized", async () => {
  const page = await read([payload(), payload({ real_seq: "1", message_id: "-777", time: null })]);
  assert.equal(page.nextCursor, "-777");
  assert.equal(page.oldestAt, null);
  assert.equal(page.entries.length, 1);
  const unorderable = await read([payload(), payload({ real_seq: "short-hash" })]);
  assert.equal(unorderable.nextCursor, null);
  assert.equal(unorderable.oldestAt, null);
  const rejected = await read([payload({ time: undefined })]);
  assert.equal(rejected.empty, false);
  assert.equal(rejected.entries.length, 0);
});

test("empty remote page is distinct from a page of invalid rows and reader forwards query", async () => {
  const { GroupHistoryReader } = await import("../src/qq/group-history-reader.js");
  let args;
  const reader = new GroupHistoryReader({ oneBot: { getGroupMessageHistory: async (...value) => { args = value; return []; } } });
  assert.deepEqual(await reader.readPage({ sourceGroupId: "12345", accountId: "67890", cursor: "-10", count: 17 }), {
    entries: [], nextCursor: null, oldestAt: null, warnings: [], empty: true
  });
  assert.deepEqual(args, ["12345", { cursor: "-10", count: 17 }]);
  await assert.rejects(() => read([payload()], { accountId: "" }));
});
