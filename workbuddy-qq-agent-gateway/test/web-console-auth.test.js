import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const client = readFileSync(new URL("../modules/web-console/public/client.js", import.meta.url), "utf8");
const source = client.slice(client.indexOf("async function api("), client.indexOf("async function refresh("));

test("panel authentication retries reads once with Bearer and never replays writes", async () => {
  async function attempt({ method, rejected = false, cancelled = false } = {}) {
    let stored = "old-token";
    let prompts = 0;
    const calls = [];
    const api = runInNewContext(`${source}; api`, {
      HUB: "",
      localStorage: { getItem: () => stored },
      requestHubToken: async () => {
        prompts++;
        if (cancelled) throw new Error("已取消登录");
        stored = "new-token";
        return stored;
      },
      fetch: async (url, options) => {
        calls.push({ url, options });
        const status = calls.length === 1 || rejected ? 401 : 200;
        return { status, ok: status === 200, json: async () => ({ ready: true }) };
      }
    });
    let error;
    try { await api("/api/state", method ? { method, body: "{}" } : {}); }
    catch (failure) { error = failure; }
    return { calls, prompts, error };
  }
  const success = await attempt();
  assert.equal(success.error, undefined);
  assert.equal(success.prompts, 1);
  assert.equal(success.calls.length, 2);
  assert.equal(success.calls[1].options.headers.authorization, "Bearer new-token");
  const rejected = await attempt({ rejected: true });
  assert.equal(rejected.calls.length, 2);
  assert.match(rejected.error.message, /登录失败/);
  const cancelled = await attempt({ cancelled: true });
  assert.equal(cancelled.calls.length, 1);
  assert.match(cancelled.error.message, /取消登录/);
  const write = await attempt({ method: "POST" });
  assert.equal(write.calls.length, 1);
  assert.match(write.error.message, /重新提交/);
});
