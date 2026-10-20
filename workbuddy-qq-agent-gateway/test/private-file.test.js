import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OneBotClient } from "../src/qq/onebot-client.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { SessionStore } from "../src/storage/session-store.js";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qq-private-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "sessions.json");
  const store = new SessionStore({ filePath });
  await store.init({ allowedGroups: ["12345"] });
  const message = await store.appendMessage({ groupId: "12345", messageId: "m1", senderId: "12345", text: "发文件", trust: "OWNER" });
  await store.requestTrigger("12345", "mention", message);
  await store.beginWork("12345");
  return { root, filePath, store, message };
}

test("OneBot private file upload checks reply switch and uses the long upload timeout", async () => {
  const client = new OneBotClient({ baseUrl: "http://127.0.0.1:3000", fileUploadTimeoutMs: 900000 });
  const calls = [];
  client.assertReplyEnabled = (...args) => calls.push(args);
  client.request = async (...args) => { calls.push(args); return { ok: true, status: 200, body: { status: "ok" }, data: { file_id: "f1" } }; };
  assert.equal((await client.uploadPrivateFile("12345", "C:\\work\\demo.txt", "demo.txt")).fileId, "f1");
  assert.deepEqual(calls, [["private", "12345"], ["/upload_private_file", { user_id: 12345, file: "C:\\work\\demo.txt", name: "demo.txt" }, { longRunning: true, timeoutMs: 900000 }]]);
  client.assertReplyEnabled = () => { throw new Error("REPLY_DISABLED"); };
  await assert.rejects(client.uploadPrivateFile("12345", "demo.txt"), /REPLY_DISABLED/);
  assert.equal(calls.length, 2);
});

test("private live file send retains pending, respects roots, and records receipt through the private API", async (t) => {
  const { root, store, message } = await fixture(t);
  const calls = [];
  const makeContext = (allowQqFiles, outside = false) => createLiveConversationTools({
    store, targetId: "12345", targetType: "private", oneBot: {},
    security: { allowQqFiles, allowedFileRoots: [root] }, trigger: { reason: "mention", trust: "OWNER" }, triggerMessages: [message],
    initialImageSequence: message.sequence, renderMessages: (messages) => messages.map((item) => item.text).join("\n"),
    fileManager: {
      async resolveRequests(requests, options) {
        assert.deepEqual(options.allowedRoots, [root]);
        if (outside) throw Object.assign(new Error("outside allowed root"), { code: "QQ_FILE_OUTSIDE_ALLOWED_ROOT" });
        return [{ sourcePath: requests[0].sourcePath, name: "demo.txt" }];
      },
      async uploadPrivate(id, file) { calls.push({ id, file }); return { ok: true, body: { data: { message_id: 77 } } }; },
      async upload() { assert.fail("private file must not enter a group"); }
    }
  });
  for (const [allow, outside] of [[false, false], [true, true]]) {
    const context = makeContext(allow, outside);
    await context.liveTool("read_messages", {}, {});
    assert.equal((await context.liveTool("send_file", { path: join(root, "demo.txt") }, {})).isError, true);
    assert.equal(calls.length, 0);
  }
  const context = makeContext(true);
  await context.liveTool("read_messages", {}, {});
  assert.equal((await context.liveTool("send_file", { path: join(root, "demo.txt") }, {})).isError, false);
  assert.equal(calls[0].id, "12345");
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
  assert.equal(store.snapshot("12345").liveSession.actions.at(-1).messageId, "77");
  await context.liveTool("end_conversation", {}, {});
  await store.completeLiveConversation("12345", { lastReadSequence: context.lastReadSequence });
  assert.equal(store.snapshot("12345").pendingMessages.length, 0);
});

test("private prepared files survive reload and retries skip accepted files and text while retaining later messages", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.prepareDeliveryWork("12345", { reply: "附件", files: [{ name: "a.txt" }, { name: "b.txt" }] });
  let textCount = 0;
  let failed = true;
  const uploaded = [];
  const options = {
    mediaManager: { removeMessages: async () => {} },
    oneBot: { sendPrivateMessage: async () => { textCount++; return { ok: true }; } },
    fileManager: { uploadPrivate: async (_id, file) => {
      uploaded.push(file.name);
      return { ok: file.name !== "b.txt" || !failed, status: 503 };
    } }
  };
  const worker = new PrivateWorker({ store, ...options });
  await assert.rejects(worker.deliverPrepared("12345"), /file delivery failed/);
  await store.failWork("12345", new Error("upload failed"));
  assert.equal(store.snapshot("12345").failedDelivery.files[0].delivered, true);
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
  await store.appendMessage({ groupId: "12345", messageId: "m2", senderId: "12345", text: "later" });
  const reloaded = new SessionStore({ filePath });
  await reloaded.init({ allowedGroups: ["12345"] });
  await reloaded.requestTrigger("12345", "retry", { trust: "OWNER" });
  await reloaded.beginWork("12345");
  failed = false;
  await new PrivateWorker({ store: reloaded, ...options }).deliverPrepared("12345");
  assert.deepEqual(uploaded, ["a.txt", "b.txt", "b.txt"]);
  assert.equal(textCount, 1);
  assert.deepEqual(reloaded.snapshot("12345").pendingMessages.map((item) => item.messageId), ["m2"]);
});
