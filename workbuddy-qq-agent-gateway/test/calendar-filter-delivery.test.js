import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/storage/session-store.js';
import { PrivateWorker } from '../src/qq/private-worker.js';
import { GroupWorker } from '../src/groups/group-worker.js';

for (const type of ['private', 'group']) test(`${type}: calendar candidates start only after successful durable QQ receipt`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'calendar-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(dir, 'sessions.json') }); await store.init();
  await store.requestTrigger('12345', 'subscription_auto'); const work = await store.beginWork('12345');
  const plan = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '通知摘要', actions: [{ actionId: 'a', title: '考试' }] }, contexts: [], result: {} });
  let sent = 0; const receipts = [];
  const calendarFilter = { stage: async () => ({ ids: ['A17'], text: '日程确认 A17' }), markNotified: async (ids, receipt) => {
    assert.equal(store.snapshot('12345').failedDelivery.textSent, true);
    assert.equal(store.snapshot('12345').failedDelivery.notificationMessageId, '77');
    receipts.push({ ids, receipt });
  } };
  const send = async (id, text) => { sent++; assert.match(text, /通知摘要/); assert.match(text, /日程确认 A17/); return { ok: sent > 1, status: 503, body: { data: { message_id: 77 } } }; };
  const worker = new (type === 'private' ? PrivateWorker : GroupWorker)({ store, calendarFilter,
    automationClient: { execute: () => assert.fail('must wait for confirmation') },
    oneBot: { sendPrivateMessage: send, sendGroupMessage: send }, mediaManager: { removeMessages: async () => {} } });
  await assert.rejects(worker.runAgent('12345', { ...work, automationPlan: plan }), /503/);
  assert.equal(receipts.length, 0);
  await worker.deliverPrepared('12345');
  assert.equal(receipts.length, 1); assert.deepEqual(receipts[0].ids, ['A17']);
  assert.equal(receipts[0].receipt.messageId, '77'); assert.ok(Date.parse(receipts[0].receipt.sentAt));
  assert.equal(store.snapshot('12345').subscriptionAutomationPlans.length, 0);
});

test('notification receipt and candidate IDs survive SessionStore restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'calendar-receipt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'sessions.json'); let store = new SessionStore({ filePath }); await store.init();
  await store.requestTrigger('12345', 'subscription_auto'); await store.beginWork('12345');
  await store.prepareDeliveryWork('12345', { reply: '通知', calendarCandidateIds: ['A17'] });
  await store.markDeliveryTextSent('12345', { messageId: '77', sentAt: '2026-10-19T05:00:00.000Z' });
  store = new SessionStore({ filePath }); await store.init(); const delivery = store.snapshot('12345').failedDelivery;
  assert.deepEqual(delivery.calendarCandidateIds, ['A17']); assert.equal(delivery.notificationMessageId, '77');
  assert.equal(delivery.notificationSentAt, '2026-10-19T05:00:00.000Z');
});

test('a full-length summary sends candidate instructions separately and starts only on their receipt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'calendar-long-notice-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(dir, 'sessions.json') }); await store.init();
  await store.requestTrigger('12345', 'subscription_auto'); const work = await store.beginWork('12345');
  const plan = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '通'.repeat(12000), actions: [] }, contexts: [], result: {} });
  const sends = []; const receipts = [];
  const worker = new PrivateWorker({ store, calendarFilter: {
    stage: async () => ({ ids: ['C1'], text: '日程候选 C1：请确认' }),
    markNotified: async (ids, receipt) => receipts.push(receipt)
  }, oneBot: { sendPrivateMessage: async (id, text) => { sends.push(text); return { ok: true, body: { data: { message_id: sends.length } } }; } }, mediaManager: { removeMessages: async () => {} } });
  await worker.runAgent('12345', { ...work, automationPlan: plan });
  assert.equal(sends.length, 2); assert.equal(sends[0].length, 12000); assert.match(sends[1], /日程候选 C1/);
  assert.equal(receipts[0].messageId, '2');
});
