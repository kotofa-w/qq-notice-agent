import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAutoSubscriptionResult } from '../src/security/subscription-policy.js';
import { notificationFingerprint, optimizeSubscriptionInput, markNotifiedClaims } from '../src/security/subscription-input.js';
import { deliverSubscriptionAutomation, assertSubscriptionDeliveryActive } from '../src/automation/subscription-execution.js';
import { SessionStore } from '../src/storage/session-store.js';

const message = (messageId, senderId, text = '请在2026年10月18日12:00提交材料') => ({ messageId, senderId, text, senderRole: 'member', timestamp: '2026-10-17T01:00:00Z' });
const context = messages => ({ subscriptionId: 's', sourceGroupId: '54321', sourceGroupName: '课程群', intakeMode: 'RESPONSIBLE_ONLY', responsibleSenderIds: ['12345'], noticeRoleRevision: 1, messages });
const decision = (sourceMessageId, classification = 'notice', quote = '请在2026年10月18日12:00提交材料') => ({ sourceGroupId: '54321', sourceMessageId, classification, quote, reason: '本消息明确说明提交事项', publicationRole: 'publisher' });
const output = (noticeDecisions, actions = []) => JSON.stringify({ notify: true, urgency: 'normal', reply: '模型未筛选的闲聊', noticeSummaries: [{ sourceGroupId: '54321', summary: '危险的全量闲聊摘要' }], ambiguity: '', noticeDecisions, actions });
const action = sourceMessageId => ({ sourceGroupId: '54321', sourceMessageId, sourceItemQuote: '请在2026年10月18日12:00提交材料', type: 'reminder', title: '提交材料', due: '2026-10-18T12:00:00+08:00', timeEvidence: { due: '2026年10月18日12:00', start: null, end: null } });
const parse = (value, contexts) => parseAutoSubscriptionResult(value, contexts, { targetType: 'private', targetId: '99999' });

test('responsible mode excludes confirmed chat and unconfirmed notices but preserves their decisions', () => {
  const contexts = [context([message('1', '12345', '午饭吃什么'), message('2', '88888')])];
  const result = parse(output([decision('1', 'chat', '午饭吃什么'), decision('2')], [action('2')]), contexts);
  assert.equal(result.notify, false); assert.equal(result.reply, ''); assert.deepEqual(result.actions, []);
  assert.equal(result.noticeDecisions.length, 2);
});

test('responsible mode summarizes only confirmed notice quotes and keeps valid time-evidenced actions', () => {
  const result = parse(output([decision('1'), decision('2', 'chat', '午饭吃什么')], [action('1'), action('2')]), [context([message('1', '12345'), message('2', '12345', '午饭吃什么')])]);
  assert.match(result.reply, /请在2026年10月18日12:00提交材料/);
  assert.doesNotMatch(result.reply, /闲聊|午饭/); assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].sourceMessageId, '1');
});

test('uncertain media is retained without notification, while missing, invented or repeated decisions reject the batch', () => {
  const contexts = [context([message('1', '12345', ''), message('2', '88888', '也许有调整')])];
  const decisions = [decision('1', 'uncertain', ''), decision('2', 'uncertain', '也许有调整')];
  const result = parse(output(decisions), contexts);
  assert.equal(result.notify, false); assert.equal(result.noticeDecisions[0].classification, 'uncertain');
  for (const invalid of [undefined, [], [decisions[0]], [...decisions, decisions[0]], [decision('1', 'notice', ''), decisions[1]], [decisions[0], decision('2', 'notice', '伪造引用')], [...decisions, decision('999')]]) {
    assert.throws(() => parse(output(invalid), contexts), /notice decision/i);
  }
});

test('look-behind never counts as classification coverage or an independent notice', () => {
  const contexts = [context([{ ...message('old', '12345'), contextOnly: true }, message('1', '12345', '你好')])];
  const result = parse(output([decision('1', 'chat', '你好')]), contexts);
  assert.equal(result.notify, false);
  assert.throws(() => parse(output([decision('old'), decision('1', 'chat', '你好')]), contexts), /notice decision/i);
});

test('legacy ALL keeps mandatory summary when decisions are absent', () => {
  const result = parse(output(undefined), [{ ...context([message('1', '88888', '午饭吃什么')]), intakeMode: 'ALL' }]);
  assert.equal(result.notify, true); assert.match(result.reply, /全量闲聊摘要/);
});

test('responsible fingerprints use explicit eligibility and only delivered selected decisions get receipts', () => {
  const first = message('1', '12345'); const chat = message('2', '12345', '今天中午一起出去吃什么饭比较好'); const candidate = message('3', '88888');
  const fingerprint = notificationFingerprint(first, '54321', { eligible: true });
  assert.match(fingerprint || '', /^[a-f0-9]{64}$/); assert.equal(first.senderRole, 'member');
  const claim = context([first, chat, candidate]);
  markNotifiedClaims([claim], [claim], { noticeDecisions: [decision('1'), decision('2', 'chat', chat.text), decision('3')] });
  assert.deepEqual(claim.notificationFingerprints, [fingerprint]);
  const [input] = optimizeSubscriptionInput([{ ...claim, notifiedFingerprints: [{ fingerprint, notifiedAt: first.timestamp }] }], { now: Date.parse(first.timestamp) + 1000 });
  assert.deepEqual(input.messages.map(m => m.messageId), ['2', '3']);
});

async function setup(t, contexts, actions = [action('1')]) {
  const directory = await mkdtemp(join(tmpdir(), 'notice-execution-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(directory, 'sessions.json') }); await store.init();
  await store.requestTrigger('99999', 'subscription_auto'); await store.beginWork('99999');
  const plan = await store.prepareSubscriptionAutomation('99999', { contexts, autoResult: { reply: '摘要', actions, noticeDecisions: [decision('1')] }, result: {} });
  return { store, plan };
}

test('role revision changes cancel frozen actions and release claims before any external effect', async t => {
  const { store, plan } = await setup(t, [context([message('1', '12345')])]); const released = [];
  const worker = { store, subscriptionStore: { isNoticeContextCurrent: () => false, releaseClaims: async contexts => released.push(...contexts), failClaims: async () => assert.fail('must release') }, automationClient: { execute: () => assert.fail('stale action') }, canRun: () => true, deliverPrepared: () => assert.fail('stale delivery') };
  await assert.rejects(deliverSubscriptionAutomation(worker, '99999', plan), { code: 'RECALLED_INPUT' });
  assert.equal(store.snapshot('99999').subscriptionAutomationPlans.length, 0); assert.equal(released.length, 1);
});

test('prepared QQ retry rechecks role revision and releases an unconsumed claim', async t => {
  const { store, plan } = await setup(t, [context([message('1', '12345')])]);
  await store.prepareDeliveryWork('99999', { reply: '摘要', automationPlanId: plan.id, subscriptionConsumptions: plan.contexts });
  let released = 0;
  const worker = { store, subscriptionStore: { isNoticeContextCurrent: () => false, releaseClaims: async () => { released++; } } };
  await assert.rejects(assertSubscriptionDeliveryActive(worker, '99999', store.snapshot('99999').failedDelivery), { code: 'RECALLED_INPUT', deliveryCancelled: true });
  assert.equal(released, 1); assert.equal(store.snapshot('99999').failedDelivery, null);
});

test('decisions are recorded from the persisted frozen result even when there is no notification', async t => {
  const { store, plan } = await setup(t, [context([message('1', '12345')])], []); plan.autoResult.reply = '';
  let recorded = 0;
  const worker = { store, canRun: () => true, subscriptionStore: { isNoticeContextCurrent: () => true, recordNoticeDecisions: async (contexts, decisions) => { recorded++; assert.equal(store.snapshot('99999').subscriptionAutomationPlans.length, 1); assert.deepEqual(decisions, [decision('1')]); } }, deliverPrepared: async () => {} };
  await deliverSubscriptionAutomation(worker, '99999', plan); assert.equal(recorded, 1); assert.equal(store.snapshot('99999').failedDelivery.reply, '');
});

test('role changes between actions stop the remaining effects while keeping already completed outcomes', async t => {
  const { store, plan } = await setup(t, [context([message('1', '12345')])], [action('1'), action('1')]);
  let current = true; let executions = 0; let released = 0;
  const worker = { store, canRun: () => true, subscriptionStore: { isNoticeContextCurrent: () => current, recordNoticeDecisions: async () => {}, releaseClaims: async () => { released++; } }, automationClient: { execute: async () => { executions++; current = false; return { externalItemId: 'created-before-revocation' }; } }, deliverPrepared: () => assert.fail('must not deliver stale summary') };
  await assert.rejects(deliverSubscriptionAutomation(worker, '99999', plan), { code: 'RECALLED_INPUT' });
  assert.equal(executions, 1); assert.equal(released, 1); assert.deepEqual(store.snapshot('99999').subscriptionAutomationPlans, []);
});

test('responsible plan without a current-role validator fails closed', async t => {
  const { store, plan } = await setup(t, [context([message('1', '12345')])]);
  const worker = { store, canRun: () => true, subscriptionStore: { releaseClaims: async () => {} }, automationClient: { execute: () => assert.fail('missing validator') }, deliverPrepared: () => assert.fail('missing validator') };
  await assert.rejects(deliverSubscriptionAutomation(worker, '99999', plan), { code: 'RECALLED_INPUT' });
});

test('all-chat responsible batch completes and consumes its claim without sending QQ or writing calendar', async t => {
  const { SubscriptionStore } = await import('../src/storage/subscription-store.js');
  const { PrivateWorker } = await import('../src/qq/private-worker.js');
  const directory = await mkdtemp(join(tmpdir(), 'notice-silent-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date('2026-10-17T01:00:00Z');
  const subscriptions = new SubscriptionStore({ filePath: join(directory, 'subscriptions.json'), clock: () => now }); await subscriptions.init();
  await subscriptions.upsertSubscription({ targetType: 'private', targetId: '99999', sourceGroupId: '54321', intakeMode: 'RESPONSIBLE_ONLY', collectionDelayMinutes: 0.1 });
  await subscriptions.setNoticeRole({ sourceGroupId: '54321', senderId: '12345', status: 'confirmed' });
  await subscriptions.appendSourceMessage({ ...message('1', '12345', '午饭吃什么'), groupId: '54321' });
  now = new Date(+now + 7000); const contexts = await subscriptions.claimForTarget('private', '99999');
  const autoResult = parse(output([decision('1', 'chat', '午饭吃什么')]), contexts);
  const store = new SessionStore({ filePath: join(directory, 'sessions.json') }); await store.init();
  await store.requestTrigger('99999', 'subscription_auto'); await store.beginWork('99999');
  const plan = await store.prepareSubscriptionAutomation('99999', { contexts, autoResult, result: {} });
  const worker = new PrivateWorker({ store, subscriptionStore: subscriptions, oneBot: { sendPrivateMessage: () => assert.fail('chat must not send') }, automationClient: { execute: () => assert.fail('chat must not create calendar') }, mediaManager: { removeMessages: async () => {} } });
  await deliverSubscriptionAutomation(worker, '99999', plan);
  assert.equal(subscriptions.listSubscriptions()[0].state.pendingCount, 0);
  assert.equal(store.snapshot('99999').failedDelivery, null); assert.deepEqual(store.snapshot('99999').subscriptionAutomationPlans, []);
  assert.equal(subscriptions.noticeRolesForSource('54321').candidates.length, 0);
});
