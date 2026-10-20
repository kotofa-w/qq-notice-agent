import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const client = readFileSync(new URL("../modules/web-console/public/client.js", import.meta.url), "utf8");
const source = client.slice(client.indexOf("function historyRecoveryStorageKey("), client.indexOf('els.addSubscriptionButton.addEventListener("click"'));

function harness() {
  const messages = [];
  const els = new Proxy({}, { get(target, name) {
    return target[name] ||= { checked: false, disabled: false, value: "", hidden: false,
      addEventListener(type, listener) { this[type] = listener; }, showModal() {}, close() {},
      querySelectorAll(selector) { return messages.filter((input) => selector.includes(":checked") ? input.checked && !input.disabled : true); }
    };
  } });
  const stored = new Map();
  const calls = [];
  const list = { scans: [], connection: {} };
  const scans = new Map();
  const scan = { id: "scan1", subscriptionId: "sub1", from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString(), status: "partial", uncertainBaseline: true, coverageComplete: false, messages: [{ messageId: "old1", text: '<img src=x onerror="bad()">', duplicate: false }], counts: { fetched: 1, available: 1 } };
  const context = { els, Date, Number, historyRecoverySubscription: null, historyRecoveryScan: null, historyRecoveryBusy: false, historyRecoveryRememberedId: "", historyRecoveryProtectedId: "", historyRecoveryScans: [], localStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) }, formatTime: String, escapeHtml: (value) => String(value).replaceAll("<", "&lt;").replaceAll('"', "&quot;"), api: async (url, options) => { calls.push({ url, options }); return url.includes("?subscriptionId=") ? list : { scan: scans.get(decodeURIComponent(url.split("/")[5])) || scan }; } };
  const actions = runInNewContext(`${source}; ({ openHistoryRecovery, renderHistoryRecovery, updateHistoryRecoveryControls })`, context);
  return { els, stored, calls, scan, context, actions, messages, list, scans };
}

test("history recovery restores saved scans and gates replay behind selection and both acknowledgements", async () => {
  const h = harness();
  h.stored.set("crc-history-recovery:sub1", "scan1");
  await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
  assert.equal(h.calls[0].url, "/api/qq/history-recovery/scans/scan1");
  assert.match(h.els.historyRecoveryMessages.innerHTML, /&lt;img/);
  assert.doesNotMatch(h.els.historyRecoveryMessages.innerHTML, /<img/);
  assert.equal(h.els.historyRecoveryFuture.checked, false);
  assert.equal(h.els.historyRecoveryConfirmButton.disabled, true);
  const message = { checked: true, disabled: false, dataset: { duplicate: "false", historyMessage: "old1" } };
  h.messages.push(message);
  h.actions.updateHistoryRecoveryControls();
  assert.equal(h.els.historyRecoveryConfirmButton.disabled, true);
  h.els.historyRecoveryUncertain.checked = true;
  h.els.historyRecoveryPartial.checked = true;
  h.actions.updateHistoryRecoveryControls();
  assert.equal(h.els.historyRecoveryConfirmButton.disabled, false);
  await h.els.historyRecoveryConfirmButton.click();
  assert.equal(h.calls.at(-1).url, "/api/qq/history-recovery/scans/scan1/confirm");
  assert.deepEqual(JSON.parse(h.calls.at(-1).options.body), { messageIds: ["old1"], allowFutureActions: false, acknowledgeUncertain: true, acknowledgePartial: true });
});

test("history recovery rejects stale ranges and disables duplicates and concurrent actions", async () => {
  const h = harness();
  await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
  h.els.historyRecoveryFrom.value = new Date(Date.now() - 8 * 86400000).toISOString();
  h.els.historyRecoveryTo.value = new Date().toISOString();
  await h.els.historyRecoveryForm.submit({ preventDefault() {} });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/qq/history-recovery/scans?subscriptionId=sub1");
  assert.match(h.els.historyRecoveryStatus.textContent, /7 天/);
  h.actions.renderHistoryRecovery(h.scan);
  const duplicate = { checked: true, disabled: true, dataset: { duplicate: "true", historyMessage: "duplicate" } };
  h.messages.push(duplicate);
  h.els.historyRecoveryUncertain.checked = h.els.historyRecoveryPartial.checked = true;
  h.actions.updateHistoryRecoveryControls();
  assert.equal(h.els.historyRecoveryConfirmButton.disabled, true);
  h.context.historyRecoveryBusy = true;
  h.actions.updateHistoryRecoveryControls();
  assert.equal(h.els.historyRecoveryScanButton.disabled, true);
  assert.equal(h.els.historyRecoveryCloseButton.disabled, true);
  assert.equal(h.els.historyRecoveryResumeButton.disabled, true);
});

test("interrupted confirmation restores immutable intent even when selected messages are now duplicates", async () => {
  const h = harness();
  h.scan.status = "confirming";
  h.scan.confirmationIntent = { messageIds: ["old1", "no-longer-listed"], allowFutureActions: true };
  h.scan.messages[0].duplicate = true;
  const message = { checked: false, disabled: false, dataset: { duplicate: "true", historyMessage: "old1" } };
  const other = { checked: true, disabled: false, dataset: { duplicate: "false", historyMessage: "unselected" } };
  h.messages.push(message, other);
  h.stored.set("crc-history-recovery:sub1", "scan1");
  await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
  assert.match(h.els.historyRecoverySummary.textContent, /确认中断，可按原选择继续提交/);
  assert.equal(h.els.historyRecoveryConfirmButton.textContent, "按原选择继续补做");
  assert.equal(message.checked, true);
  assert.equal(other.checked, false);
  assert.equal(message.disabled, true);
  assert.equal(other.disabled, true);
  assert.equal(h.els.historyRecoveryFuture.checked, true);
  assert.equal(h.els.historyRecoveryFuture.disabled, true);
  assert.equal(h.els.historyRecoveryUncertain.checked, false);
  assert.equal(h.els.historyRecoveryPartial.checked, false);
  assert.equal(h.els.historyRecoveryConfirmButton.disabled, true);
  h.els.historyRecoveryUncertain.checked = h.els.historyRecoveryPartial.checked = true;
  h.actions.updateHistoryRecoveryControls();
  assert.equal(h.els.historyRecoveryConfirmButton.disabled, false);
  // DOM changes cannot replace the saved confirmation intent.
  message.checked = false;
  other.checked = true;
  h.els.historyRecoveryFuture.checked = false;
  await h.els.historyRecoveryConfirmButton.click();
  assert.deepEqual(JSON.parse(h.calls.at(-1).options.body), { messageIds: ["old1", "no-longer-listed"], allowFutureActions: true, acknowledgeUncertain: true, acknowledgePartial: true });
});

test("automatic previews are discovered, can be switched, and never select messages or calendar by default", async () => {
  const h = harness();
  const automatic = { ...h.scan, id: "auto1", warnings: ["超过48小时的前段未扫描"], automatic: { reason: "hub-unobserved", intervalCoverageComplete: false, warnings: ["超过48小时的前段未扫描"] } };
  const other = { ...h.scan, id: "auto2", automatic: { reason: "qq-disconnected", intervalCoverageComplete: true } };
  h.list.scans.push({ ...automatic, messages: undefined }, { ...other, messages: undefined });
  h.scans.set(automatic.id, automatic);
  h.scans.set(other.id, other);
  await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
  assert.equal(h.context.historyRecoveryScan.id, "auto1");
  assert.equal(h.els.historyRecoveryBatchLabel.hidden, false);
  assert.match(h.els.historyRecoveryBatch.innerHTML, /auto1/);
  assert.match(h.els.historyRecoveryBatch.innerHTML, /auto2/);
  assert.match(h.els.historyRecoveryWarnings.textContent, /未覆盖完整缺口/);
  assert.match(h.els.historyRecoveryWarnings.textContent, /超过48小时/);
  assert.equal(h.els.historyRecoveryWarnings.textContent.split("超过48小时的前段未扫描").length, 2);
  assert.match(h.els.historyRecoveryMessages.innerHTML, /&lt;img/);
  assert.doesNotMatch(h.els.historyRecoveryMessages.innerHTML, /\schecked(?:\s|=|\/|>)/);
  assert.equal(h.els.historyRecoveryFuture.checked, false);
  assert.equal(h.els.historyRecoveryConfirmButton.disabled, true);
  h.els.historyRecoveryFuture.checked = true;
  h.els.historyRecoveryBatch.value = "auto2";
  await h.els.historyRecoveryBatch.change();
  assert.equal(h.context.historyRecoveryScan.id, "auto2");
  assert.equal(h.els.historyRecoveryFuture.checked, false);
  assert.equal(h.calls.some(call => call.options?.method === "POST"), false);
});

test("saved confirmed and interrupted confirmations keep priority and their memory when switching automatic previews", async () => {
  for (const status of ["confirmed", "confirming"]) {
    const h = harness();
    h.scan.status = status;
    h.scan.confirmationIntent = { messageIds: ["old1"], allowFutureActions: true };
    const automatic = { ...h.scan, id: "auto1", status: "partial", confirmationIntent: null, automatic: { reason: "qq-disconnected" } };
    h.list.scans.push(automatic);
    h.scans.set("auto1", automatic);
    h.stored.set("crc-history-recovery:sub1", "scan1");
    await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
    assert.equal(h.context.historyRecoveryScan.id, "scan1");
    assert.match(h.els.historyRecoveryBatch.innerHTML, /auto1/);
    h.els.historyRecoveryBatch.value = "auto1";
    await h.els.historyRecoveryBatch.change();
    assert.equal(h.context.historyRecoveryScan.id, "auto1");
    assert.equal(h.stored.get("crc-history-recovery:sub1"), "scan1");
    assert.equal(h.els.historyRecoveryFuture.checked, false);
    h.els.historyRecoveryBatch.value = "scan1";
    await h.els.historyRecoveryBatch.change();
    assert.equal(h.context.historyRecoveryScan.status, status);
    assert.deepEqual(h.context.historyRecoveryScan.confirmationIntent, { messageIds: ["old1"], allowFutureActions: true });
    assert.equal(h.els.historyRecoveryFuture.checked, status === "confirming");
    assert.equal(h.calls.some(call => call.options?.method === "POST"), false);
  }
});

test("connection records expose unknown intervals, skipped targets and capacity failures without a preview", async () => {
  const h = harness();
  h.list.connection = { observedAt: "2026-10-20T01:00:00Z", connectionState: "account_mismatch", warning: "首次启动仅建立基线", intervals: [
    { reason: "qq-disconnected", from: "2026-10-20T00:00:00Z", to: "2026-10-20T01:00:00Z", targets: { sub1: { status: "partial", stopReason: "补漏预览已达30批" } } },
    { reason: "hub-unobserved", from: "2026-10-18T00:00:00Z", to: "2026-10-20T01:00:00Z", targets: { sub1: { status: "skipped", stopReason: "订阅配置变化<img>" } }, warnings: ["超过48小时的前段未扫描"] },
    { reason: "qq-disconnected", from: "2026-10-19T00:00:00Z", targets: { otherSub: { status: "partial", stopReason: "其他目标私有内容" } } }
  ] };
  await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
  const text = h.els.historyRecoveryConnection.textContent;
  assert.match(text, /不代表 QQ 在整个区间持续离线/);
  assert.match(text, /Hub未观测区间/);
  assert.match(text, /账号与配置不符/);
  assert.match(text, /部分结果（无预览）：补漏预览已达30批/);
  assert.match(text, /已跳过（无预览）：订阅配置变化<img>/);
  assert.match(text, /超过48小时/);
  assert.doesNotMatch(text, /其他目标私有内容/);
  assert.equal(h.context.historyRecoveryScan, null);
});

test("list read failure preserves restored confirmation and leaves a refresh path", async () => {
  const h = harness();
  h.scan.status = "confirming";
  h.scan.confirmationIntent = { messageIds: ["old1"], allowFutureActions: true };
  h.stored.set("crc-history-recovery:sub1", "scan1");
  const originalApi = h.context.api;
  h.context.api = async (url, options) => {
    if (url.includes("?subscriptionId=")) throw new Error("记录暂不可用");
    return originalApi(url, options);
  };
  await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
  assert.equal(h.context.historyRecoveryScan.id, "scan1");
  assert.match(h.els.historyRecoveryConnection.textContent, /记录暂不可用/);
  assert.equal(h.els.historyRecoveryFuture.checked, true);
  assert.equal(h.els.historyRecoveryListReloadButton.disabled, false);
  h.context.api = originalApi;
  await h.els.historyRecoveryListReloadButton.click();
  assert.match(h.els.historyRecoveryConnection.textContent, /须人工确认补做/);
  assert.equal(h.context.historyRecoveryScan.id, "scan1");
});

test("a null connection before the first baseline keeps manual recovery available", async () => {
  const h = harness();
  h.list.connection = null;
  await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
  assert.match(h.els.historyRecoveryConnection.textContent, /须人工确认补做/);
  assert.doesNotMatch(h.els.historyRecoveryConnection.textContent, /读取失败/);
  assert.equal(h.els.historyRecoveryScanButton.disabled, false);
  assert.equal(h.context.historyRecoveryScan, null);
});

test("confirmed scans distinguish queued, finished, failed and empty delivery outcomes", async () => {
  const h = harness();
  await h.actions.openHistoryRecovery({ id: "sub1", sourceGroupId: "123" });
  for (const [deliveryStatus, text] of [["pending", "已确认待处理"], ["completed", "处理完成"], ["failed", "处理失败待重试"], ["nothing-to-queue", "无需新增"], ["not-queued", "已确认，尚未入队"]]) {
    h.actions.renderHistoryRecovery({ ...h.scan, status: "confirmed", deliveryStatus });
    assert.ok(h.els.historyRecoverySummary.textContent.startsWith(text));
    assert.equal(h.els.historyRecoveryConfirmButton.disabled, true);
  }
});
