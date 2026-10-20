import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('QQ calendar decisions use the real sender and target before normal chat dispatch', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleCalendarReply(');
  assert.notEqual(start, -1);
  const calls = []; const sends = [];
  const handler = runInNewContext(source.slice(start, source.indexOf('async function handleMessageRecall(', start)) + '\nhandleCalendarReply', {
    OWNER_QQ_ID: '99887', calendarFilter: { handleReply: async message => { calls.push(message); return { handled: true, reply: '已拒绝' }; } },
    oneBot: { sendPrivateMessage: async (...args) => { sends.push(args); return { ok: true }; }, sendGroupMessage: async (...args) => { sends.push(args); return { ok: true }; } },
    broadcast: () => {}, publicState: () => ({})
  });
  assert.equal(await handler({ senderId: '11111', groupId: '54321', text: '是' }, 'group'), null);
  const result = await handler({ senderId: '99887', groupId: '54321', text: '否 C1', messageId: 'm1', replyToMessageId: '77' }, 'group');
  assert.equal(result.status, 'calendar-confirmation'); assert.equal(calls[0].targetId, '54321');
  assert.equal(calls[0].senderId, '99887'); assert.equal(calls[0].replyToMessageId, '77'); assert.equal(sends.length, 1);
  assert.match(source, /if \(!isSource\).*handleCalendarReply/s);
  assert.match(source, /handleCalendarReply\(message, 'private'\)/);
});
