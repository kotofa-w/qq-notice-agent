import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/storage/session-store.js';
import { PrivateWorker } from '../src/qq/private-worker.js';
import { GroupWorker } from '../src/groups/group-worker.js';

for (const targetType of ['private', 'group']) test(`${targetType} partial automation survives restart, retries only failure, and does not repeat summary`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'sessions.json');
  let store = new SessionStore({ filePath }); await store.init();
  await store.requestTrigger('12345', 'subscription_auto');
  let work = await store.beginWork('12345');
  const actions = ['A', 'B'].map(title => ({ actionId: title, type: 'calendar', title, sourceGroupId: '54321', sourceMessageId: title, sourceItemQuote: title, timeEvidence: { start: '2026年10月18日12时', end: null, due: null }, start: '2026-10-18T12:00:00+08:00' }));
  const plan = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '事实摘要', actions }, contexts: [], result: { turnId: 'first' } });
  const calls = []; const sent = []; let fail = true;
  const workerFor = () => new (targetType === 'private' ? PrivateWorker : GroupWorker)({
    store, codex: { startThread() { assert.fail('must reuse frozen decision'); } },
    automationClient: { async execute(action) { calls.push(action.actionId); if (action.actionId === 'B' && fail) throw Error('offline'); return { externalItemId: action.actionId }; } },
    oneBot: { async sendPrivateMessage(id, text) { sent.push(text); return { ok: true }; }, async sendGroupMessage(id, text) { sent.push(text); return { ok: true }; } },
    mediaManager: { removeMessages: async () => {} }, triggerManager: { reconsiderPending: async () => {} }
  });
  await workerFor().runAgent('12345', { ...work, automationPlan: plan });
  assert.deepEqual(calls, ['A', 'B']); assert.equal(sent.length, 1);
  assert.match(sent[0], /事实摘要/); assert.match(sent[0], /未写入.*B/); assert.match(sent[0], /重试/);
  assert.equal(store.snapshot('12345').subscriptionAutomationPlans[0].status, 'awaitingRetry');
  store = new SessionStore({ filePath }); await store.init();
  assert.equal(await store.beginWork('12345'), null, 'failed actions wait for explicit retry');
  assert.equal(await store.retrySubscriptionAutomations('12345'), 1);
  await store.requestTrigger('12345', 'subscription_auto'); work = await store.beginWork('12345');
  fail = false; await workerFor().runAgent('12345', work);
  assert.deepEqual(calls, ['A', 'B', 'B']); assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[1], /事实摘要|：A/); assert.match(sent[1], /B/);
  assert.equal(store.snapshot('12345').subscriptionAutomationPlans.length, 0);
});

test('persisted decision resumes unfinished actions after crash and rechecks calendar switch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-switch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'sessions.json'); let store = new SessionStore({ filePath }); await store.init();
  await store.requestTrigger('12345', 'subscription_auto'); await store.beginWork('12345');
  await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '摘要', actions: [{ actionId: 'A', type: 'calendar', title: 'A' }, { actionId: 'B', type: 'calendar', title: 'B' }] }, contexts: [], result: {} });
  await store.recordSubscriptionAutomationResult('12345', store.snapshot('12345').subscriptionAutomationPlans[0].id, 0, { status: 'succeeded', result: { externalItemId: 'existing' } });
  store = new SessionStore({ filePath }); await store.init(); const work = await store.beginWork('12345');
  await store.setCodexConfig('12345', { calendarRemindersEnabled: false }); const sent = [];
  const worker = new PrivateWorker({ store, codex: {}, automationClient: { execute: () => assert.fail('switch is off') },
    oneBot: { sendPrivateMessage: async (id, text) => { sent.push(text); return { ok: true }; } }, mediaManager: { removeMessages: async () => {} } });
  await worker.runAgent('12345', work);
  assert.equal(sent.length, 1); assert.match(sent[0], /未写入.*B/); assert.match(sent[0], /已同步.*A/);
});

test('failed QQ delivery resumes prepared text without executing calendar again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-qq-retry-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'sessions.json'); let store = new SessionStore({ filePath }); await store.init();
  await store.requestTrigger('12345', 'subscription_auto'); const work = await store.beginWork('12345');
  const plan = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '摘要', actions: [{ actionId: 'A', title: 'A', type: 'calendar' }] }, contexts: [], result: {} });
  let executions = 0;
  let worker = new PrivateWorker({ store, codex: {}, automationClient: { execute: async () => { executions++; return {}; } }, oneBot: { sendPrivateMessage: async () => ({ ok: false, status: 503 }) }, mediaManager: { removeMessages: async () => {} } });
  let failure; try { await worker.runAgent('12345', { ...work, automationPlan: plan }); } catch (error) { failure = error; }
  assert.match(failure.message, /503/); await store.failWork('12345', failure, { delivery: failure.delivery });
  store = new SessionStore({ filePath }); await store.init(); await store.requestTrigger('12345', 'retry'); const retry = await store.beginWork('12345');
  assert.equal(retry.kind, 'delivery'); const sends = [];
  worker = new PrivateWorker({ store, automationClient: { execute: () => assert.fail('must not rerun action') }, oneBot: { sendPrivateMessage: async (id, text) => { sends.push(text); return { ok: true }; } }, mediaManager: { removeMessages: async () => {} } });
  await worker.retryDelivery('12345', retry); assert.equal(executions, 1); assert.equal(sends.length, 1); assert.equal(store.snapshot('12345').subscriptionAutomationPlans.length, 0);
});

test('dispatch switch stops writes and QQ delivery while preserving the frozen plan', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-dispatch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(directory, 'sessions.json') }); await store.init(); await store.requestTrigger('12345', 'subscription_auto'); const work = await store.beginWork('12345');
  const plan = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '摘要', actions: [{ actionId: 'A' }] }, contexts: [], result: {} });
  const worker = new PrivateWorker({ store, canRun: () => false, automationClient: { execute: () => assert.fail('dispatch off') }, oneBot: { sendPrivateMessage: () => assert.fail('dispatch off') } });
  await assert.rejects(worker.runAgent('12345', { ...work, automationPlan: plan }), { code: 'REPLY_DISABLED' });
  assert.equal(store.snapshot('12345').subscriptionAutomationPlans[0].status, 'ready');
});

test('failed old plan does not overwrite or block a fresh subscription decision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-new-source-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(directory, 'sessions.json') }); await store.init(); await store.requestTrigger('12345', 'subscription_auto'); let work = await store.beginWork('12345');
  const old = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '旧摘要', actions: [{ actionId: 'A' }] }, contexts: [], result: {} });
  const worker = new PrivateWorker({ store, automationClient: { execute: async () => { throw Error('offline'); } }, oneBot: { sendPrivateMessage: async () => ({ ok: true }) }, mediaManager: { removeMessages: async () => {} } });
  await worker.runAgent('12345', { ...work, automationPlan: old });
  await store.requestTrigger('12345', 'subscription_auto'); work = await store.beginWork('12345'); assert.equal(work.automationPlan, null);
  const fresh = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '新摘要', actions: [] }, contexts: [], result: {} });
  assert.notEqual(fresh.id, old.id); assert.equal(store.snapshot('12345').subscriptionAutomationPlans.length, 2);
});

test('recalled frozen source prevents retry writes and removes the stale decision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-plan-recall-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(directory, 'sessions.json') }); await store.init(); await store.requestTrigger('12345', 'subscription_auto'); const work = await store.beginWork('12345');
  const plan = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '摘要', actions: [{ actionId: 'A' }] }, contexts: [{ sourceGroupId: '54321', messages: [{ messageId: '1' }] }], result: {} });
  const worker = new PrivateWorker({ store, subscriptionStore: { isSourceRecalled: () => true, releaseClaims: async () => {} }, automationClient: { execute: () => assert.fail('source recalled') } });
  await assert.rejects(worker.runAgent('12345', { ...work, automationPlan: plan }), { code: 'RECALLED_INPUT' }); assert.equal(store.snapshot('12345').subscriptionAutomationPlans.length, 0);
});

test('session save can recover after one filesystem failure', async t => {
  const { mkdir, readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'session-save-retry-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'sessions.json'); const store = new SessionStore({ filePath }); await store.init();
  await rm(filePath); await mkdir(filePath); await assert.rejects(store.save()); await rm(filePath, { recursive: true });
  await store.save(); assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 4);
});

test('recall before recovered QQ summary also cancels an already executed plan', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-recall-summary-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(directory, 'sessions.json') }); await store.init(); await store.requestTrigger('12345', 'subscription_auto'); const work = await store.beginWork('12345');
  let plan = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '已撤回摘要', actions: [{ actionId: 'A', title: 'A' }] }, contexts: [{ sourceGroupId: '54321', messages: [{ messageId: '1' }] }], result: {} });
  plan = await store.recordSubscriptionAutomationResult('12345', plan.id, 0, { status: 'succeeded', result: {} });
  const worker = new PrivateWorker({ store, subscriptionStore: { isSourceRecalled: () => true, releaseClaims: async () => {} }, oneBot: { sendPrivateMessage: async () => { throw Error('must not send recalled summary'); } } });
  await assert.rejects(worker.runAgent('12345', { ...work, automationPlan: plan }), { code: 'RECALLED_INPUT' });
});

for (const targetType of ['private', 'group']) test(`${targetType} recalled source cancels persisted QQ delivery on owner retry and releases unconsumed claims`, async t => {
  const { SubscriptionStore } = await import('../src/storage/subscription-store.js');
  const directory = await mkdtemp(join(tmpdir(), 'subscription-prepared-recall-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'sessions.json');
  let store = new SessionStore({ filePath }); await store.init();
  let now = new Date('2026-10-16T04:00:00Z');
  const subscriptions = new SubscriptionStore({ filePath: join(directory, 'subscriptions.json'), clock: () => now });
  await subscriptions.init();
  await subscriptions.upsertSubscription({ targetType, targetId: '12345', sourceGroupId: '54321', intakeMode: 'ALL', collectionDelayMinutes: 1 });
  for (const messageId of ['source-1', 'source-2']) await subscriptions.appendSourceMessage({ groupId: '54321', messageId, senderId: '99887', senderRole: 'admin', text: messageId, timestamp: now.toISOString(), images: [] });
  now = new Date(subscriptions.listSubscriptions()[0].state.collectionDeadline);
  const contexts = await subscriptions.claimForTarget(targetType, '12345', { mode: 'AUTO' });
  await store.appendMessage({ groupId: '12345', messageId: 'target-original', senderId: '99887', trust: 'OWNER', text: '保留这条待回复消息', timestamp: now.toISOString() });
  await store.requestTrigger('12345', 'subscription_auto');
  const work = await store.beginWork('12345');
  const plan = await store.prepareSubscriptionAutomation('12345', { autoResult: { reply: '将被撤回的旧摘要', actions: [{ actionId: 'A', type: 'calendar', title: 'A', sourceGroupId: '54321', sourceMessageId: 'source-1' }] }, contexts, result: {} });
  let executions = 0; let sends = 0;
  const Worker = targetType === 'private' ? PrivateWorker : GroupWorker;
  const workerFor = () => new Worker({ store, subscriptionStore: subscriptions,
    codex: { startThread: () => assert.fail('retry must not rerun model') },
    automationClient: { execute: async () => { executions++; return { externalItemId: 'existing-event' }; } },
    oneBot: { sendPrivateMessage: async () => ({ ok: ++sends > 1, status: 503 }), sendGroupMessage: async () => ({ ok: ++sends > 1, status: 503 }) },
    mediaManager: { removeMessages: async () => {} },
    triggerManager: { request: (...args) => store.requestTrigger(...args), reconsiderPending: async () => {} }
  });
  let failure; try { await workerFor().runAgent('12345', { ...work, automationPlan: plan }); } catch (error) { failure = error; }
  assert.match(failure.message, /503/);
  await store.failWork('12345', failure, { delivery: failure.delivery });
  assert.equal(store.snapshot('12345').failedDelivery.textSent, false);
  store = new SessionStore({ filePath }); await store.init();
  await subscriptions.recallSourceMessage('54321', 'source-1');
  const command = await store.appendMessage({ groupId: '12345', messageId: 'owner-retry', senderId: '99887', trust: 'OWNER', text: '/重试', timestamp: now.toISOString() });
  await store.requestTrigger('12345', 'control', command);
  await workerFor().kick('12345');
  assert.equal(sends, 1, 'owner retry must not send the withdrawn prepared summary');
  assert.equal(executions, 1, 'the existing calendar event is never written again');
  const session = store.snapshot('12345');
  assert.equal(session.failedDelivery, null); assert.deepEqual(session.subscriptionAutomationPlans, []);
  assert.equal(session.busy, false); assert.equal(session.processing, null); assert.equal(session.lastError, null);
  assert.deepEqual(session.pendingMessages.map(message => message.messageId), ['target-original']);
  const subscription = subscriptions.listSubscriptions()[0];
  assert.equal(subscription.state.processingUntilMessageId, null);
  assert.equal(subscriptions.snapshot().subscriptions[subscription.id].state.lastConsumedSequence, 0, 'cancelled summary must not consume the other source notice');
  assert.deepEqual(subscription.state.pendingMessages.map(message => message.messageId), ['source-2']);
  const fresh = await subscriptions.claimForTarget(targetType, '12345', { mode: 'AUTO' });
  assert.deepEqual(fresh[0].messages.map(message => message.messageId), ['source-2'], 'remaining notice has a fresh processing entry');
});
