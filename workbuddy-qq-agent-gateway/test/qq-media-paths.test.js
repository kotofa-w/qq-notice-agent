import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { QqMediaManager } from "../src/qq/media-manager.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-media-paths-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootDir = join(directory, "cache");
  const source = join(directory, "original.png");
  await writeFile(source, "original image");
  const media = new QqMediaManager({ rootDir, orphanTtlMs: 0, fetchImpl: async () => {
    throw new Error("unexpected fetch");
  } });
  await media.init();
  return { directory, rootDir, source, media };
}

test("OneBot resolved Windows drive paths copy images and attachments without changing originals", { skip: process.platform !== "win32" }, async (t) => {
  const { media, source } = await fixture(t);
  for (const path of [source, source.replaceAll("\\", "/")]) {
    const message = { groupId: "123", messageId: "456", imageRefs: [{ file: "onebot-image-id" }],
      attachments: [{ type: "file", fileId: "onebot-file-id", name: "original.png" }] };
    const [image] = await media.cacheMessageImages(message, { resolveImageRef: async () => ({ file: path }) });
    const [attachment] = await media.cacheMessageAttachments(message, { resolveAttachmentRef: async () => ({ file: path }) });
    assert.equal(image.error, undefined);
    assert.equal(attachment.error, undefined);
    assert.equal(await readFile(image.localPath, "utf8"), "original image");
    assert.equal(await readFile(attachment.localPath, "utf8"), "original image");
    await media.removeMessages([message]);
    await assert.rejects(stat(media.messageDir("123", "456")), { code: "ENOENT" });
    assert.equal(await readFile(source, "utf8"), "original image");
  }
});

test("raw drive paths and resolver echoes never acquire local read permission", { skip: process.platform !== "win32" }, async (t) => {
  const { media, source } = await fixture(t);
  for (const ref of [{ file: source }, { url: source }]) {
    for (const resolver of [undefined, async () => ({ url: source }), async () => ({ file: source })]) {
      const [result] = await media.cacheMessageImages({ groupId: "123", messageId: "raw", imageRefs: [ref] }, { resolveImageRef: resolver });
      assert.equal(result.localPath, null);
      assert.match(result.error, /did not include a downloadable/);
    }
  }
});

test("Windows UNC, devices, drive-relative and root-relative sources are rejected", { skip: process.platform !== "win32" }, async (t) => {
  const { media } = await fixture(t);
  for (const path of ["\\\\server\\share\\image.png", "//server/share/image.png", "\\\\?\\C:\\image.png", "\\\\.\\C:\\image.png",
    "C:image.png", "\\image.png", "/image.png", "file://server/share/image.png"]) {
    const [result] = await media.cacheMessageImages({ groupId: "123", messageId: "invalid", imageRefs: [{ file: "id" }] }, {
      resolveImageRef: async () => ({ file: path })
    });
    assert.equal(result.localPath, null, path);
    assert.match(result.error, /did not include a downloadable/, path);
  }
});

test("cache deletion uses native path boundaries and preserves roots, siblings and source images", async (t) => {
  const { media, rootDir, directory, source } = await fixture(t);
  const [image] = await media.cacheMessageImages({ groupId: "123", messageId: "456", imageRefs: [{ file: pathToFileURL(source).href }] });
  assert.equal(image.error, undefined);
  const sibling = join(directory, "cache-sibling.png");
  await writeFile(sibling, "outside");
  assert.equal(media.isInsideRoot(image.localPath), true);
  assert.equal(media.isInsideRoot(rootDir), false);
  assert.equal(media.isInsideRoot(sibling), false);
  assert.equal(media.isInsideRoot(join(rootDir, "..", "original.png")), false);
  await media.removeImages([{ localPath: rootDir }, { localPath: sibling }, { localPath: source }, image]);
  await assert.rejects(stat(image.localPath), { code: "ENOENT" });
  assert.equal((await stat(rootDir)).isDirectory(), true);
  assert.equal(await readFile(sibling, "utf8"), "outside");
  assert.equal(await readFile(source, "utf8"), "original image");
  for (const groupId of [".", ".."]) {
    assert.equal(media.isInsideRoot(media.messageDir(groupId, "..")), true);
    assert.notEqual(resolve(media.messageDir(groupId, "..")), rootDir);
  }
});

test("orphan cleanup removes only unreferenced message directories", async (t) => {
  const { media, source } = await fixture(t);
  const keepDir = media.messageDir("123", "keep");
  const orphanDir = media.messageDir("123", "orphan");
  await mkdir(keepDir, { recursive: true });
  await mkdir(orphanDir, { recursive: true });
  const keptImage = join(keepDir, "image.png");
  await writeFile(keptImage, "cached image");
  await media.cleanupOrphans([{ localPath: keptImage }]);
  assert.equal(await readFile(keptImage, "utf8"), "cached image");
  await assert.rejects(stat(orphanDir), { code: "ENOENT" });
  assert.equal(await readFile(source, "utf8"), "original image");
});

test("HTTP media sources retain their priority", async (t) => {
  const { media } = await fixture(t);
  const urls = [];
  media.fetchImpl = async (url) => {
    urls.push(url);
    return new Response("http image", { headers: { "content-type": "image/png" } });
  };
  const [image] = await media.cacheMessageImages({ groupId: "123", messageId: "http", imageRefs: [{ url: "https://example.com/image.png" }] }, {
    resolveImageRef: async () => ({ file: "C:\\unavailable.png" })
  });
  assert.equal(image.error, undefined);
  assert.deepEqual(urls, ["https://example.com/image.png"]);
  assert.equal(await readFile(image.localPath, "utf8"), "http image");
});
