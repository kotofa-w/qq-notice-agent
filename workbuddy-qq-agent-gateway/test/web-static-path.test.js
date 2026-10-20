import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

test("actual static handler serves native paths and rejects an outside path", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async function serveStatic("), source.indexOf("async function loadSettings("));
  const publicDir = fileURLToPath(new URL("../modules/web-console/public/", import.meta.url));
  const context = vm.createContext({ ...path, publicDir, readFile, stat,
    sendJson: (res, status) => { res.status = status; } });
  vm.runInContext(handler, context);
  for (const requested of ["/", "/client.html", "/client.js", "/client.css"]) {
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await context.serveStatic({ method: "GET" }, response, requested);
    assert.equal(response.status, 200, requested);
    assert.ok(response.body.length > 0);
  }
  const response = {};
  await context.serveStatic({ method: "GET" }, response, "..%2f..%2f..%2fpackage.json");
  assert.equal(response.status, 403);
});
