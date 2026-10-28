"use strict";

/**
 * 微信 iLink Bot 扫码登录（对齐 ZCode weixinRegistration）：
 * GET ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3 取二维码，
 * 轮询 /get_qrcode_status 直到 success 返回 bot_token。
 * deviceCode/qrcode 只在插件内存；token 只在 success 时经调用方落盘。
 */

const {
  WEIXIN_ILINK_BASE_URL,
  WEIXIN_BOT_API_PREFIX,
  WEIXIN_APP_HEADERS,
  WEIXIN_LOGIN_INTERVAL_SECONDS,
  WEIXIN_LOGIN_EXPIRE_SECONDS,
  WEIXIN_LOGIN_REQUEST_TIMEOUT_MS,
} = require("./constants.cjs");

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function readString(record, key) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record, key) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 服务端 data 可能与顶层字段重复，合并时以 data 为准。 */
function unwrapData(payload) {
  if (!isRecord(payload)) return {};
  return isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
}

function normalizeQrStatus(status) {
  if (typeof status === "number") {
    if (status === 0) return "pending";
    if (status === 1) return "scanned";
    if (status === 2) return "success";
    if (status === 3 || status === 4) return "expired";
  }
  if (typeof status !== "string") return "pending";
  const normalized = status.toLowerCase();
  if (["confirmed", "confirm", "authorized", "success", "ok"].includes(normalized)) {
    return "success";
  }
  if (["scaned", "scanned", "scan", "confirmed_wait"].includes(normalized)) {
    return "scanned";
  }
  if (["expired", "timeout", "cancel", "cancelled", "canceled"].includes(normalized)) {
    return "expired";
  }
  if (["error", "failed", "fail"].includes(normalized)) return "error";
  return "pending";
}

/**
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, now?: () => number }} options
 */
function createWeixinRegistration(options = {}) {
  const baseUrl = options.baseUrl ?? WEIXIN_ILINK_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  async function getJson(path) {
    const response = await fetchImpl(`${baseUrl}${WEIXIN_BOT_API_PREFIX}${path}`, {
      method: "GET",
      headers: { ...WEIXIN_APP_HEADERS },
      signal: AbortSignal.timeout(WEIXIN_LOGIN_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`weixin login ${path} failed: HTTP ${response.status}`);
    }
    const payload = unwrapData(await response.json());
    const ret = readNumber(payload, "ret");
    const errcode = readNumber(payload, "errcode");
    if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
      const errmsg = readString(payload, "errmsg");
      throw new Error(
        errmsg || `weixin login ${path} failed: ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim(),
      );
    }
    return payload;
  }

  async function begin() {
    const payload = await getJson("/get_bot_qrcode?bot_type=3");
    const qrCode = readString(payload, "qrcode") || readString(payload, "qr_code");
    const qrUrl =
      readString(payload, "qrcode_img_content") ||
      readString(payload, "qrcode_url") ||
      qrCode;
    if (!qrCode || !qrUrl) {
      throw new Error("微信未返回登录二维码");
    }
    const expireSeconds = readNumber(payload, "expires_in") ?? WEIXIN_LOGIN_EXPIRE_SECONDS;
    return {
      qrCode,
      qrUrl,
      userCode: qrCode,
      interval: WEIXIN_LOGIN_INTERVAL_SECONDS,
      expiresAt: now() + expireSeconds * 1000,
    };
  }

  async function poll({ qrCode }) {
    let payload;
    try {
      payload = await getJson(`/get_qrcode_status?qrcode=${encodeURIComponent(String(qrCode ?? ""))}`);
    } catch (error) {
      // 状态接口可能长时间挂起等待手机端确认，超时不代表登录失败。
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return { status: "pending", interval: WEIXIN_LOGIN_INTERVAL_SECONDS };
      }
      throw error;
    }
    const status = normalizeQrStatus(
      payload.status ?? payload.qrcode_status ?? payload.qr_status,
    );
    if (status === "success") {
      const botToken = readString(payload, "bot_token") || readString(payload, "token");
      if (!botToken) {
        return { status: "error", message: "微信登录成功但未返回 bot_token" };
      }
      return {
        status: "success",
        botToken,
        botId: readString(payload, "ilink_bot_id") || readString(payload, "bot_id") || undefined,
      };
    }
    if (status === "expired") {
      return { status: "expired", message: "扫码登录已过期，请重新开始" };
    }
    if (status === "error") {
      return { status: "error", message: readString(payload, "errmsg") || "微信登录失败" };
    }
    return { status, interval: WEIXIN_LOGIN_INTERVAL_SECONDS };
  }

  return { begin, poll };
}

module.exports = { createWeixinRegistration };
