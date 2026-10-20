import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore } from '../src/storage/subscription-store.js';

const now = new Date('2026-10-18T07:00:00Z');
const msg = (id, extra = {}) => ({ accountId: '12345', groupId: '54321', messageId: id,
  realSeq: id, senderId: '88888', senderName: '课代表', senderRole: 'admin',
  timestamp: '2026-10-18T06:00:00Z', text: `明天上午9点开会 ${id}`, images: [], attachments: [], ...extra });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'history-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { filePath: join(dir, 'store.json'), clock: () => now, accountId: '12345' };
  const store = new SubscriptionStore(options); await store.init();
  const { subscription } = await store.upsertSubscription({ targetType: 'private', targetId: '77777', sourceGroupId: '54321', collectionDelayMinutes: 10 });
  return { store, options, subscription };
}

test('successful live delivery stays deduplicated after GC and restart', async (t) => {
  const { store, options } = await setup(t);
  await store.appendSourceMessage(msg('1'));
  const contexts = await store.claimForTarget('private', '77777'); // not due yet
  assert.deepEqual(contexts, []);
  store.clock = () => new Date(+now + 11 * 60000);
  await store.completeClaims(await store.claimForTarget('private', '77777'));
  assert.equal(store.snapshot().sources['54321'].messages.length, 0);
  const restored = new SubscriptionStore(options); await restored.init();
  assert.equal((await restored.appendSourceMessage(msg('1'))).duplicate, true);
});

test('history batch does not consume or extend a waiting live collection', async (t) => {
  const { store, subscription } = await setup(t);
  await store.appendSourceMessage(msg('5'));
  const deadline = store.snapshot().subscriptions[subscription.id].state.collections[0].deadline;
  await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'batch-1', messages: [msg('2')], allowFutureActions: false });
  const contexts = await store.claimForTarget('private', '77777');
  assert.deepEqual(contexts[0].messages.map(m => m.messageId), ['2']);
  assert.equal(contexts[0].historyRecovery.allowFutureActions, false);
  await store.completeClaims(contexts);
  const state = store.snapshot().subscriptions[subscription.id].state;
  assert.equal(state.pendingSequences.length, 1);
  assert.equal(state.collections.find(c => c.status === 'collecting').deadline, deadline);
  assert.equal((await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'batch-1', messages: [msg('2')] })).queued, 0);
});

test('history consumption is separate for each subscription and rejects identity conflicts', async (t) => {
  const { store, subscription } = await setup(t);
  await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'a', messages: [msg('2')] });
  await store.completeClaims(await store.claimForTarget('private', '77777'));
  const other = (await store.upsertSubscription({ targetType: 'private', targetId: '66666', sourceGroupId: '54321' })).subscription;
  assert.equal((await store.enqueueHistoryBatch({ subscriptionId: other.id, batchId: 'b', messages: [msg('2')] })).queued, 1);
  await assert.rejects(store.enqueueHistoryBatch({ subscriptionId: other.id, batchId: 'c', messages: [msg('2', { text: '不同内容' })] }), /身份冲突/);
});

test('history for one target does not swallow another targets live copy or leak into live collections', async t => {
  const { store, subscription } = await setup(t);
  const other = (await store.upsertSubscription({ targetType: 'private', targetId: '66666', sourceGroupId: '54321' })).subscription;
  await store.appendSourceMessage(msg('1'));
  await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'history', messages: [msg('2')] });
  await store.appendSourceMessage(msg('3'));
  await store.appendSourceMessage(msg('2'));
  assert.equal(store.snapshot().subscriptions[other.id].state.pendingSequences.length, 3);
  await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'history-b', messages: [msg('4')] });
  const contexts = await store.claimForTarget('private', '77777');
  assert.deepEqual(contexts[0].messages.map(m => m.messageId), ['2']);
  assert.equal(contexts[0].historyRecovery.batchId, 'history');
  store.clock = () => new Date(+now + 11 * 60000);
  const live = await store.claimForTarget('private', '66666');
  assert.deepEqual(live[0].messages.map(m => m.messageId), ['1', '3', '2']);
  assert.equal(live[0].historyRecovery, undefined);
});

test('restart never infers other targets completion from a higher live watermark', async t => {
  const { store, options, subscription } = await setup(t);
  const other = (await store.upsertSubscription({ targetType: 'private', targetId: '66666', sourceGroupId: '54321' })).subscription;
  await store.appendSourceMessage(msg('1'));
  await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'a', messages: [msg('2', { timestamp: now.toISOString() })] });
  await store.appendSourceMessage(msg('3'));
  store.clock = () => new Date(+now + 11 * 60000);
  await store.completeClaims(await store.claimForTarget('private', '66666'));
  const restored = new SubscriptionStore(options); await restored.init();
  assert.equal(restored.historyMessageStatus(other.id, msg('2', { timestamp: now.toISOString() })).duplicate, false);
});

test('new live messages keep the existing administrator window across a history batch', async t => {
  const { store, subscription } = await setup(t);
  await store.upsertSubscription({ ...subscription, intakeMode: 'ADMIN_ONLY' });
  await store.appendSourceMessage(msg('1'));
  await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'h', messages: [msg('2')] });
  store.clock = () => new Date(+now + 2 * 60000);
  await store.appendSourceMessage(msg('3', { senderRole: 'member' }));
  const state = store.snapshot().subscriptions[subscription.id].state;
  assert.equal(state.pendingSequences.length, 3);
  const live = state.collections.filter(c => !c.historyRecovery && c.status === 'collecting');
  assert.equal(live.length, 1);
  assert.equal(live[0].deadline, new Date(+now + 12 * 60000).toISOString());
  assert.deepEqual(live[0].sequences.map(seq => store.snapshot().sources['54321'].messages.find(m => m.sequence === seq).messageId), ['1', '3']);
});

test('saving identical settings keeps a history confirmation valid', async t => {
  const { store, subscription } = await setup(t);
  await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'h', messages: [msg('2')] });
  store.clock = () => new Date(+now + 1000);
  await store.upsertSubscription(subscription);
  const contexts = await store.claimForTarget('private', '77777');
  assert.equal(store.isHistoryContextCurrent(contexts[0]), true);
});

test('changing settings cancels stale history without blocking live messages or marking it delivered', async t => {
  const { store, subscription } = await setup(t);
  await store.appendSourceMessage(msg('1'));
  await store.enqueueHistoryBatch({ subscriptionId: subscription.id, batchId: 'h', messages: [msg('2')] });
  store.clock = () => new Date(+now + 1000);
  await store.upsertSubscription({ ...subscription, collectionDelayMinutes: 5 });
  assert.equal(store.snapshot().subscriptions[subscription.id].state.pendingSequences.length, 1);
  assert.deepEqual(await store.claimForTarget('private', '77777'), []);
  assert.equal(store.historyMessageStatus(subscription.id, msg('2')).duplicate, false);
  store.clock = () => new Date(+now + 11 * 60000);
  const claims = await store.claimForTarget('private', '77777');
  assert.deepEqual(claims[0].messages.map(m => m.messageId), ['1']);
  assert.equal(claims[0].historyRecovery, undefined);
});
