import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('calendar settings and decisions require existing authenticated target scope', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const calls = [];
  class HttpError extends Error { constructor(statusCode, message) { super(message); this.statusCode = statusCode; } }
  const candidate = { id: 'A17', targetType: 'private', targetId: '12345' };
  const calendarFilter = { snapshot: () => ({ candidates: [candidate], settings: [] }),
    setSettings: async (...args) => { calls.push(args); return {}; },
    decide: async (...args) => { calls.push(args); return candidate; } };
  const handler = runInNewContext(`${source.slice(source.indexOf('async function handleApi('), source.indexOf('async function handleOneBotEvent('))}\n${source.slice(source.indexOf('function parseJson('), source.indexOf('function sendJson('))}\nhandleApi`, {
    process, console, HttpError, calendarFilter,
    subscriptionStore: { listSubscriptions: () => [{ id: 'sub1', targetType: 'private', targetId: '12345' }] },
    assertTarget: (type, id) => { if (type !== 'private' || id !== '12345') throw new HttpError(404, 'missing target'); },
    broadcast: () => {}, publicState: () => ({}), recordEvent: () => {},
    isAuthorized: req => req.headers.authorization === 'Bearer synthetic-test',
    readRawBody: async req => Buffer.from(JSON.stringify(req.body)),
    sendJson: (res, status, body) => Object.assign(res, { status, body })
  });
  async function request(method, path, body = {}, auth = true) { const res = {}; await handler({ method, body, headers: { authorization: auth ? 'Bearer synthetic-test' : '', 'content-type': 'application/json' } }, res, new URL(path, 'http://localhost')); return res; }
  assert.equal((await request('POST', '/api/calendar-filter/settings', {}, false)).status, 401);
  assert.equal((await request('GET', '/api/calendar-filter?targetType=private&targetId=12345')).status, 200);
  assert.equal((await request('POST', '/api/calendar-filter/settings', { subscriptionId: 'sub1', enabled: false })).status, 200);
  await assert.rejects(request('POST', '/api/calendar-filter/settings', { subscriptionId: 'missing' }), e => e.statusCode === 404);
  await assert.rejects(request('POST', '/api/calendar-filter/decision', { id: 'A17', decision: 'approve', targetType: 'group', targetId: '54321' }), e => e.statusCode === 404);
  assert.equal((await request('POST', '/api/calendar-filter/decision', { id: 'A17', decision: 'approve', targetType: 'private', targetId: '12345' })).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[0][1], 'subscriptionId'), false, 'routing ID must not be passed as a policy field');
});
