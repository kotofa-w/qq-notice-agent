import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const module = await import('../src/automation/calendar-filter.js').catch(() => ({}));
test('CalendarFilter is available', () => assert.equal(typeof module.CalendarFilter, 'function'));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'calendar-filter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date('2026-10-19T00:00:00Z');
  let enabled = true;
  const subscriptions = [{ id: 'sub', enabled: true, targetType: 'private', targetId: 'owner', sourceGroupId: 'source', updatedAt: 'v1' }];
  const calls = [];
  const subscriptionStore = {
    listSubscriptions: () => structuredClone(subscriptions),
    isSourceRecalled: () => false,
    isNoticeContextCurrent: () => true,
    isHistoryContextCurrent: () => true
  };
  const automationClient = {
    execute: async (action, options) => { calls.push({ action, options }); return { externalItemId: 'event', etag: '"v1"', contentHash: 'hash1' }; },
    delete: async (id, options) => { calls.push({ deleted: id, options }); return { deleted: true }; }
  };
  const options = { filePath: join(directory, 'ledger.json'), subscriptionStore, automationClient, clock: () => now, canWrite: async () => enabled };
  const filter = new module.CalendarFilter(options);
  await filter.init();
  const action = { type: 'calendar', actionId: 'a'.repeat(24), sourceGroupId: 'source', sourceMessageId: 'msg', normalizedTitle: '高数考试', title: '高数考试', start: '2026-10-20T01:00:00Z', end: null, allDay: false, sourceItemQuote: '高数考试', timeEvidence: { start: '2026年10月20日09:00', end: null, due: null }, notes: '' };
  const contexts = [{ subscriptionId: 'sub', targetType: 'private', targetId: 'owner', sourceGroupId: 'source', intakeMode: 'ALL', messages: [{ messageId: 'msg', text: '高数考试2026年10月20日09:00', timestamp: '2026-10-19T00:00:00Z' }] }];
  const stage = async (changes = {}, extra = {}) => filter.stage({ targetType: 'private', targetId: 'owner', plan: { id: 'plan', autoResult: { actions: [{ ...action, ...changes }] }, contexts, ...extra } });
  const notify = async ids => filter.markNotified(ids, { messageId: 'notice', sentAt: now.toISOString() });
  return { filter, options, subscriptions, subscriptionStore, automationClient, calls, action, contexts, stage, notify, setEnabled: value => { enabled = value; }, advance: minutes => { now = new Date(+now + minutes * 60000); } };
}

test('safe defaults and settings validation; course selection enables timeout auto', async t => {
  const f = await fixture(t);
  assert.equal(f.filter.getSettings('sub').timeoutPolicy, 'manual');
  await f.filter.setSettings('sub', { groupType: 'course' });
  assert.equal(f.filter.getSettings('sub').timeoutPolicy, 'auto');
  await assert.rejects(f.filter.setSettings('sub', { confirmationMinutes: 0 }));
  await assert.rejects(f.filter.setSettings('sub', { categories: ['unknown'] }));
});

test('only successful notice starts deadline, duplicate receipt never resets it', async t => {
  const f = await fixture(t);
  await f.filter.setSettings('sub', { groupType: 'course' });
  const { ids } = await f.stage();
  f.advance(11); await f.filter.tick(); assert.equal(f.calls.length, 0);
  await f.notify(ids);
  const deadline = f.filter.snapshot().candidates[0].notification.deadlineAt;
  f.advance(5); await f.notify(ids);
  assert.equal(f.filter.snapshot().candidates[0].notification.deadlineAt, deadline);
  await f.filter.tick(); assert.equal(f.calls.length, 0);
  f.advance(5); await f.filter.tick(); assert.equal(f.calls.length, 1);
  assert.equal(f.filter.snapshot().candidates[0].status, 'synced');
});

test('manual policy and voluntary/conditional activities never auto write', async t => {
  const f = await fixture(t);
  const { ids } = await f.stage(); await f.notify(ids); f.advance(11); await f.filter.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.filter.snapshot().candidates[0].status, 'manual');
  await f.filter.setSettings('sub', { groupType: 'course' });
  const voluntary = await f.stage({ actionId: 'b'.repeat(24), title: '自愿参加竞赛', normalizedTitle: '竞赛', notes: '有兴趣的同学可报名' });
  await f.notify(voluntary.ids); f.advance(11); await f.filter.tick(); assert.equal(f.calls.length, 0);
  assert.equal(f.filter.snapshot().candidates.find(item => item.id === ids[0]).status, 'manual');
});

test('invalid evidence cannot be approved into a write', async t => {
  const f = await fixture(t);
  const { ids } = await f.stage({ start: '2026-10-21T01:00:00Z' }); await f.notify(ids);
  await f.filter.decide(ids[0], 'approve'); await f.filter.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.filter.snapshot().candidates[0].writable, false);
});

test('rejected and cross-source forwarded duplicates remain suppressed after restart', async t => {
  const f = await fixture(t);
  const { ids } = await f.stage(); await f.notify(ids); await f.filter.decide(ids[0], 'reject');
  f.subscriptions.push({ ...f.subscriptions[0], id: 'sub2', sourceGroupId: 'source2' });
  const contexts = [{ ...f.contexts[0], subscriptionId: 'sub2', sourceGroupId: 'source2', messages: [{ ...f.contexts[0].messages[0], messageId: 'msg2' }] }];
  await f.stage({ sourceGroupId: 'source2', sourceMessageId: 'msg2', actionId: 'b'.repeat(24) }, { id: 'plan2', contexts });
  const restarted = new module.CalendarFilter(f.options); await restarted.init();
  assert.equal(restarted.snapshot().candidates.length, 1); assert.equal(restarted.snapshot().candidates[0].status, 'rejected');
  assert.deepEqual((await restarted.stage({ targetType: 'private', targetId: 'owner', plan: { id: 'plan', autoResult: { actions: [f.action] }, contexts: f.contexts } })).ids, []);
});

test('frozen subscription identity, source recalls and role context block writes', async t => {
  for (const change of [f => { f.subscriptions[0].updatedAt = 'v2'; }, f => { f.subscriptionStore.isSourceRecalled = () => true; }, f => { f.contexts[0].intakeMode = 'RESPONSIBLE_ONLY'; f.subscriptionStore.isNoticeContextCurrent = () => false; }]) {
    const f = await fixture(t); change(f);
    const { ids } = await f.stage(); await f.notify(ids);
    if (f.subscriptions[0].updatedAt === 'v2') f.subscriptions[0].updatedAt = 'v3';
    await f.filter.decide(ids[0], 'approve'); await f.filter.tick(); assert.equal(f.calls.length, 0);
  }
});

test('disabled writing pauses approval then revalidates after reenabled', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  f.setEnabled(false); await f.filter.decide(ids[0], 'approve'); await f.filter.tick();
  assert.equal(f.filter.snapshot().candidates[0].status, 'paused');
  f.setEnabled(true); await f.filter.tick(); assert.equal(f.calls.length, 1);
});

test('OWNER reply is scoped, ambiguous bare replies do nothing, and receipts are idempotent', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  const reply = { targetType: 'private', targetId: 'owner', ownerId: 'owner', senderId: 'other', text: `是 ${ids[0]}`, messageId: 'reply' };
  assert.equal((await f.filter.handleReply(reply)).handled, false);
  assert.equal((await f.filter.handleReply({ ...reply, senderId: 'owner', targetId: 'different' })).handled, false);
  const accepted = await f.filter.handleReply({ ...reply, senderId: 'owner' }); assert.equal(accepted.handled, true);
  await f.filter.handleReply({ ...reply, senderId: 'owner' }); await f.filter.tick(); assert.equal(f.calls.length, 1);
});

test('concurrent approval/tick uses one durable action; errors only retry on request', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  let count = 0;
  f.automationClient.execute = async () => { count++; throw new Error('network unavailable'); };
  await Promise.all([f.filter.decide(ids[0], 'approve'), f.filter.tick(), f.filter.tick()]);
  await f.filter.tick(); assert.equal(count, 1); assert.equal(f.filter.snapshot().candidates[0].status, 'failed');
  f.automationClient.execute = async action => { count++; assert.equal(action.actionId, f.action.actionId); return { etag: '"v1"', contentHash: 'hash1' }; };
  await f.filter.decide(ids[0], 'retry'); await f.filter.tick(); assert.equal(count, 2);
});

test('writing crash recovers using same actionId and never silently overwrites', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  const saved = JSON.parse(await readFile(f.options.filePath, 'utf8'));
  saved.candidates[0].status = 'writing'; await writeFile(f.options.filePath, JSON.stringify(saved));
  const restarted = new module.CalendarFilter(f.options); await restarted.init(); await restarted.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action.actionId, f.action.actionId); assert.equal(f.calls[0].options.protectExisting, true);
});

test('precise update reuses original actionId and baseline; rejecting synced event conditionally cancels', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  await f.filter.decide(ids[0], 'approve'); await f.filter.tick();
  const updated = await f.stage({ operation: 'update', relatedCandidateId: ids[0], actionId: 'b'.repeat(24), notes: '更正地点', location: 'A101' }, { id: 'update' });
  await f.notify(updated.ids); await f.filter.decide(updated.ids[0], 'approve'); await f.filter.tick();
  assert.equal(f.calls[1].action.actionId, f.action.actionId); assert.equal(f.calls[1].options.expectedEtag, '"v1"');
  await f.filter.decide(updated.ids[0], 'reject'); await f.filter.tick();
  assert.equal(f.calls[2].deleted, f.action.actionId); assert.equal(f.filter.snapshot().candidates.find(c => c.id === updated.ids[0]).status, 'cancelled');
});

test('multiple candidates and a shared quoted notification require an explicit ID', async t => {
  const f = await fixture(t);
  const first = await f.stage();
  const second = await f.stage({ title: '另一门考试', normalizedTitle: '另一门考试', actionId: 'b'.repeat(24) }, { id: 'plan2' });
  await f.notify([...first.ids, ...second.ids]);
  const reply = { targetType: 'private', targetId: 'owner', senderId: 'owner', ownerId: 'owner', text: '是' };
  assert.match((await f.filter.handleReply(reply)).reply, /多个/);
  assert.match((await f.filter.handleReply({ ...reply, replyToMessageId: 'notice' })).reply, /多个/);
  await f.filter.tick(); assert.equal(f.calls.length, 0);
  assert.equal(f.filter.contextFor('private', 'another', 'source').length, 0);
});

test('policy disabling pauses pending candidates and source mutation while paused invalidates them', async t => {
  const f = await fixture(t); await f.filter.setSettings('sub', { groupType: 'course' });
  const { ids } = await f.stage(); await f.notify(ids);
  await f.filter.setSettings('sub', { enabled: false }); f.advance(11); await f.filter.tick();
  assert.equal(f.filter.snapshot().candidates[0].status, 'paused'); assert.equal(f.calls.length, 0);
  f.subscriptions[0].sourceGroupId = 'different';
  await f.filter.setSettings('sub', { enabled: true }); await f.filter.tick();
  assert.equal(f.filter.snapshot().candidates[0].status, 'skipped'); assert.equal(f.calls.length, 0);
});

test('cancel needs exact related source and actual cancellation evidence', async t => {
  const f = await fixture(t); const first = await f.stage(); await f.notify(first.ids);
  await f.filter.decide(first.ids[0], 'approve'); await f.filter.tick();
  const bad = await f.stage({ operation: 'cancel', relatedCandidateId: first.ids[0] }, { id: 'badcancel' });
  await f.notify(bad.ids); await f.filter.decide(bad.ids[0], 'approve'); await f.filter.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.filter.snapshot().candidates.find(item => item.id === bad.ids[0]).writable, false);
  f.contexts[0].messages[0] = { ...f.contexts[0].messages[0], messageId: 'cancelmsg', text: '高数考试取消' };
  const cancellation = await f.stage({ operation: 'cancel', relatedCandidateId: first.ids[0], sourceMessageId: 'cancelmsg', sourceItemQuote: '高数考试取消', start: null, timeEvidence: {} }, { id: 'cancel' });
  await f.notify(cancellation.ids); f.advance(11); await f.filter.tick(); assert.equal(f.calls.length, 1);
  await f.filter.decide(cancellation.ids[0], 'approve'); await f.filter.tick();
  assert.equal(f.calls[1].deleted, f.action.actionId);
});

test('external conflicts remain retryable and do not leak raw errors into snapshots', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  f.automationClient.execute = async () => { const error = new Error('secret=private-token'); error.code = 'CALDAV_CONFLICT'; throw error; };
  await f.filter.decide(ids[0], 'approve'); await f.filter.tick();
  assert.equal(f.filter.snapshot().candidates[0].status, 'conflict');
  assert.doesNotMatch(JSON.stringify(f.filter.snapshot()), /private-token/);
  assert.equal('contexts' in f.filter.snapshot().candidates[0], false);
});

test('expired items and summary-only historical recovery never write even when confirmed', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids); f.advance(1501);
  await f.filter.decide(ids[0], 'approve'); await f.filter.tick(); assert.equal(f.filter.snapshot().candidates[0].status, 'expired');
  const other = await fixture(t);
  other.contexts[0].historyRecovery = { allowFutureActions: false, subscriptionUpdatedAt: 'v1' };
  const candidate = await other.stage(); await other.notify(candidate.ids);
  await other.filter.decide(candidate.ids[0], 'approve'); await other.filter.tick(); assert.equal(other.calls.length, 0);
});

test('gate changing during durable write preparation prevents external effects', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  const save = f.filter._save.bind(f.filter);
  f.filter._save = async () => {
    await save();
    if (f.filter.snapshot().candidates[0].status === 'writing') f.setEnabled(false);
  };
  await f.filter.decide(ids[0], 'approve');
  await f.filter.tick(); assert.equal(f.calls.length, 0); assert.equal(f.filter.snapshot().candidates[0].status, 'paused');
});

test('unknown committed writing is reconciled after event expiry instead of losing its external link', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  const saved = JSON.parse(await readFile(f.options.filePath, 'utf8'));
  saved.candidates[0].status = 'writing'; await writeFile(f.options.filePath, JSON.stringify(saved));
  f.advance(1501);
  f.automationClient.read = async () => ({ exists: true, owned: true, etag: '"v1"', contentHash: 'hash1' });
  const restarted = new module.CalendarFilter(f.options); await restarted.init(); await restarted.tick();
  assert.equal(restarted.snapshot().candidates[0].status, 'synced'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.existingOnly, true);
});

test('unknown writing with no external event does not create an expired event', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  const saved = JSON.parse(await readFile(f.options.filePath, 'utf8'));
  saved.candidates[0].status = 'writing'; await writeFile(f.options.filePath, JSON.stringify(saved)); f.advance(1501);
  f.automationClient.read = async () => ({ exists: false });
  const restarted = new module.CalendarFilter(f.options); await restarted.init(); await restarted.tick();
  assert.equal(restarted.snapshot().candidates[0].status, 'expired'); assert.equal(f.calls.length, 0);
});

test('candidate policies and notification duration are frozen across settings changes and restart', async t => {
  const f = await fixture(t); await f.filter.setSettings('sub', { groupType: 'course' });
  const { ids } = await f.stage(); await f.filter.setSettings('sub', { groupType: 'other', timeoutPolicy: 'manual', categories: [], confirmationMinutes: 60 });
  await f.notify(ids);
  assert.equal(f.filter.snapshot().candidates[0].notification.deadlineAt, '2026-10-19T00:10:00.000Z');
  f.advance(11); const restarted = new module.CalendarFilter(f.options); await restarted.init(); await restarted.tick();
  assert.equal(restarted.snapshot().candidates[0].status, 'synced');
});

test('an explicit stop-class notice can cancel its precisely related synced class', async t => {
  const f = await fixture(t);
  f.contexts[0].messages[0].text = '高数实验课2026年10月20日09:00';
  const original = await f.stage({ title: '高数实验课', normalizedTitle: '高数实验课', sourceItemQuote: '高数实验课' });
  await f.notify(original.ids); await f.filter.decide(original.ids[0], 'approve'); await f.filter.tick();
  f.contexts[0].messages[0] = { ...f.contexts[0].messages[0], messageId: 'cancelmsg', text: '明天高数实验课停课' };
  const cancellation = await f.stage({ title: '高数实验课', normalizedTitle: '高数实验课', operation: 'cancel', relatedCandidateId: original.ids[0], sourceMessageId: 'cancelmsg', sourceItemQuote: '明天高数实验课停课', start: null, timeEvidence: {} }, { id: 'cancel' });
  await f.notify(cancellation.ids); await f.filter.decide(cancellation.ids[0], 'approve'); await f.filter.tick();
  assert.equal(f.calls[1]?.deleted, f.action.actionId);
});

test('a timed-out but committed write can be reconciled by retry after its start', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  const execute = f.automationClient.execute;
  f.automationClient.execute = async () => { throw new Error('CalDAV request timed out'); };
  await f.filter.decide(ids[0], 'approve'); await f.filter.tick();
  assert.equal(f.filter.snapshot().candidates[0].status, 'failed');
  f.advance(1501);
  f.automationClient.read = async () => ({ exists: true, owned: true, etag: '"committed"', contentHash: 'hash1' });
  f.automationClient.execute = execute;
  await f.filter.decide(ids[0], 'retry'); await f.filter.tick();
  assert.equal(f.filter.snapshot().candidates[0].status, 'synced'); assert.equal(f.calls[0].options.existingOnly, true);
});

test('an explicit approval returns the actual written result immediately', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  assert.equal((await f.filter.decide(ids[0], 'approve')).status, 'synced'); assert.equal(f.calls.length, 1);
  const reply = await f.filter.handleReply({ targetType: 'private', targetId: 'owner', ownerId: 'owner', senderId: 'owner', text: `否 ${ids[0]}`, messageId: 'cancelreply' });
  assert.match(reply.reply, /已撤销/); assert.equal(f.calls[1].deleted, f.action.actionId);
});

test('rejecting an unknown committed write reconciles identical content then conditionally deletes it', async t => {
  const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
  const execute = f.automationClient.execute;
  f.automationClient.execute = async () => { throw new Error('CalDAV request timed out'); };
  await f.filter.decide(ids[0], 'approve');
  f.automationClient.read = async () => ({ exists: true, owned: true });
  f.automationClient.execute = execute;
  const result = await f.filter.decide(ids[0], 'reject');
  assert.equal(result.status, 'cancelled'); assert.equal(f.calls[0].options.existingOnly, true);
  assert.equal(f.calls[1].deleted, f.action.actionId); assert.equal(f.calls[1].options.expectedEtag, '"v1"');
});

test('rejecting unknown writes never creates an absent event, deletes conflicts, or bypasses disabled gates', async t => {
  for (const mode of ['missing', 'conflict', 'paused']) {
    const f = await fixture(t); const { ids } = await f.stage(); await f.notify(ids);
    f.automationClient.execute = async () => { throw new Error('CalDAV request timed out'); };
    await f.filter.decide(ids[0], 'approve');
    f.automationClient.read = async () => ({ exists: mode !== 'missing', owned: true });
    f.automationClient.execute = async (action, options) => {
      assert.equal(options.existingOnly, true); assert.equal(options.expectedEtag, undefined);
      const error = new Error('different content'); error.code = 'CALDAV_CONFLICT'; throw error;
    };
    if (mode === 'paused') f.setEnabled(false);
    const result = await f.filter.decide(ids[0], 'reject');
    assert.equal(result.status, { missing: 'rejected', conflict: 'conflict', paused: 'paused' }[mode]);
    assert.equal(f.calls.length, 0);
  }
});
