import test from "node:test";
import assert from "node:assert/strict";
import { summarizeQqConnection } from "../src/qq/connection-health.js";

const expectedAccount = "100000002";
const connected = { expectedAccount, bridgeMode: "external", login: { user_id: 100000002, nickname: "测试采集账号" }, status: { online: true, good: true } };

test("QQ health requires the configured account and an online healthy bridge", () => {
  assert.equal(summarizeQqConnection(connected).ok, true);
  assert.equal(summarizeQqConnection({ ...connected, login: { user_id: 100000003 } }).state, "account_mismatch");
  assert.equal(summarizeQqConnection({ ...connected, status: { online: false, good: true } }).ok, false);
  assert.equal(summarizeQqConnection({ ...connected, status: { online: true, good: false } }).ok, false);
  assert.equal(summarizeQqConnection({ ...connected, login: {} }).ok, false);
});

test("missing external bridge gives a recovery action instead of treating desktop login as connection", () => {
  const result = summarizeQqConnection({ expectedAccount, bridgeMode: "external", error: "fetch failed" });
  assert.equal(result.ok, false);
  assert.equal(result.state, "bridge_unavailable");
  assert.match(result.message, /桌面.*QQ.*入口/);
  assert.match(result.message, /正常退出/);
  assert.equal(result.error, "fetch failed");
  assert.equal(summarizeQqConnection({ ...connected, error: "socket closed" }).ok, false);
});
