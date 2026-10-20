import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAutoSubscriptionResult, buildAutoSubscriptionPrompt } from '../src/security/subscription-policy.js';

const context = text => [{ sourceGroupId: '54321', calendarItems: [{ id: 'A17', title: '实验课', status: 'synced' }], messages: [{ messageId: 'm1', text, timestamp: '2026-10-19T04:00:00Z' }] }];
function parse(action, text) { return parseAutoSubscriptionResult(JSON.stringify({ notify: true, reply: '', actions: [action] }), context(text), { targetType: 'private', targetId: '12345' }); }
const action = overrides => ({ sourceGroupId: '54321', sourceMessageId: 'm1', sourceItemQuote: '实验课', type: 'calendar', title: '实验课', calendarName: '学习', start: null, timeEvidence: { start: null, end: null, due: null }, ...overrides });
test('uncertain source-backed date survives as a non-writable candidate instead of a guessed calendar write', () => {
  const result = parse(action({}), '实验课下周举行，具体时间另行通知');
  assert.equal(result.actions.length, 0); assert.equal(result.uncertainActions.length, 1);
  assert.equal(result.uncertainActions[0].writable, false); assert.match(result.reply, /时间未明确/);
});
test('cancel requires actual cancellation source and a known precise candidate reference', () => {
  const cancellation = action({ operation: 'cancel', relatedCandidateId: 'A17', sourceItemQuote: '实验课取消' });
  assert.equal(parse(cancellation, '实验课取消').actions[0].operation, 'cancel');
  assert.equal(parse({ ...cancellation, relatedCandidateId: 'missing' }, '实验课取消').actions.length, 0);
  assert.equal(parse({ ...cancellation, sourceItemQuote: '实验课' }, '实验课照常').actions.length, 0);
  assert.match(buildAutoSubscriptionPrompt(context('实验课取消')), /A17/);
});
