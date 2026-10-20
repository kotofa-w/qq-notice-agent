import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../modules/web-console/public/client.js", import.meta.url), "utf8");
const html = await readFile(new URL("../modules/web-console/public/client.html", import.meta.url), "utf8");
function fixture() {
  const ids = [...html.matchAll(/id="(calendarFilter[^"]+|saveCalendarFilterButton)"/g)].map((match) => match[1]);
  const els = Object.fromEntries(ids.map((id) => [id, { value: "", checked: false, disabled: false, innerHTML: "", textContent: "", handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } }]));
  const subscriptions = [{ id: "sub1", sourceGroupId: "22", sourceGroupName: "<课程群>", enabled: false }];
  const item = { key: "group:1", kind: "group", data: { targetId: "1", subscriptions } };
  const state = { ai: { calendarRemindersAvailable: true }, calendarFilter: { settings: [{ subscriptionId: "sub1", enabled: true, groupType: "course", categories: ["exam"], confirmationMinutes: 10, timeoutPolicy: "auto" }], candidates: [] } };
  const calls = [];
  const context = vm.createContext({ els, state, item, calls, URLSearchParams, currentTarget: () => item, escapeHtml: (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]), formatTime: String, api: async (path, options) => { calls.push({ path, options }); return state.calendarFilter; } });
  const start = source.indexOf("function calendarFilterSubscriptions(");
  assert.ok(start >= 0, "calendar filter UI functions exist");
  vm.runInContext(`let calendarFilterTarget = ""; let calendarFilterSubscription = ""; let calendarFilterDirty = false; let calendarFilterSaving = false;\n${source.slice(start, source.indexOf("function renderNoticeRoles(", start))}`, context);
  return { els, item, state, calls, run: (code) => vm.runInContext(code, context) };
}

test("calendar filter menu is scoped to targets, escapes sources, preserves edits and disables unavailable service", () => {
  const { els, item, state, run } = fixture();
  run("renderCalendarFilter(item)");
  assert.match(els.calendarFilterSubscription.innerHTML, /&lt;课程群&gt;/);
  assert.equal(els.calendarFilterMinutes.value, 10);
  els.calendarFilterMinutes.value = "45";
  els.calendarFilterForm.handlers.input();
  run("renderCalendarFilter(item)");
  assert.equal(els.calendarFilterMinutes.value, "45");
  state.ai.calendarRemindersAvailable = false;
  run("renderCalendarFilter(item)");
  assert.equal(els.saveCalendarFilterButton.disabled, true);
  assert.match(els.calendarFilterAvailability.textContent, /不可用/);
  item.kind = "source";
  run("renderCalendarFilter(item)");
  assert.equal(els.calendarFilterDetails.hidden, true);
});

test("candidate buttons enforce scope/status and escape reasons", () => {
  const { els, state, run } = fixture();
  state.calendarFilter.candidates = [
    { id: "a", targetType: "group", targetId: "1", subscriptionId: "sub1", status: "pending", writable: true, action: { title: "考试" }, reason: "<明确>" },
    { id: "b", targetType: "group", targetId: "1", subscriptionId: "sub1", status: "conflict", writable: true, action: { title: "冲突" } },
    { id: "c", targetType: "private", targetId: "1", subscriptionId: "sub1", status: "pending", writable: true, action: { title: "其他会话" } }
  ];
  run("renderCalendarFilter(item)");
  assert.match(els.calendarFilterCandidates.innerHTML, /&lt;明确&gt;/);
  assert.match(els.calendarFilterCandidates.innerHTML, /data-calendar-decision="approve" data-calendar-id="a"/);
  assert.doesNotMatch(els.calendarFilterCandidates.innerHTML, /data-calendar-decision="approve" data-calendar-id="b"|其他会话/);
  assert.match(els.calendarFilterCandidates.innerHTML, /data-calendar-decision="retry" data-calendar-id="b"/);
});

test("saving filter policy validates minutes, reads back and never enables its subscription", async () => {
  const { els, item, calls, run } = fixture();
  run("renderCalendarFilter(item)");
  els.calendarFilterMinutes.value = "0";
  await els.calendarFilterForm.handlers.submit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  els.calendarFilterMinutes.value = "20";
  await els.calendarFilterForm.handlers.submit({ preventDefault() {} });
  assert.equal(calls[0].path, "/api/calendar-filter/settings");
  assert.equal(JSON.parse(calls[0].options.body).confirmationMinutes, 20);
  assert.match(calls[1].path, /^\/api\/calendar-filter\?targetType=group&targetId=1/);
  assert.equal(item.data.subscriptions[0].enabled, false);
});

test("no subscriptions disable settings and defaults remain manual", () => {
  const { els, item, state, run } = fixture();
  state.calendarFilter.settings = [];
  run("renderCalendarFilter(item)");
  assert.equal(els.calendarFilterTimeout.value, "manual");
  assert.equal(els.calendarFilterEnabled.checked, false);
  item.data.subscriptions = [];
  run("renderCalendarFilter(item)");
  assert.equal(els.saveCalendarFilterButton.disabled, true);
  assert.match(els.calendarFilterAvailability.textContent, /没有通知源订阅/);
});

test("decision uses current target scope, forbids unwritable approval, permits synced revocation", async () => {
  const { els, state, calls, run } = fixture();
  state.calendarFilter.candidates = [
    { id: "blocked", targetType: "group", targetId: "1", status: "pending", writable: false, action: {} },
    { id: "synced", targetType: "group", targetId: "1", status: "synced", writable: true, action: {} }
  ];
  run("renderCalendarFilter(item)");
  const click = (id, decision) => els.calendarFilterCandidates.handlers.click({ target: { closest: () => ({ dataset: { calendarId: id, calendarDecision: decision } }) } });
  await click("blocked", "approve");
  await click("unrelated", "reject");
  assert.equal(calls.length, 0);
  assert.match(els.calendarFilterCandidates.innerHTML, /撤销已同步日程/);
  await click("synced", "reject");
  assert.equal(calls[0].path, "/api/calendar-filter/decision");
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: "synced", decision: "reject", targetType: "group", targetId: "1" });
});

test("paused approval and queued rejection are available but writing is locked", () => {
  const { els, state, run } = fixture();
  state.calendarFilter.candidates = ["paused", "approved", "writing", "awaiting_notification", "expired", "skipped"].map((status) => ({ id: status, targetType: "group", targetId: "1", status, writable: true, action: {} }));
  run("renderCalendarFilter(item)");
  assert.match(els.calendarFilterCandidates.innerHTML, /data-calendar-decision="approve" data-calendar-id="paused"/);
  assert.match(els.calendarFilterCandidates.innerHTML, /data-calendar-decision="reject" data-calendar-id="approved"/);
  assert.doesNotMatch(els.calendarFilterCandidates.innerHTML, /data-calendar-id="writing"/);
  assert.match(els.calendarFilterCandidates.innerHTML, /等待通知发送成功|正在写入|已过期|已跳过/);
});

test("choosing course defaults timeout to auto while polling preserves a manual choice", () => {
  const { els, run } = fixture();
  run("renderCalendarFilter(item)");
  els.calendarFilterGroupType.value = "course";
  els.calendarFilterGroupType.handlers.change();
  assert.equal(els.calendarFilterTimeout.value, "auto");
  els.calendarFilterTimeout.value = "manual";
  els.calendarFilterForm.handlers.input();
  run("renderCalendarFilter(item)");
  assert.equal(els.calendarFilterTimeout.value, "manual");
});

test("refreshing A retains B policy and candidates when switching target with the menu open", async () => {
  const { els, item, state, run } = fixture();
  state.calendarFilter.settings.push({ subscriptionId: "subB", enabled: true, groupType: "class", confirmationMinutes: 45, categories: ["class"], timeoutPolicy: "manual" });
  state.calendarFilter.candidates.push({ id: "B1", targetType: "private", targetId: "2", status: "manual", action: { title: "B事项" } });
  run("api = async () => ({ settings: [{ subscriptionId: 'sub1', enabled: true, confirmationMinutes: 10 }], candidates: [] })");
  await run("reloadCalendarFilter(item)");
  item.key = "private:2";
  item.kind = "private";
  item.data = { targetId: "2", subscriptions: [{ id: "subB", sourceGroupId: "33", enabled: true }] };
  run("renderCalendarFilter(item)");
  assert.equal(els.calendarFilterMinutes.value, 45);
  assert.equal(els.calendarFilterGroupType.value, "class");
  assert.match(els.calendarFilterCandidates.innerHTML, /B事项/);
});
