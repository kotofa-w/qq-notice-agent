import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubscriptionStore } from "../src/storage/subscription-store.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "subscription-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SubscriptionStore({ filePath: join(directory, "subscriptions.json") });
  await store.init();
  return store;
}

for (const failure of ["write", "rename"]) {
  test(`a ${failure} failure rejects its caller without poisoning later ordered saves`, async (t) => {
    const store = await fixture(t);
    const obstruction = failure === "write" ? `${store.filePath}.tmp-${process.pid}` : store.filePath;
    if (failure === "rename") await rm(store.filePath);
    await mkdir(obstruction);
    store.state.nextSequence = 2;
    await assert.rejects(store.save());
    assert.equal(store.snapshot().nextSequence, 2, "failed writes retain dirty in-memory state for retry");
    await rm(obstruction, { recursive: true });
    store.state.nextSequence = 3;
    const first = store.save();
    store.state.nextSequence = 4;
    const second = store.save();
    await first;
    await second;
    assert.equal(JSON.parse(await readFile(store.filePath, "utf8")).nextSequence, 4);
  });
}

test("redelivery flushes a source message left in memory by a failed append without adding a second sequence", async (t) => {
  const store = await fixture(t);
  await store.upsertSubscription({ targetType: "group", targetId: "12345", sourceGroupId: "54321", mode: "AUTO", intakeMode: "ALL", collectionDelayMinutes: 2 });
  const tempPath = `${store.filePath}.tmp-${process.pid}`;
  await mkdir(tempPath);
  const message = { groupId: "54321", messageId: "7", senderId: "99887", senderRole: "member", text: "notice", timestamp: new Date().toISOString() };
  await assert.rejects(store.appendSourceMessage(message));
  assert.equal(JSON.parse(await readFile(store.filePath, "utf8")).sources["54321"].messages.length, 0);
  await rm(tempPath, { recursive: true });
  await store.appendSourceMessage(message);
  const disk = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.deepEqual(disk.sources["54321"].messages.map((item) => item.messageId), ["7"]);
  assert.equal(disk.nextSequence, 2);
  assert.deepEqual(Object.values(disk.subscriptions)[0].state.pendingSequences, [1]);
});

for (const [name, modulePath, exportName, update, expected] of [
  ["agent dispatch", "../src/storage/agent-dispatch-store.js", "AgentDispatchStore", (store, value) => store.setEnabled(value), { enabled: false }],
  ["sticker model", "../src/storage/sticker-label-settings-store.js", "StickerLabelSettingsStore", (store, value) => store.setModel(value), { model: "updated-model" }]
]) {
  test(`${name} settings recover subsequent saves after a rejected write`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "settings-persistence-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { [exportName]: Store } = await import(modulePath);
    const store = new Store({ filePath: join(directory, "settings.json") });
    await store.init();
    const obstruction = `${store.filePath}.tmp-${process.pid}`;
    await mkdir(obstruction);
    const value = Object.values(expected)[0];
    await assert.rejects(update(store, value));
    await rm(obstruction, { recursive: true });
    await update(store, value);
    const disk = JSON.parse(await readFile(store.filePath, "utf8"));
    for (const [key, wanted] of Object.entries(expected)) assert.equal(disk[key], wanted);
  });
}
