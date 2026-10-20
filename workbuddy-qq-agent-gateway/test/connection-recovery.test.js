import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore } from '../src/storage/subscription-store.js';
import { HistoryRecovery } from '../src/qq/history-recovery.js';
import { ConnectionRecovery } from '../src/qq/connection-recovery.js';
import { OneBotClient } from '../src/qq/onebot-client.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'connection-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = new Date('2026-10-20T02:00:00Z');
  const clock = () => now;
  const options = { filePath: join(dir, 'subscriptions.json'), accountId: '12345', clock };
  const store = new SubscriptionStore(options); await store.init();
  const sub = (await store.upsertSubscription({ targetType: 'private', targetId: '77777', sourceGroupId: '54321' })).subscription;
  now = new Date('2026-10-20T03:00:00Z');
  let online = true, reads = 0;
  const reader = { async readPage() {
    reads++;
    return { entries: [{ message: { accountId: '12345', groupId: '54321', messageId: 'old', realSeq: '10', senderId: '88888',
      timestamp: '2026-10-20T03:05:00Z', text: '明天交材料' }, payload: {} }],
    warnings: [], nextCursor: 'old', oldestAt: '2026-10-20T01:00:00Z', empty: false };
  } };
  const recovery = new HistoryRecovery({ store, reader, accountId: '12345', clock });
  const probe = async () => ({ ok: online, state: online ? 'online' : 'offline' });
  const make = (targetStore = store, targetRecovery = recovery) => new ConnectionRecovery({ store: targetStore, recovery: targetRecovery, accountId: '12345', probe, clock });
  return { store, sub, recovery, options, clock, reader, make, setTime: value => { now = new Date(value); }, setOnline: value => { online = value; }, reads: () => reads };
}

test('confirmed outage persists, merges repeated failures and recovers to preview only with bounded overlap', async t => {
  const h = await setup(t), monitor = h.make();
  await monitor.tick();
  h.setTime('2026-10-20T03:04:00Z'); h.setOnline(false); await monitor.tick();
  h.setTime('2026-10-20T03:06:00Z'); await monitor.tick();
  let state = h.store.getConnectionRecovery('12345');
  assert.equal(state.intervals.filter(item => item.confirmedFrom).length, 1);
  assert.equal(state.intervals.at(-1).confirmedFrom, '2026-10-20T03:04:00.000Z');
  assert.equal(state.intervals.at(-1).reason, 'hub-unobserved');
  h.setTime('2026-10-20T03:10:00Z'); h.setOnline(true); await monitor.tick();
  state = h.store.getConnectionRecovery('12345');
  const gap = state.intervals.at(-1);
  assert.equal(gap.to, '2026-10-20T03:10:00.000Z');
  const scan = h.store.getHistoryScan(gap.targets[h.sub.id].scanId);
  assert.equal(scan.from, '2026-10-20T02:58:00.000Z');
  assert.equal(scan.to, gap.to); assert.equal(scan.status, 'preview');
  assert.equal(scan.automatic.intervalId, gap.id);
  assert.equal(scan.entries.length, 1);
  assert.deepEqual(h.store.snapshot().subscriptions[h.sub.id].state.pendingSequences, []);
  assert.equal(scan.intent, undefined);
  const reads = h.reads(); await Promise.all([monitor.tick(), monitor.tick()]); assert.equal(h.reads(), reads);
});

test('Hub restart records unobserved time separately and reuses persisted scans without confirming', async t => {
  const h = await setup(t); await h.make().tick();
  h.setTime('2026-10-20T04:00:00Z');
  const restored = new SubscriptionStore(h.options); await restored.init();
  const recovery = new HistoryRecovery({ store: restored, reader: h.reader, accountId: '12345', clock: h.clock });
  await h.make(restored, recovery).tick();
  const state = restored.getConnectionRecovery('12345');
  const gap = state.intervals.at(-1);
  assert.equal(gap.reason, 'hub-unobserved'); assert.equal(gap.confirmedFrom, null);
  const scan = restored.getHistoryScan(gap.targets[h.sub.id].scanId);
  assert.match(recovery.get(scan.id).warnings.join(' '), /无法确认.*QQ/);
  assert.equal(scan.confirmedCount || 0, 0);
  assert.deepEqual(restored.snapshot().subscriptions[h.sub.id].state.pendingSequences, []);
});

test('automatic windows clamp to 48 hours and changes or new subscriptions cannot inherit an old gap', async t => {
  const h = await setup(t), monitor = h.make(); await monitor.tick();
  h.setTime('2026-10-20T03:04:00Z'); h.setOnline(false); await monitor.tick();
  await h.store.upsertSubscription({ ...h.sub, intakeMode: 'RESPONSIBLE_ONLY' });
  const added = (await h.store.upsertSubscription({ targetType: 'private', targetId: '99999', sourceGroupId: '54321' })).subscription;
  h.setTime('2026-10-23T03:00:00Z'); h.setOnline(true); await monitor.tick();
  const gap = h.store.getConnectionRecovery('12345').intervals.at(-1);
  assert.equal(gap.targets[h.sub.id].status, 'skipped'); assert.equal(gap.targets[added.id], undefined);
  assert.deepEqual(h.store.snapshot().subscriptions[added.id].state.pendingSequences, []);
  const other = await setup(t), monitor2 = other.make(); await monitor2.tick();
  other.setTime('2026-10-20T03:04:00Z'); other.setOnline(false); await monitor2.tick();
  other.setTime('2026-10-23T03:00:00Z'); other.setOnline(true); await monitor2.tick();
  const otherGap = other.store.getConnectionRecovery('12345').intervals.at(-1);
  const scan = other.store.getHistoryScan(otherGap.targets[other.sub.id].scanId);
  assert.equal(scan.from, '2026-10-21T03:00:00.000Z');
  assert.equal(scan.coverageComplete, true); assert.equal(scan.automatic.intervalCoverageComplete, false);
  assert.match(other.recovery.get(scan.id).warnings.join(' '), /48/);
});

test('multiple targets share source page reads and partial histories stop without automatic retries', async t => {
  const h = await setup(t);
  await h.store.upsertSubscription({ targetType: 'private', targetId: '99999', sourceGroupId: '54321' });
  const monitor = h.make(); await monitor.tick(); const before = h.reads();
  h.setTime('2026-10-20T03:04:00Z'); h.setOnline(false); await monitor.tick();
  h.reader.readPage = async () => ({ entries: [], warnings: [], nextCursor: null, oldestAt: null, empty: true });
  h.setTime('2026-10-20T03:10:00Z'); h.setOnline(true); await monitor.tick();
  const gap = h.store.getConnectionRecovery('12345').intervals.at(-1);
  assert.equal(Object.keys(gap.targets).length, 2);
  for (const target of Object.values(gap.targets)) { assert.equal(target.status, 'partial'); assert.match(target.stopReason, /空页/); }
  h.setTime('2026-10-20T03:11:00Z'); await monitor.tick();
  assert.equal(h.reads(), before);
  // Initial startup scan had two targets but fetched the common source page once.
  assert.equal(before, 1);
});

test('failed persistence prevents history reads and the next tick durably resumes the pending trigger', async t => {
  const h = await setup(t), monitor = h.make(); await monitor.tick();
  h.setTime('2026-10-20T03:04:00Z'); h.setOnline(false); await monitor.tick();
  h.setTime('2026-10-20T03:10:00Z'); h.setOnline(true);
  const save = h.store.save.bind(h.store), reads = h.reads();
  h.store.save = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(monitor.tick(), /disk/); assert.equal(h.reads(), reads);
  h.store.save = save; await monitor.tick();
  assert.ok(h.store.getConnectionRecovery('12345').intervals.at(-1).targets[h.sub.id].scanId);
  assert.equal(h.store.snapshot().subscriptions[h.sub.id].state.pendingSequences.length, 0);
});

test('normal 30-second observations confirm a collection interruption without claiming unobserved time', async t => {
  const h = await setup(t), monitor = h.make(); await monitor.tick();
  h.setOnline(false); h.setTime('2026-10-20T03:00:30Z'); await monitor.tick();
  h.setTime('2026-10-20T03:01:00Z'); await monitor.tick();
  h.setOnline(true); h.setTime('2026-10-20T03:01:30Z'); await monitor.tick();
  const gap = h.store.getConnectionRecovery('12345').intervals.at(-1);
  assert.equal(gap.reason, 'qq-disconnected'); assert.equal(gap.confirmedFrom, '2026-10-20T03:00:30.000Z');
  assert.equal(gap.failureObservations, 2); assert.equal(gap.unobservedFrom, undefined);
  assert.equal(h.store.getHistoryScan(gap.targets[h.sub.id].scanId).from, '2026-10-20T02:58:00.000Z');
});

test('saved scan survives interruption before mapping and is reused after restart', async t => {
  const h = await setup(t), monitor = h.make();
  const save = h.store.saveConnectionRecovery.bind(h.store); let saves = 0;
  h.store.saveConnectionRecovery = async (...args) => {
    if (++saves === 2) throw Object.assign(new Error('mapping write interrupted'), { storageWriteFailed: true });
    return save(...args);
  };
  await assert.rejects(monitor.tick(), /mapping/);
  assert.equal(h.reads(), 0);
  const id = Object.keys(h.store.snapshot().historyScans)[0];
  const restored = new SubscriptionStore(h.options); await restored.init();
  const recovery = new HistoryRecovery({ store: restored, reader: h.reader, accountId: '12345', clock: h.clock });
  await h.make(restored, recovery).tick();
  assert.deepEqual(Object.keys(restored.snapshot().historyScans), [id]);
  assert.equal(restored.getConnectionRecovery('12345').intervals[0].targets[h.sub.id].scanId, id);
  assert.equal(h.reads(), 1);
});

test('three-page budget stops automatic reading while preserving the existing manual resume', async t => {
  const h = await setup(t); let reads = 0;
  h.reader.readPage = async () => ({ entries: [], warnings: [], nextCursor: String(++reads), oldestAt: '2026-10-20T02:59:00Z', empty: false });
  h.recovery.confirm = h.store.enqueueHistoryBatch = h.recovery.hydrate = async () => { throw new Error('forbidden automatic execution'); };
  const monitor = h.make(); await monitor.tick();
  const target = h.store.getConnectionRecovery('12345').intervals[0].targets[h.sub.id];
  assert.equal(target.status, 'partial'); assert.equal(reads, 3);
  h.setTime('2026-10-20T03:00:30Z'); await monitor.tick(); assert.equal(reads, 3);
  await h.recovery.resume(target.scanId); assert.equal(reads, 6);
  assert.deepEqual(h.store.snapshot().subscriptions[h.sub.id].state.pendingSequences, []);
});

test('restart after scan save but before target completion cannot spend a second automatic page budget', async t => {
  const h = await setup(t); let reads = 0;
  h.reader.readPage = async () => ({ entries: [], warnings: [], nextCursor: String(++reads), oldestAt: '2026-10-20T02:59:00Z', empty: false });
  const save = h.store.saveConnectionRecovery.bind(h.store); let saves = 0;
  h.store.saveConnectionRecovery = async (...args) => {
    if (++saves === 3) throw Object.assign(new Error('completion write interrupted'), { storageWriteFailed: true });
    return save(...args);
  };
  await assert.rejects(h.make().tick(), /completion/); assert.equal(reads, 3);
  const restored = new SubscriptionStore(h.options); await restored.init();
  const recovery = new HistoryRecovery({ store: restored, reader: h.reader, accountId: '12345', clock: h.clock });
  await h.make(restored, recovery).tick();
  assert.equal(reads, 3);
  assert.equal(restored.getConnectionRecovery('12345').intervals[0].targets[h.sub.id].status, 'partial');
});

test('preview capacity is visible and terminal for automatic attempts without deleting prior previews', async t => {
  const h = await setup(t);
  for (let index = 0; index < 30; index++) await h.store.saveHistoryScan({ id: `manual-${index}`, createdAt: h.clock().toISOString(), status: 'preview' });
  const monitor = h.make(); await monitor.tick();
  const target = h.store.getConnectionRecovery('12345').intervals[0].targets[h.sub.id];
  assert.equal(target.status, 'partial'); assert.match(target.stopReason, /30/);
  h.setTime('2026-10-20T03:00:30Z'); await monitor.tick();
  assert.equal(Object.keys(h.store.snapshot().historyScans).length, 30); assert.equal(h.reads(), 0);
});

test('empty page remains terminal across a crash before target status is saved', async t => {
  const h = await setup(t); let reads = 0;
  h.reader.readPage = async () => { reads++; return { entries: [], warnings: [], nextCursor: null, oldestAt: null, empty: true }; };
  const save = h.store.saveConnectionRecovery.bind(h.store); let saves = 0;
  h.store.saveConnectionRecovery = async (...args) => {
    if (++saves === 3) throw Object.assign(new Error('completion write interrupted'), { storageWriteFailed: true });
    return save(...args);
  };
  await assert.rejects(h.make().tick(), /completion/); assert.equal(reads, 1);
  const restored = new SubscriptionStore(h.options); await restored.init();
  const recovery = new HistoryRecovery({ store: restored, reader: h.reader, accountId: '12345', clock: h.clock });
  await h.make(restored, recovery).tick(); assert.equal(reads, 1);
  assert.match(restored.getConnectionRecovery('12345').intervals[0].targets[h.sub.id].stopReason, /空页/);
});

test('in-flight scan resumes its saved cursor with only the remaining automatic page budget', async t => {
  const h = await setup(t); let reads = 0;
  h.reader.readPage = async () => ({ entries: [], warnings: [], nextCursor: String(++reads), oldestAt: '2026-10-20T02:59:00Z', empty: false });
  const save = h.store.saveHistoryScan.bind(h.store);
  h.store.saveHistoryScan = async scan => {
    if (scan.status === 'partial') throw Object.assign(new Error('final scan write interrupted'), { storageWriteFailed: true });
    return save(scan);
  };
  await assert.rejects(h.make().tick(), /final scan/); assert.equal(reads, 3);
  const restored = new SubscriptionStore(h.options); await restored.init();
  const saved = Object.values(restored.snapshot().historyScans)[0];
  assert.equal(saved.status, 'scanning'); assert.equal(saved.cursor, '3');
  const recovery = new HistoryRecovery({ store: restored, reader: h.reader, accountId: '12345', clock: h.clock });
  await h.make(restored, recovery).tick(); assert.equal(reads, 3);
  assert.equal(restored.getHistoryScan(saved.id).status, 'partial');
});

test('Hub startup and recurring subscription scheduler invoke the same recovery coordinator', async () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const source = server.slice(server.indexOf('const recoveredRateLimitWindows ='), server.indexOf('mediaManager.cleanupOrphans('));
  let callback, recoveries = 0, subscriptions = 0, quotas = 0, calendars = 0;
  await runInNewContext(`(async () => { ${source} })()`, {
    Map, console,
    connectionRecovery: { tick: async () => { recoveries++; } },
    calendarFilter: { tick: async () => { calendars++; } },
    checkSubscriptionSchedule: async () => { subscriptions++; }, checkRateLimitRecovery: async () => { quotas++; },
    setInterval: (fn, ms) => { assert.equal(ms, 2000); callback = fn; return { unref() {} }; }
  });
  assert.equal(recoveries, 1); callback();
  assert.equal(recoveries, 2); assert.equal(subscriptions, 2); assert.equal(quotas, 2); assert.equal(calendars, 1);
});

test('overlapping ticks issue one health probe and optional health timeout is forwarded to real client transport', async t => {
  const h = await setup(t); let release, probes = 0;
  const probe = () => { probes++; return new Promise(resolve => { release = resolve; }); };
  const monitor = new ConnectionRecovery({ store: h.store, recovery: h.recovery, accountId: '12345', clock: h.clock, probe });
  const first = monitor.tick(); await monitor.tick(); assert.equal(probes, 1);
  release({ ok: true, state: 'online' }); await first;
  const signals = [];
  const client = new OneBotClient({ fetchImpl: async (_url, options) => {
    signals.push(options.signal); return { ok: true, status: 200, json: async () => ({ data: {} }) };
  } });
  await client.getLoginInfo({ timeoutMs: 5 }); await client.getStatus({ timeoutMs: 5 });
  assert.equal(signals.length, 2); assert.ok(signals.every(signal => signal instanceof AbortSignal));
});
