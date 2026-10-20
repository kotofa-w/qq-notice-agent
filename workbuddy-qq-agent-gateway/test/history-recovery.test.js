import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore } from '../src/storage/subscription-store.js';
import { HistoryRecovery } from '../src/qq/history-recovery.js';

const now = new Date('2026-10-18T07:00:00Z');
const message = id => ({ accountId: '12345', groupId: '54321', messageId: String(id), realSeq: String(id), senderId: '88888', senderName: '课代表', senderRole: 'admin', timestamp: `2026-10-18T0${id}:00:00Z`, text: '明天上午9点开会', images: [], attachments: [], imageRefs: [] });
const page = ids => ({ entries: ids.map(id => ({ message: message(id), payload: {} })), nextCursor: String(ids[0]), oldestAt: message(ids[0]).timestamp, warnings: [], empty: !ids.length });
async function setup(t, reader) {
  const dir = await mkdtemp(join(tmpdir(), 'history-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { filePath: join(dir, 'store.json'), accountId: '12345', clock: () => now };
  const store = new SubscriptionStore(options); await store.init();
  const sub = (await store.upsertSubscription({ targetType: 'private', targetId: '77777', sourceGroupId: '54321' })).subscription;
  const recovery = new HistoryRecovery({ store, reader, accountId: '12345', clock: () => now });
  return { store, sub, recovery, options };
}
const range = { from: '2026-10-18T01:30:00Z', to: '2026-10-18T06:30:00Z' };

test('scan persists page cursor after interruption, resumes with overlap and only confirms selected messages', async t => {
  let calls = 0;
  const reader = { async readPage({ cursor }) { calls++; if (calls === 1) return page([4, 5, 6]); if (calls === 2) throw new Error('临时断线'); assert.equal(cursor, '4'); return page([1, 2, 3, 4]); } };
  const { store, sub, recovery, options } = await setup(t, reader);
  let scan = await recovery.create({ subscriptionId: sub.id, ...range });
  assert.equal(scan.status, 'partial'); assert.equal(store.getHistoryScan(scan.id).cursor, '4');
  const restored = new SubscriptionStore(options); await restored.init();
  const next = new HistoryRecovery({ store: restored, reader, accountId: '12345', clock: () => now });
  scan = await next.resume(scan.id);
  assert.equal(scan.coverageComplete, true); assert.equal(scan.messages.length, 5);
  await assert.rejects(next.confirm(scan.id, { messageIds: ['2'] }), /核对/);
  const result = await next.confirm(scan.id, { messageIds: ['2'], acknowledgeUncertain: true });
  assert.equal(result.result.queued, 1);
  const claims = await restored.claimForTarget('private', '77777');
  assert.equal(claims[0].messages[0].messageId, '2');
  assert.equal(claims[0].historyRecovery.allowFutureActions, false);
  assert.equal((await next.confirm(scan.id, { messageIds: ['2'], acknowledgeUncertain: true })).result.queued, 0);
});

test('empty and repeated pages report incomplete coverage; invalid selection and stale config are rejected', async t => {
  const { store, sub, recovery } = await setup(t, { readPage: async () => page([4, 5]) });
  const scan = await recovery.create({ subscriptionId: sub.id, ...range });
  assert.equal(scan.coverageComplete, false);
  assert.match(scan.stopReason, /游标|重复/);
  await assert.rejects(recovery.confirm(scan.id, { messageIds: ['999'], acknowledgeUncertain: true, acknowledgePartial: true }), /所选/);
  await store.upsertSubscription({ ...sub, enabled: false });
  await assert.rejects(recovery.confirm(scan.id, { messageIds: ['4'], acknowledgeUncertain: true, acknowledgePartial: true }), /订阅/);
});

test('live receipt arriving after preview is rechecked at confirmation and scanning has no side effects', async t => {
  const { store, sub, recovery } = await setup(t, { readPage: async () => page([1, 2, 3]) });
  const scan = await recovery.create({ subscriptionId: sub.id, ...range });
  assert.equal(store.snapshot().subscriptions[sub.id].state.pendingSequences.length, 0);
  await store.appendSourceMessage(message(2));
  const result = await recovery.confirm(scan.id, { messageIds: ['2'], acknowledgeUncertain: true });
  assert.equal(result.result.queued, 0);
  assert.equal(store.snapshot().subscriptions[sub.id].state.pendingSequences.length, 1);
});

test('truncated page is never reported as complete even when it crosses the time boundary', async t => {
  let nextPage = null;
  const { store, sub, recovery } = await setup(t, { readPage: async () => { if (!nextPage) throw new Error('断线'); return nextPage; } });
  const scan = await recovery.create({ subscriptionId: sub.id, ...range });
  const saved = store.getHistoryScan(scan.id);
  saved.entries = Array.from({ length: 490 }, (_, i) => ({ message: { ...message(2), messageId: String(1000 + i), realSeq: String(1000 + i) }, payload: {} }));
  await store.saveHistoryScan(saved);
  nextPage = { ...page([1, 2, 3]), entries: Array.from({ length: 50 }, (_, i) => ({ message: { ...message(2), messageId: String(2000 + i), realSeq: String(2000 + i) }, payload: {} })) };
  const result = await recovery.resume(scan.id);
  assert.equal(result.messages.length, 500);
  assert.equal(result.coverageComplete, false);
  assert.match(result.warnings.join(' '), /500/);
});

for (const failedSave of [2, 3]) test(`confirmation resumes frozen intent after persistence failure ${failedSave}`, async t => {
  const { store, sub, recovery, options } = await setup(t, { readPage: async () => page([1, 2, 3]) });
  const scan = await recovery.create({ subscriptionId: sub.id, ...range });
  const save = store.save.bind(store); let calls = 0;
  store.save = async () => { if (++calls === failedSave) throw new Error('磁盘暂不可写'); await save(); };
  await assert.rejects(recovery.confirm(scan.id, { messageIds: ['2'], acknowledgeUncertain: true }), /磁盘/);
  store.save = save;
  const restored = new SubscriptionStore(options); await restored.init();
  const next = new HistoryRecovery({ store: restored, reader: {}, accountId: '12345', clock: () => now });
  const preview = next.get(scan.id);
  assert.equal(preview.status, 'confirming');
  assert.deepEqual(preview.confirmationIntent, { messageIds: ['2'], allowFutureActions: false });
  const result = await next.confirm(scan.id, { messageIds: ['2'], acknowledgeUncertain: true });
  assert.equal(result.scan.status, 'confirmed');
  assert.equal(result.scan.confirmedCount, 1);
  assert.equal(restored.snapshot().subscriptions[sub.id].state.pendingSequences.length, 1);
});
