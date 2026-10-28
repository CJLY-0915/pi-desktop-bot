"use strict";

/** 飞书 device-code 注册；凭据仅由调用方在授权成功后保存。 */

const ACCOUNTS_URL = "https://accounts.feishu.cn";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 10000;
const SOURCE = "node-sdk/pi-mobile-remote-control";

/**
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, now?: () => number }} options
 */
function createFeishuRegistration(options = {}) {
  const baseUrl = options.baseUrl ?? ACCOUNTS_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  async function postForm(body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${REGISTRATION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error.name === "TimeoutError" ? "请求超时" : `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ""}`;
      throw new Error(`飞书注册 ${body.action}：${reason}`);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error(`飞书注册 ${body.action}：HTTP ${response.status}，响应不是 JSON`); }
    // OAuth device-code 轮询用 HTTP 400 表达等待与授权终态。
    const pollState = body.action === "poll" && response.status === 400 &&
      ["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(payload?.error);
    if ((response.status < 200 || response.status >= 300) && !pollState) {
      throw new Error(`飞书注册 ${body.action}：HTTP ${response.status}，${payload?.error_description || payload?.error || "请求失败"}`);
    }
    if (!payload || typeof payload !== "object") throw new Error(`飞书注册 ${body.action}：响应格式无效`);
    if (body.action !== "poll" && payload.error) throw new Error(`飞书注册 ${body.action}：${payload.error_description || payload.error}`);
    return { status: response.status, payload };
  }

  async function begin() {
    const init = await postForm({ action: "init" });
    if (!init.payload?.supported_auth_methods?.includes("client_secret")) {
      throw new Error("当前飞书环境不支持 client_secret 方式创建应用");
    }
    const beginResponse = await postForm({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    });
    const payload = beginResponse.payload ?? {};
    const deviceCode = payload.device_code;
    const verificationUrl = payload.verification_uri_complete;
    if (!deviceCode || !verificationUrl) {
      throw new Error("飞书未返回 device code，无法生成扫码授权");
    }
    const qrUrl = new URL(verificationUrl);
    qrUrl.searchParams.set("from", "sdk");
    qrUrl.searchParams.set("source", SOURCE);
    qrUrl.searchParams.set("tp", "sdk");
    const expireIn = Number(payload.expire_in);
    return {
      deviceCode: String(deviceCode),
      qrUrl: qrUrl.toString(),
      userCode: String(payload.user_code ?? ""),
      interval: Number(payload.interval) > 0 ? Number(payload.interval) : 5,
      expiresAt: now() + (Number.isFinite(expireIn) && expireIn > 0 ? expireIn : 600) * 1000,
    };
  }

  async function poll({ deviceCode }) {
    const response = await postForm({ action: "poll", device_code: String(deviceCode ?? "") });
    const payload = response.payload ?? {};
    if (payload.client_id && payload.client_secret) {
      const app = payload.app && typeof payload.app === "object" ? payload.app : {};
      const appName =
        String(payload.app_name ?? "").trim() ||
        String(payload.client_name ?? "").trim() ||
        String(payload.name ?? "").trim() ||
        String(app.app_name ?? "").trim() ||
        String(app.name ?? "").trim();
      return {
        status: "success",
        appId: String(payload.client_id),
        appSecret: String(payload.client_secret),
        appName: appName || undefined,
        openId: payload.user_info?.open_id ? String(payload.user_info.open_id) : undefined,
      };
    }
    const error = String(payload.error ?? "");
    if (!error || error === "authorization_pending" || error === "slow_down") {
      return { status: "pending", interval: error === "slow_down" ? 10 : 5 };
    }
    if (error === "access_denied") return { status: "access_denied", message: "授权被拒绝" };
    if (error === "expired_token") return { status: "expired", message: "扫码授权已过期，请重新开始" };
    return { status: "error", message: `${error}: ${payload.error_description ?? "unknown"}` };
  }

  return { begin, poll };
}

module.exports = { createFeishuRegistration, ACCOUNTS_URL, REGISTRATION_PATH };
