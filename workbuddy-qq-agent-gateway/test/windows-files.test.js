import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QqFileManager } from "../src/qq/file-manager.js";
import { isLocalAbsolutePath } from "../src/qq/local-path.js";
import { parseQqDeliveryDirectives } from "../src/qq/file-directive.js";
import { handleQqMcpTool } from "../src/qq/mcp-actions.js";
import { privateSandbox } from "../src/security/subscription-policy.js";
import { constrainConversationSecurity, OWNER_QQ_ID } from "../src/security/policy.js";

test("native file paths pass parser and MCP, ambiguous Windows paths are rejected", () => {
  for (const path of ["C:\\中文 空格\\demo.txt", "D:/中文 空格/demo.txt"]) assert.equal(isLocalAbsolutePath(path, "win32"), true);
  for (const path of ["C:relative", "/root-relative", "\\root-relative", "\\\\host\\share", "\\\\?\\C:\\file", "C:/file:stream", "C:/file\0"]) assert.equal(isLocalAbsolutePath(path, "win32"), false);
  const source = join(tmpdir(), "中文 空格.txt");
  const parsed = parseQqDeliveryDirectives(`[[qq_file:${source}]]\n[[qq_image:${source}]]`, { allowFiles: true });
  assert.equal(parsed.files[0].sourcePath, source);
  assert.equal(parsed.images[0].sourcePath, source);
  const context = { targetType: "private", allowFiles: true };
  assert.equal(handleQqMcpTool({ name: "send_file", args: { path: source }, context }).isError, false);
  assert.equal(handleQqMcpTool({ name: "send_file", args: { path: "C:relative" }, context }).isError, true);
  const security = constrainConversationSecurity(privateSandbox(OWNER_QQ_ID, { reason: "mention" }, dirname(source)), { permissionMode: "workspaceWrite" });
  assert.deepEqual(security.allowedFileRoots, [dirname(source)]);
  assert.equal(security.allowQqFiles, true);
  assert.equal(constrainConversationSecurity(privateSandbox("99999", { reason: "mention" }, dirname(source))).allowQqFiles, false);
});

test("real paths reject junction escapes and local staging cleans only its copy after success or failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-files-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  await mkdir(allowed); await mkdir(outside);
  const source = join(allowed, "中文 空格.txt");
  await writeFile(source, "local-only test");
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(allowed, "link"), process.platform === "win32" ? "junction" : "dir");
  let staged;
  const manager = new QqFileManager({ transport: "local", oneBot: {
    async uploadPrivateFile(_id, path) { staged = path; assert.equal(await readFile(path, "utf8"), "local-only test"); return { ok: true }; },
    async sendPrivateImage(_id, uri) { staged = fileURLToPath(uri); assert.equal(await readFile(staged, "utf8"), "local-only test"); throw new Error("fake rejected"); }
  } });
  await assert.rejects(manager.resolveRequests([{ sourcePath: join(allowed, "link", "secret.txt") }], { allowedRoots: [allowed] }), { code: "QQ_FILE_OUTSIDE_ALLOWED_ROOT" });
  const [file] = await manager.resolveRequests([{ sourcePath: source }], { allowedRoots: [allowed] });
  assert.equal((await manager.uploadPrivate("12345", file)).ok, true);
  await assert.rejects(stat(dirname(staged)), { code: "ENOENT" });
  await assert.rejects(manager.sendImage("private", "12345", file), /fake rejected/);
  await assert.rejects(stat(dirname(staged)), { code: "ENOENT" });
  assert.equal(await readFile(source, "utf8"), "local-only test");
});

test("container staging traversal fails before any executor or recursive removal", async () => {
  for (const stagingRoot of ["/tmp/codexremotecontact-qq-files/../..", "/tmp/codexremotecontact-qq-files-other", "/", "/tmp/codexremotecontact-qq-files/\0x"]) {
    assert.throws(() => new QqFileManager({ stagingRoot, execFileImpl: () => assert.fail("must not execute") }), /staging root/);
  }
  assert.equal(new QqFileManager({ stagingRoot: "/tmp/codexremotecontact-qq-files/jobs/../safe" }).stagingRoot, "/tmp/codexremotecontact-qq-files/safe");
});

test("Windows outbound optimizer calls the shared Python helper and preserves the original", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-image-output-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "原图.png");
  const venvPython = fileURLToPath(new URL("../modules/workbuddy-agent/.venv/Scripts/python.exe", import.meta.url));
  const python = process.env.CODEX_REMOTE_CONTACT_WB_PYTHON || (existsSync(venvPython) ? venvPython : "python");
  const generated = spawnSync(python, ["-c", "from PIL import Image; import random,sys; Image.frombytes('RGB',(1300,1300),random.Random(1).randbytes(5070000)).save(sys.argv[1])", source], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const before = await readFile(source);
  const manager = new QqFileManager({ transport: "local", maxImageBytes: 3 * 1024 * 1024, imagePython: python });
  const [image] = await manager.resolveImageRequests([{ sourcePath: source }]);
  let preparedPath;
  await manager.withPreparedOutboundImage(image, async (prepared) => {
    preparedPath = prepared.sourcePath;
    assert.ok(prepared.size <= 3 * 1024 * 1024);
    assert.equal(prepared.mimeType, "image/png");
    assert.notEqual(preparedPath, source);
  });
  assert.deepEqual(await readFile(source), before);
  await assert.rejects(stat(preparedPath), { code: "ENOENT" });
});
