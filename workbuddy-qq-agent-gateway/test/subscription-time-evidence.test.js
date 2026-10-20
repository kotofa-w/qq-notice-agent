import test from "node:test";
import assert from "node:assert/strict";
import { parseAutoSubscriptionResult } from "../src/security/subscription-policy.js";

const message = (text, messageId = "m1") => ({ messageId, text, timestamp: "2026-10-16T02:00:00Z" });
const action = (overrides = {}) => ({ sourceGroupId: "g1", sourceMessageId: "m1", sourceItemQuote: "提交材料", type: "reminder", title: "提交材料", normalizedTitle: "提交材料", due: "2026-10-18T12:00:00+08:00", timeEvidence: { start: null, end: null, due: "10月18日12时前提交材料" }, ...overrides });
function parse(actions, messages = [message("10月18日12时前提交材料")]) {
  return parseAutoSubscriptionResult(JSON.stringify({ notify: true, reply: "", noticeSummaries: [{ sourceGroupId: "g1", summary: "请提交材料。" }], actions }), [{ sourceGroupId: "g1", sourceGroupName: "学校群", messages }], { targetType: "private", targetId: "owner" });
}

test("unsupported time evidence skips writes and preserves the fact summary with source identifiers", () => {
  for (const changes of [
    { sourceMessageId: "missing" }, { sourceMessageId: undefined }, { timeEvidence: undefined },
    { timeEvidence: { due: "原文没有这句话" } }, { due: "2026-10-19T12:00:00+08:00" },
    { due: "2026-10-18" }, { due: "2026-10-18T12:00:00" },
    { due: "2026-10-18T23:59:00+08:00", timeEvidence: { due: "10月18日" } }
  ]) {
    const result = parse([action(changes)]);
    assert.deepEqual(result.actions, [], JSON.stringify(changes));
    assert.match(result.reply, /请提交材料/);
    assert.match(result.reply, /时间未明确，请查看原消息/);
    assert.match(result.reply, /g1/);
    assert.match(result.reply, /m1|missing/);
  }
});

test("Chinese absolute and source-relative timestamps are checked against source text", () => {
  const cases = [
    ["10月18日12时前提交材料", "2026-10-18T12:00:00+08:00"],
    ["2026年10月18日下午两点开会", "2026-10-18T14:00:00+08:00"],
    ["明天上午9点半交材料", "2026-10-17T09:30:00+08:00"],
    ["后天14:30交材料", "2026-10-18T14:30:00+08:00"],
    ["今天18点交材料", "2026-10-16T18:00:00+08:00"],
    ["2026-10-18T12:00:00+08:00交材料", "2026-10-18T04:00:00Z"]
  ];
  for (const [text, due] of cases) assert.equal(parse([action({ due, sourceItemQuote: text, timeEvidence: { due: text } })], [message(text)]).actions.length, 1, text);
});

test("cross-date matching and invented end times cannot become calendar writes", () => {
  const text = "10月18日12时交材料；10月19日18时开会";
  assert.equal(parse([action({ due: "2026-10-18T18:00:00+08:00", timeEvidence: { due: text } })], [message(text)]).actions.length, 0);
  const calendar = action({ type: "calendar", calendarName: "学习", start: "2026-10-18T12:00:00+08:00", end: "2026-10-18T13:00:00+08:00", timeEvidence: { start: "10月18日12时前提交材料", end: null } });
  assert.equal(parse([calendar]).actions.length, 0);
});

test("date-only and ambiguous clocks require a source-confirmed all-day event", () => {
  const text = "10月18日全天培训";
  const calendar = action({ type: "calendar", calendarName: "学习", start: "2026-10-18", end: null, allDay: true, sourceItemQuote: text, timeEvidence: { start: text } });
  assert.equal(parse([calendar], [message(text)]).actions.length, 1);
  assert.equal(parse([action({ timeEvidence: { due: "10月18日" } })], [message("10月18日交材料")]).actions.length, 0);
  assert.equal(parse([action({ due: "2026-10-18T02:00:00+08:00", timeEvidence: { due: "10月18日两点" } })], [message("10月18日两点")]).actions.length, 0);
});

test("action identity survives title rewrites and separates messages and source time instances", () => {
  const original = parse([action()]).actions[0];
  assert.equal(parse([action({ title: "材料提交", normalizedTitle: "新标题" })]).actions[0].actionId, original.actionId);
  assert.notEqual(parse([action({ sourceMessageId: "m2" })], [message("10月18日12时前提交材料", "m2")]).actions[0].actionId, original.actionId);
  const text = "10月18日12时交材料；10月18日18时交照片";
  const result = parse([action({ sourceItemQuote: "交材料", timeEvidence: { due: "10月18日12时交材料" } }), action({ sourceItemQuote: "交照片", due: "2026-10-18T18:00:00+08:00", timeEvidence: { due: "10月18日18时交照片" } })], [message(text)]);
  assert.equal(new Set(result.actions.map((item) => item.actionId)).size, 2);
  const sameTime = "10月18日12时交材料；10月18日12时交照片";
  const repeated = parse([action({ sourceItemQuote: "交材料", timeEvidence: { due: "10月18日12时交材料" } }), action({ sourceItemQuote: "交照片", timeEvidence: { due: "10月18日12时交照片" } })], [message(sameTime)]);
  assert.equal(new Set(repeated.actions.map((item) => item.actionId)).size, 2);
  assert.equal(parse([action({ timeEvidence: { due: "12时前提交材料" } })]).actions.length, 0, "a clock without the source date cannot borrow a candidate date");
});

test("explicit calendar ranges preserve the supported end and source-date timezone", () => {
  const text = "10月18日下午两点至四点开会";
  const calendar = action({ type: "calendar", calendarName: "活动", start: "2026-10-18T14:00:00+08:00", end: "2026-10-18T16:00:00+08:00", sourceItemQuote: "开会", timeEvidence: { start: text, end: text } });
  const result = parse([calendar], [message(text)]);
  assert.equal(result.actions[0].end, "2026-10-18T08:00:00.000Z");
  const midnight = { ...message("明天上午9点交材料"), timestamp: "2026-10-16T17:00:00Z" };
  assert.equal(parse([action({ due: "2026-10-18T09:00:00+08:00", sourceItemQuote: "交材料", timeEvidence: { due: midnight.text } })], [midnight]).actions.length, 1);
  assert.equal(parse([action()], [{ ...message("10月18日12时前提交材料"), contextOnly: true }]).actions.length, 0);
});

test("two independent items sharing one source clock have separate stable identities", () => {
  const text = "10月18日12时前提交材料并领取证件";
  const items = [action({ timeEvidence: { due: text } }), action({ sourceItemQuote: "领取证件", timeEvidence: { due: text } })];
  const result = parse(items, [message(text)]);
  assert.equal(new Set(result.actions.map((item) => item.actionId)).size, 2);
  assert.equal(parse([{ ...items[0], title: "材料上交", normalizedTitle: "材料上交" }], [message(text)]).actions[0].actionId, result.actions[0].actionId);
  for (const sourceItemQuote of [undefined, "虚构事项"]) assert.equal(parse([action({ sourceItemQuote })]).actions.length, 0);
});

test("time evidence cannot borrow the clock from a different source item clause", () => {
  const text = "10月18日12时提交材料；10月19日18时领取证件";
  const result = parse([action({ due: "2026-10-19T18:00:00+08:00", timeEvidence: { due: text } })], [message(text)]);
  assert.equal(result.actions.length, 0);
});

test("quotes cannot trim an explicit source year or clock suffix", () => {
  for (const [text, quote, due] of [
    ["2027年10月18日12时前提交材料", "10月18日12时前提交材料", "2026-10-18T12:00:00+08:00"],
    ["2027年10月18日12时前提交材料", "10月18日12时前提交材料", "2027-10-18T12:00:00+08:00"],
    ["10月18日12:00:30提交材料", "10月18日12:00", "2026-10-18T12:00:00+08:00"]
  ]) assert.equal(parse([action({ due, timeEvidence: { due: quote } })], [message(text)]).actions.length, 0, text);
});

test("a new explicit date cuts item attribution even after a comma or without punctuation", () => {
  for (const separator of ["，", "", "："]) {
    const text = `10月18日12时提交材料${separator}10月19日18时领取证件`;
    assert.equal(parse([action({ due: "2026-10-19T18:00:00+08:00", timeEvidence: { due: text } })], [message(text)]).actions.length, 0);
    // Multiple dates without a local separator or explicit range are ambiguous.
    assert.equal(parse([action({ timeEvidence: { due: text } })], [message(text)]).actions.length, separator ? 1 : 0);
  }
});

test("item-before-date and explicit cross-date ranges remain supported", () => {
  const before = "提交材料截止10月18日12时";
  assert.equal(parse([action({ timeEvidence: { due: before } })], [message(before)]).actions.length, 1);
  const text = "10月18日14点至10月19日16点开会";
  const calendar = action({ type: "calendar", calendarName: "活动", sourceItemQuote: "开会", start: "2026-10-18T14:00:00+08:00", end: "2026-10-19T16:00:00+08:00", timeEvidence: { start: text, end: text } });
  assert.equal(parse([calendar], [message(text)]).actions.length, 1);
});

test("local item clauses prevent reverse-worded borrowing from an earlier date", () => {
  for (const separator of ["，", ",", "；", "。", "\n"]) {
    const text = `10月18日12时提交材料${separator}领取证件截止10月19日18时`;
    assert.equal(parse([action({ sourceItemQuote: "领取证件", timeEvidence: { due: text } })], [message(text)]).actions.length, 0, separator);
    assert.equal(parse([action({ sourceItemQuote: "领取证件", due: "2026-10-19T18:00:00+08:00", timeEvidence: { due: text } })], [message(text)]).actions.length, 1, separator);
  }
});

test("ambiguous meridiem boundaries are rejected while explicit clocks remain usable", () => {
  for (const [clock, hour] of [["晚上12点", "12"], ["晚上1点", "13"], ["上午12点", "00"]]) {
    const text = `10月18日${clock}提交材料`;
    assert.equal(parse([action({ due: `2026-10-18T${hour}:00:00+08:00`, timeEvidence: { due: text } })], [message(text)]).actions.length, 0, clock);
  }
  for (const [clock, hour] of [["晚上9点", "21"], ["下午2点", "14"], ["00:00", "00"], ["凌晨00点", "00"]]) {
    const text = `10月18日${clock}提交材料`;
    assert.equal(parse([action({ due: `2026-10-18T${hour}:00:00+08:00`, timeEvidence: { due: text } })], [message(text)]).actions.length, 1, clock);
  }
});

test("multiple clocks without an explicit range cannot be assigned to separate items", () => {
  const text = "10月18日12时提交材料和18时领取证件";
  assert.equal(parse([action({ sourceItemQuote: "领取证件", timeEvidence: { due: text } })], [message(text)]).actions.length, 0);
});
