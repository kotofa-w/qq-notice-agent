import assert from 'node:assert/strict';
import test from 'node:test';
import { CaldavActionClient } from '../src/automation/caldav-actions.js';

const action = { actionId: '0123456789abcdef01234567', type: 'calendar', title: '开会', calendarName: '学习', start: '2026-10-20T09:00:00+08:00', end: null, allDay: false };
function fixture({ omitWriteEtag = false, deleteRace = false, reorderProperties = false } = {}) {
  let body = null; let revision = 0; const calls = [];
  const client = new CaldavActionClient({ calendarUrl: 'https://dav.example.test/calendar/', username: 'user', password: 'secret', fetchImpl: async (_url, options) => {
    calls.push(options);
    const etag = `"${revision}"`;
    if (options.method === 'GET') return new Response(body, { status: body ? 200 : 404, headers: body ? { ETag: etag } : {} });
    if (options.headers['If-None-Match'] && body) return new Response(null, { status: 412 });
    if (options.headers['If-Match'] && options.headers['If-Match'] !== etag) return new Response(null, { status: 412 });
    if (options.method === 'DELETE') {
      if (deleteRace) return new Response(null, { status: 412 });
      body = null; revision++; return new Response(null, { status: 204 });
    }
    const status = body ? 204 : 201;
    body = options.body;
    if (reorderProperties) body = body.replace(/(VERSION:[^\r]+\r\n)(PRODID:[^\r]+\r\n)/, '$2$1');
    revision++;
    return new Response(null, { status, headers: omitWriteEtag ? {} : { ETag: `"${revision}"` } });
  } });
  return { client, calls, mutate: transform => { body = transform(body); revision++; }, edit: () => { body = body.replace('SUMMARY:开会', 'SUMMARY:手动更改'); revision++; }, remove: () => { body = null; revision++; }, foreign: () => { body = body.replace('X-CODEX-REMOTE-CONTACT-ACTION-ID:', 'X-OTHER:'); revision++; } };
}

test('read exposes only a fixed owned resource version and missing is explicit', async () => {
  const { client } = fixture();
  assert.equal((await client.read(action.actionId)).exists, false);
  const created = await client.execute(action, { protectExisting: true });
  const read = await client.read(action.actionId);
  assert.equal(read.exists, true); assert.equal(read.owned, true);
  assert.equal(created.etag, read.etag); assert.equal(created.contentHash, read.contentHash);
  assert.match(read.contentHash, /^[a-f0-9]{64}$/);
  await assert.rejects(client.read('../elsewhere'), /actionId/);
});

test('protected create recovers identical content but refuses unrelated existing content', async () => {
  const { client, calls } = fixture({ omitWriteEtag: true });
  const first = await client.execute(action, { protectExisting: true });
  assert.equal(calls.at(-1).method, 'GET'); assert.equal(first.etag, '"1"');
  assert.equal((await client.execute(action, { protectExisting: true })).etag, first.etag);
  await assert.rejects(client.execute({ ...action, title: '改期' }, { protectExisting: true }), /baseline|modified|version/i);
  assert.equal((await client.read(action.actionId)).etag, first.etag);
});

test('update and delete protect the last written version against prior manual edits', async () => {
  const { client, calls, edit } = fixture();
  const first = await client.execute(action, { protectExisting: true });
  const updated = await client.execute({ ...action, notes: '修改说明' }, { expectedEtag: first.etag, expectedContentHash: first.contentHash });
  assert.notEqual(updated.etag, first.etag);
  edit();
  await assert.rejects(client.execute({ ...action, title: '改期' }, { expectedEtag: updated.etag, expectedContentHash: updated.contentHash }), /modified|version/i);
  await assert.rejects(client.delete(action.actionId, { expectedEtag: updated.etag, expectedContentHash: updated.contentHash }), /modified|version/i);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});

test('delete requires a trusted baseline, uses If-Match and is idempotent on 404', async () => {
  const { client, calls } = fixture();
  const created = await client.execute(action, { protectExisting: true });
  await assert.rejects(client.delete(action.actionId), /baseline/i);
  const deleted = await client.delete(action.actionId, { expectedEtag: created.etag, expectedContentHash: created.contentHash });
  assert.equal(deleted.deleted, true);
  assert.equal(calls.find(call => call.method === 'DELETE').headers['If-Match'], created.etag);
  assert.equal((await client.delete(action.actionId)).deleted, true);
});

test('unknown successful update can recover the desired version with the previous baseline', async () => {
  const { client } = fixture();
  const first = await client.execute(action, { protectExisting: true });
  const baseline = { expectedEtag: first.etag, expectedContentHash: first.contentHash, protectExisting: true };
  const changed = { ...action, title: '改期' };
  const updated = await client.execute(changed, baseline);
  assert.equal((await client.execute(changed, baseline)).etag, updated.etag);
});

test('an externally removed event is not recreated by a baselined update', async () => {
  const { client, calls, remove } = fixture();
  const first = await client.execute(action, { protectExisting: true });
  remove(); const before = calls.length;
  await assert.rejects(client.execute({ ...action, title: '改期' }, { expectedEtag: first.etag }), { code: 'CALDAV_CONFLICT' });
  assert.deepEqual(calls.slice(before).map(call => call.method), ['GET']);
});

test('delete refuses foreign ownership and does not retry an ETag race', async () => {
  const fixtureOne = fixture();
  const first = await fixtureOne.client.execute(action, { protectExisting: true });
  fixtureOne.foreign();
  assert.equal((await fixtureOne.client.read(action.actionId)).owned, false);
  await assert.rejects(fixtureOne.client.delete(action.actionId, { expectedEtag: first.etag }), /ownership/);
  assert.equal(fixtureOne.calls.some(call => call.method === 'DELETE'), false);
  const raced = fixture({ deleteRace: true });
  const version = await raced.client.execute(action, { protectExisting: true });
  await assert.rejects(raced.client.delete(action.actionId, { expectedContentHash: version.contentHash }), { code: 'CALDAV_CONFLICT' });
  assert.equal(raced.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('a server property reorder without PUT ETag preserves the verified written version and retry', async () => {
  const { client, calls } = fixture({ omitWriteEtag: true, reorderProperties: true });
  const created = await client.execute(action, { protectExisting: true });
  assert.equal(created.etag, '"1"');
  assert.equal(created.contentHash, (await client.read(action.actionId)).contentHash);
  const repeated = await client.execute(action, { protectExisting: true });
  assert.equal(repeated.contentHash, created.contentHash);
  assert.equal(calls.filter(call => call.method === 'PUT' && call.headers['If-Match']).length, 0);
});

test('canonical versions preserve component boundaries, duplicate properties and values', async () => {
  for (const change of [
    body => body.replace('VERSION:2.0', 'VERSION:2.0\r\nVERSION:2.0'),
    body => body.replace('VERSION:2.0', 'VERSION:1.0'),
    body => body.replace('SUMMARY:开会\r\n', '').replace('BEGIN:VALARM\r\n', 'BEGIN:VALARM\r\nSUMMARY:开会\r\n')
  ]) {
    const { client, mutate } = fixture();
    const created = await client.execute(action, { protectExisting: true });
    mutate(change);
    const current = await client.read(action.actionId);
    assert.notEqual(current.contentHash, created.contentHash);
    await assert.rejects(client.execute(action, { protectExisting: true }), { code: 'CALDAV_CONFLICT' });
  }
});

test('existingOnly recovery never recreates an event deleted between reads', async () => {
  const { client, calls, remove } = fixture();
  await client.execute(action, { protectExisting: true });
  assert.equal((await client.read(action.actionId)).exists, true);
  remove(); const before = calls.length;
  await assert.rejects(client.execute(action, { protectExisting: true, existingOnly: true }), { code: 'CALDAV_CONFLICT' });
  assert.deepEqual(calls.slice(before).map(call => call.method), ['GET']);
});
