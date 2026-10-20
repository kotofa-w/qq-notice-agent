// A running desktop client alone does not prove the gateway can collect messages.
export function summarizeQqConnection({ login = null, status = null, error = null, expectedAccount, bridgeMode = "" } = {}) {
  let state;
  let message;
  const account = String(login?.user_id || login?.self_id || "");
  if (error) {
    state = "bridge_unavailable";
    message = bridgeMode === "external"
      ? "QQ 采集未连接：请使用已配置的桌面 QQ 入口；普通 QQ 已运行时先正常退出再打开。"
      : "QQ 消息桥未连接，请检查桥服务是否已启动。";
  } else if (!account) {
    state = "login_required";
    message = "QQ 采集模块已响应，等待登录配置的采集账号。";
  } else if (account !== String(expectedAccount || "")) {
    state = "account_mismatch";
    message = "QQ 账号与配置不一致，采集尚未就绪；请登录配置的采集账号。";
  } else if (status?.online !== true || status?.good === false) {
    state = "offline";
    message = "QQ 采集模块已响应，但账号未在线或连接异常，请检查 QQ 登录状态。";
  } else {
    state = "online";
    message = "QQ 账号与配置一致，通知采集已连接。";
  }
  return { ok: state === "online", state, message, login, status, error: error || null };
}
