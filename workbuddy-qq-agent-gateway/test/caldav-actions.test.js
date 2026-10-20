import assert from "node:assert/strict";
import test from "node:test";
import { CaldavActionClient } from "../src/automation/caldav-actions.js";

const action = {
  actionId: "0123456789abcdef01234567", type: "calendar", title: "开会", calendarName: "学习",
  start: "2026-10-17T09:00:00+08:00", end: null, allDay: false, notes: "", location: ""
};
const calendarUrl = "https://dav.example.test/calendars/user/main/";
const client = (fetchImpl, options = {}) => new CaldavActionClient({
  calendarUrl, username: "user", password: "private-password", fetchImpl, ...options
});
const unfold = (body) => body.replace(/\r\n[ \t]/g, "");

test("writes a fixed-origin VEVENT with real time, escaped Chinese text, source and DISPLAY alarm", async () => {
  let request;
  const result = await client(async (url, options) => {
    request = { url, ...options };
    return new Response(null, { status: 201, headers: { ETag: '"created-1"' } });
  }).execute({ ...action, title: "中文".repeat(40), notes: "第一行\\逗号,分号;\n第二行", location: "会议室", calendarUrl: "https://attacker.test/" }, { sourceGroupId: "123", sourceGroupName: "通知群" });
  assert.equal(request.url, `${calendarUrl}codex-remote-contact-${action.actionId}.ics`);
  assert.equal(request.method, "PUT");
  assert.equal(request.redirect, "error");
  assert.equal(request.headers["If-None-Match"], "*");
  assert.equal(request.headers.Authorization, `Basic ${Buffer.from("user:private-password").toString("base64")}`);
  assert.match(request.headers["Content-Type"], /^text\/calendar/);
  const ics = unfold(request.body);
  assert.match(ics, /DTSTART:20261017T010000Z\r\n/);
  assert.doesNotMatch(ics, /DTEND/);
  assert.match(ics, /DESCRIPTION:第一行\\\\逗号\\,分号\\;\\n第二行\\n来源：通知群 \(123\)/);
  assert.match(ics, /CATEGORIES:学习\r\n/);
  assert.match(ics, /ACTION:DISPLAY\r\nTRIGGER:-PT30M\r\n/);
  assert.match(ics, new RegExp(`UID:codex-remote-contact-${action.actionId}@qq-agent-gateway\\r\\n`));
  assert.equal(ics.includes("SUMMARY:" + "中文".repeat(40)), true);
  for (const line of request.body.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(request.body.includes("�"), false);
  assert.equal(result.targetList, "fruux");
  assert.equal(result.itemType, "calendar");
  assert.equal(result.externalItemId, request.url);
});

test("keeps explicit end and converts all-day dates using UTC+8 with exclusive DTEND", async () => {
  const bodies = [];
  const executor = client(async (_url, options) => { bodies.push(unfold(options.body)); return new Response(null, { status: 201, headers: { ETag: '"created-1"' } }); });
  await executor.execute({ ...action, end: "2026-10-17T10:15:00+08:00" });
  await executor.execute({ ...action, allDay: true, start: "2026-10-16T16:00:00Z", end: "2026-10-18T16:00:00Z" });
  await executor.execute({ ...action, allDay: true, start: "2026-10-16T16:00:00Z" });
  assert.match(bodies[0], /DTEND:20261017T021500Z/);
  assert.match(bodies[1], /DTSTART;VALUE=DATE:20261017\r\nDTEND;VALUE=DATE:20261019/);
  assert.doesNotMatch(bodies[2], /DTEND/);
});

test("reminders without due are skipped, while dated reminders become clearly marked events", async () => {
  const requests = [];
  const executor = client(async (_url, options) => { requests.push(options); return new Response(null, { status: 201, headers: { ETag: '"created-1"' } }); });
  const reminder = { actionId: action.actionId, type: "reminder", title: "交报告", notes: "截止提交" };
  const skipped = await executor.execute(reminder);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.itemType, "calendar");
  assert.equal(skipped.externalItemId, null);
  assert.match(skipped.result, /未写入/);
  assert.equal(requests.length, 0);
  await executor.execute({ ...reminder, due: "2026-10-18T12:00:00+08:00" });
  assert.match(unfold(requests[0].body), /SUMMARY:【待办】交报告/);
  assert.match(unfold(requests[0].body), /DTSTART:20261018T040000Z/);
  assert.match(unfold(requests[0].body), /CATEGORIES:待办/);
  assert.doesNotMatch(requests[0].body, /VTODO|DTEND/);
});

test("412 reads the same event and only updates owned UID with a strong ETag", async () => {
  let stored;
  const calls = [];
  const executor = client(async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) { stored = options.body; return new Response(null, { status: 201, headers: { ETag: '"created-1"' } }); }
    if (options.method === "GET") return new Response(stored, { status: 200, headers: { ETag: '"revision-1"' } });
    if (options.headers["If-None-Match"]) return new Response(null, { status: 412 });
    assert.equal(options.headers["If-Match"], '"revision-1"');
    stored = options.body;
    return new Response(null, { status: 204, headers: { ETag: '"updated-2"' } });
  });
  await executor.execute(action);
  const repeated = await executor.execute(action);
  assert.match(repeated.result, /已存在/);
  assert.equal(calls.length, 3);
  const changed = await executor.execute({ ...action, title: "改期开会" });
  assert.match(changed.result, /更新/);
  assert.equal(calls.length, 6);
  assert.equal(calls[5].headers["If-None-Match"], undefined);
  assert.equal(new Set(calls.map((call) => call.url)).size, 1);
});

test("never overwrites foreign, malformed or non-ETag events", async () => {
  let owned;
  await client(async (_url, options) => { owned = options.body; return new Response(null, { status: 201, headers: { ETag: '"created-1"' } }); }).execute(action);
  const cases = [
    { body: owned.replace(`UID:codex-remote-contact-${action.actionId}`, "UID:foreign"), etag: '"1"' },
    { body: owned.replace("X-CODEX-REMOTE-CONTACT-ACTION-ID:", "X-OTHER:"), etag: '"1"' },
    { body: owned.replace("END:VEVENT", "END:VEVENT\r\nBEGIN:VEVENT\r\nUID:other\r\nEND:VEVENT"), etag: '"1"' },
    { body: owned, etag: null },
    { body: owned, etag: 'W/"1"' }
  ];
  for (const item of cases) {
    let puts = 0;
    const executor = client(async (_url, options) => {
      if (options.method === "PUT") { puts++; return new Response(null, { status: 412 }); }
      return new Response(item.body, { status: 200, headers: item.etag ? { ETag: item.etag } : {} });
    });
    await assert.rejects(executor.execute({ ...action, title: "变更" }), /ownership|ETag/i);
    assert.equal(puts, 1);
  }
});

test("rejects unsafe endpoints and invalid action data before sending credentials", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("should not fetch"); };
  for (const url of ["http://dav.example.test/cal/", "https://user:pass@dav.example.test/cal/", "https://dav.example.test:444/cal/", "https://dav.example.test/cal/?token=secret", "https://dav.example.test/cal/#fragment"]) {
    assert.throws(() => client(fetchImpl, { calendarUrl: url }), /CalDAV/);
  }
  const executor = client(fetchImpl);
  for (const invalid of [
    { ...action, actionId: "../../elsewhere" }, { ...action, start: null },
    { ...action, start: "invalid" }, { ...action, end: "invalid" },
    { ...action, end: "2026-10-17T08:00:00+08:00" }, { ...action, type: "unknown" }
  ]) await assert.rejects(executor.execute(invalid), /action|date|start|end/i);
  assert.equal(calls, 0);
});

test("network, redirect and conditional-write failures reject without leaking passwords", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("failure private-password"); },
    async () => new Response("private-password", { status: 302, headers: { Location: "https://attacker.test/" } }),
    async () => new Response("private-password", { status: 503 })
  ]) {
    await assert.rejects(client(fetchImpl).execute(action), (error) => !error.message.includes("private-password") && /CalDAV/.test(error.message));
  }
  let count = 0;
  await assert.rejects(client(async (_url, options) => {
    count++;
    if (options.method === "GET") throw new Error("private-password");
    return new Response(null, { status: 412 });
  }).execute(action), /CalDAV/);
  assert.equal(count, 2);
});

test("a concurrent ETag change fails without unconditionally retrying the update", async () => {
  let stored;
  await client(async (_url, options) => { stored = options.body; return new Response(null, { status: 201, headers: { ETag: '"created-1"' } }); }).execute(action);
  const calls = [];
  const executor = client(async (_url, options) => {
    calls.push(options);
    if (options.method === "GET") return new Response(stored, { status: 200, headers: { ETag: '"before-race"' } });
    return new Response(null, { status: 412 });
  });
  await assert.rejects(executor.execute({ ...action, title: "改动" }), /update.*412/);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers["If-Match"], '"before-race"');
});

test("request timeout aborts fetch and rejects so the queue can retain the action", async () => {
  const executor = client(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted private-password")), { once: true });
  }), { timeoutMs: 10 });
  await assert.rejects(executor.execute(action), /CalDAV request timed out/);
});
