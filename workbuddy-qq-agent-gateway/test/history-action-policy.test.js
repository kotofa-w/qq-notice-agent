import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverSubscriptionAutomation } from '../src/automation/subscription-execution.js';
import { SessionStore } from '../src/storage/session-store.js';

const context = (id = 'old', allowFutureActions) => ({ sourceGroupId: '54321', messages: [{ messageId: id }], historyRecovery: { batchId: 'batch', allowFutureActions } });
const action = (overrides = {}) => ({ sourceGroupId: '54321', sourceMessageId: 'old', type: 'reminder', title: '事项', due: '2099-10-18T12:00:00+08:00', ...overrides });

async function setup(t, contexts, actions) {
  const directory = await mkdtemp(join(tmpdir(), 'history-actions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(directory, 'sessions.json') }); await store.init();
  await store.requestTrigger('99999', 'subscription_auto'); await store.beginWork('99999');
  const plan = await store.prepareSubscriptionAutomation('99999', { contexts, autoResult: { reply: '历史摘要', actions }, result: {} });
  return { store, plan };
}

test('history summary defaults to skipped, retries retain outcome and delivery can consume and complete', async t => {
  const { store, plan } = await setup(t, [context()], [action()]);
  let attempts = 0; let consumed;
  const worker = { store, canRun: () => true, automationClient: { execute: async () => { attempts++; return { result: '写入' }; } }, deliverPrepared: async () => { throw new Error('QQ temporarily unavailable'); } };
  await assert.rejects(deliverSubscriptionAutomation(worker, '99999', plan), /temporarily/);
  const saved = store.snapshot('99999').subscriptionAutomationPlans[0];
  assert.deepEqual(saved.outcomes, [{ status: 'skipped', reason: '历史补漏仅生成摘要' }]);
  worker.deliverPrepared = async () => {
    const delivery = store.snapshot('99999').failedDelivery;
    consumed = delivery.subscriptionConsumptions;
    assert.match(delivery.reply, /历史摘要/); assert.match(delivery.reply, /历史补漏仅生成摘要/);
    assert.doesNotMatch(delivery.reply, /重试|undefined/);
    await store.completeDeliveryWork('99999');
  };
  await deliverSubscriptionAutomation(worker, '99999', saved);
  assert.equal(attempts, 0); assert.equal(consumed[0].sourceGroupId, '54321');
  assert.equal(consumed[0].messages[0].messageId, 'old');
  assert.deepEqual(store.snapshot('99999').subscriptionAutomationPlans, []);
});

test('policy only restricts referenced history and requires strictly future valid times', async () => {
  const { historyActionSkipReason: skip } = await import('../src/security/history-action-policy.js');
  const now = new Date('2026-10-18T04:00:00Z');
  const contexts = [context('old', true), { sourceGroupId: '54321', messages: [{ messageId: 'live' }] }];
  assert.equal(skip(action(), [context()], { now }), '历史补漏仅生成摘要');
  assert.equal(skip(action({ sourceMessageId: undefined }), [context()], { now }), '历史补漏仅生成摘要');
  assert.equal(skip(action(), contexts, { now }), null);
  assert.equal(skip(action({ sourceMessageId: 'live', due: null }), contexts, { now }), null);
  assert.equal(skip(action({ sourceGroupId: 'other', due: null }), contexts, { now }), null);
  for (const due of [null, '', 'garbage', '2027-02-30T12:00:00+08:00', '2027-01-01', '2026-10-18T12:00:00+08:00', '2026-10-18T11:59:59+08:00']) {
    assert.ok(skip(action({ due }), contexts, { now }), String(due));
  }
  assert.equal(skip(action({ due: '2026-10-18T12:00:00.001+08:00' }), contexts, { now }), null);
  assert.ok(skip(action({ type: 'calendar', start: now.toISOString(), end: '2099-01-01T12:00:00+08:00' }), contexts, { now }));
});

test('all-day dates use the Shanghai day at midnight across UTC date boundaries', async () => {
  const { historyActionSkipReason: skip } = await import('../src/security/history-action-policy.js');
  const contexts = [context('old', true)];
  for (const start of ['2026-10-18', '2026-10-18T00:00:00.000Z', '2026-10-17T16:00:00.000Z']) {
    const value = action({ type: 'calendar', allDay: true, start });
    assert.equal(skip(value, contexts, { now: new Date('2026-10-17T15:59:59.999Z') }), null);
    assert.ok(skip(value, contexts, { now: new Date('2026-10-17T16:00:00Z') }));
  }
});

test('execution rechecks the current instant immediately before each effect', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T04:00:00Z') });
  const { store, plan } = await setup(t, [context('old', true)], [action(), action({ due: '2026-10-18T12:00:05+08:00' })]);
  let attempts = 0;
  const worker = { store, canRun: () => true, automationClient: { execute: async () => {
    attempts++;
    // Model an action that expires while the previous external call is in flight.
    t.mock.timers.tick(10_000);
    return { result: '写入', itemType: 'calendar' };
  } }, deliverPrepared: async () => {} };
  const result = await deliverSubscriptionAutomation(worker, '99999', plan);
  assert.equal(attempts, 1); assert.equal(result.outcomes[1].status, 'skipped');
});
