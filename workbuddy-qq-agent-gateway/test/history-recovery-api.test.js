import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { SubscriptionStore } from '../src/storage/subscription-store.js';
import { HistoryRecovery } from '../src/qq/history-recovery.js';

test('authenticated recovery routes preview without queueing and enqueue only an explicit confirmed selection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'history-api-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const now = new Date('2026-10-18T07:00:00Z');
  const subscriptionStore = new SubscriptionStore({ filePath: join(dir, 'store.json'), clock: () => now, accountId: '12345' });
  await subscriptionStore.init();
  const sub = (await subscriptionStore.upsertSubscription({ targetType: 'private', targetId: '77777', sourceGroupId: '54321' })).subscription;
  const historyRecovery = new HistoryRecovery({ store: subscriptionStore, accountId: '12345', clock: () => now,
    reader: { readPage: async () => ({ entries: [{ message: { accountId: '12345', groupId: '54321', messageId: '1', realSeq: '1', senderId: '88888', senderRole: 'admin', timestamp: '2026-10-18T02:00:00Z', text: '明天上午9点开会' }, payload: {} }], warnings: [], nextCursor: '1', oldestAt: '2026-10-18T01:00:00Z', empty: false }) } });
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  class HttpError extends Error { constructor(statusCode, message) { super(message); this.statusCode = statusCode; } }
  let schedules = 0;
  const handler = runInNewContext(`${source.slice(source.indexOf('async function handleApi('), source.indexOf('async function handleOneBotEvent('))}\n${source.slice(source.indexOf('function parseJson('), source.indexOf('function sendJson('))}\nhandleApi`, {
    process, historyRecovery, subscriptionStore, AGENT_QQ_ID: '12345', HttpError, console, assertTarget: () => {},
    checkSubscriptionSchedule: async () => { schedules++; },
    readRawBody: async req => Buffer.from(JSON.stringify(req.body)),
    isAuthorized: req => req.headers.authorization === 'Bearer synthetic-test',
    sendJson: (res, status, body) => Object.assign(res, { status, body })
  });
  async function request(method, pathname, body = {}, auth = true) {
    const res = {}; await handler({ method, body, headers: { 'content-type': 'application/json', authorization: auth ? 'Bearer synthetic-test' : '' } }, res, new URL(pathname, 'http://localhost')); return res;
  }
  const prefix = '/api/qq/history-recovery/scans';
  assert.equal((await request('POST', prefix, {}, false)).status, 401);
  const created = await request('POST', prefix, { subscriptionId: sub.id, from: '2026-10-18T01:30:00Z', to: '2026-10-18T06:00:00Z' });
  assert.equal(created.status, 201);
  assert.equal(subscriptionStore.snapshot().subscriptions[sub.id].state.pendingSequences.length, 0);
  const id = created.body.scan.id;
  const listed = await request('GET', `${prefix}?subscriptionId=${encodeURIComponent(sub.id)}`);
  assert.equal(listed.body.scans[0].id, id); assert.equal(listed.body.scans[0].messages, undefined);
  assert.equal(listed.body.connection, null);
  await subscriptionStore.saveConnectionRecovery('12345', { eligible: { secretOtherSubscription: {} }, intervals: [
    { id: 'gap', targets: { [sub.id]: { status: 'partial', stopReason: '容量不足' }, secretOtherSubscription: { status: 'pending' } } },
    { id: 'other-gap', targets: { secretOtherSubscription: { status: 'pending' } } }
  ] });
  const records = await request('GET', `${prefix}?subscriptionId=${encodeURIComponent(sub.id)}`);
  assert.equal(records.body.connection.eligible, undefined);
  assert.equal(records.body.connection.intervals.length, 1);
  assert.deepEqual(Object.keys(records.body.connection.intervals[0].targets), [sub.id]);
  assert.equal((await request('GET', `${prefix}/${id}`)).body.scan.id, id);
  await assert.rejects(request('POST', `${prefix}/${id}/confirm`, { messageIds: ['1'] }), error => error.statusCode === 400);
  const confirmed = await request('POST', `${prefix}/${id}/confirm`, { messageIds: ['1'], acknowledgeUncertain: true });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.result.queued, 1); assert.equal(schedules, 1);
  const claims = await subscriptionStore.claimForTarget('private', '77777');
  assert.equal(claims[0].historyRecovery.allowFutureActions, false);
});
