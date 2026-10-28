"use strict";

const https = require("node:https");
const { DWClient, TOPIC_ROBOT, EventAck } = require("../vendor/dingtalk.cjs");
const { redactSecrets } = require("./security.cjs");

/**
 * 钉钉通道：Stream 模式收消息（DWClient 出站长连接，无需公网 URL）。
 * 发：优先使用消息自带的 sessionWebhook；过期或不可用时转入待发箱，
 *     用户下一条消息到达时自动补发（不伪造送达）。
 */

function parseRobotMessage(data) {
  const text = data?.msgtype === "text" ? data?.text?.content ?? "" : "";
  return {
    conversationId: data?.conversationId ?? "",
    chatId: data?.conversationId ?? "",
    userId: data?.senderStaffId ?? "",
    text: text.trim(),
    messageId: data?.msgId ?? "",
    conversationType: data?.conversationType ?? "",
    sessionWebhook: data?.sessionWebhook ?? "",
    sessionWebhookExpiredTime: Number(data?.sessionWebhookExpiredTime ?? 0),
    robotCode: data?.robotCode ?? "",
    msgtype: data?.msgtype ?? "",
  };
}

async function postJson(url, payload, timeoutMs = 15000) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, data: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`dingtalk request timeout: ${url}`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function createDingtalkChannel({ clientId, clientSecret, onMessage, onChoice, onLog, onStatus }) {
  let client = null;
  let stopped = false;
  let deliveryError = "";

  /** chatId -> { webhook, expiredAt } */
  const webhooks = new Map();

  function rememberWebhook(message) {
    if (message.sessionWebhook) {
      webhooks.set(message.chatId, {
        webhook: message.sessionWebhook,
        expiredAt: message.sessionWebhookExpiredTime,
      });
    }
  }

  async function deliver(chatId, payload) {
    const entry = webhooks.get(chatId);
    const now = Date.now();
    if (!entry || (entry.expiredAt && entry.expiredAt <= now)) {
      deliveryError = "webhook-unavailable";
      return { delivered: false, reason: "webhook-unavailable" };
    }
    const response = await postJson(entry.webhook, payload);
    if (response.status !== 200 || (response.data && response.data.errcode && response.data.errcode !== 0)) {
      deliveryError = `http-${response.status}-${response.data?.errmsg ?? ""}`;
      return { delivered: false, reason: deliveryError };
    }
    deliveryError = "";
    return { delivered: true };
  }

  client = new DWClient({ clientId, clientSecret, keepAlive: true });
  client.registerAllEventListener(async (message) => {
    const topic = message?.headers?.topic ?? "";
    if (topic !== TOPIC_ROBOT) {
      return { status: EventAck.SUCCESS, message: "ignored" };
    }
    try {
      const parsed = parseRobotMessage(JSON.parse(message.data ?? "{}"));
      if (!parsed.chatId) return { status: EventAck.SUCCESS, message: "no chat" };
      rememberWebhook(parsed);
      if (!parsed.text) {
        return { status: EventAck.SUCCESS, message: "unsupported message type" };
      }
      await onMessage({
        channel: "dingtalk",
        chatId: parsed.chatId,
        userId: parsed.userId,
        text: parsed.text,
        messageId: parsed.messageId,
        images: [],
        meta: { conversationType: parsed.conversationType, robotCode: parsed.robotCode },
      });
      return { status: EventAck.SUCCESS, message: "ok" };
    } catch (error) {
      onLog?.("error", "dingtalk message handling failed", { error: String(error?.message ?? error) });
      return { status: EventAck.LATER, message: String(error?.message ?? error) };
    }
  });

  async function sendText(chatId, text) {
    const result = await deliver(chatId, {
      msgtype: "text",
      text: { content: redactSecrets(text) },
    });
    return result;
  }

  /** 钉钉不建互动卡片：选择请求渲染为编号文本，用户回复序号即可。 */
  async function sendChoice(chatId, request) {
    const lines = [`${request.title || "需要你的确认"}`, request.prompt];
    request.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option}`);
    });
    lines.push("回复序号进行选择。");
    const result = await sendText(chatId, lines.join("\n"));
    return result;
  }

  async function start() {
    if (stopped) throw new Error("channel already stopped");
    onStatus?.("connecting");
    await client.connect();
    onStatus?.("connected");
  }

  async function stop() {
    stopped = true;
    try {
      client.disconnect();
    } catch {
      /* 停机路径不因关闭报错而失败 */
    }
    webhooks.clear();
    onStatus?.("stopped");
  }

  return {
    kind: "dingtalk",
    capabilities: { streamingCard: false },
    start,
    stop,
    sendText,
    sendChoice,
    uploadMedia: async () => {
      throw new Error("dingtalk media upload is not supported in v0.1.0; use /send <path> to get the desktop path instead");
    },
    hasWebhook(chatId) {
      const entry = webhooks.get(chatId);
      if (!entry) return false;
      return !entry.expiredAt || entry.expiredAt > Date.now();
    },
    getDeliveryError: () => deliveryError,
    describe: () => ({ clientId, deliveryError }),
  };
}

module.exports = { createDingtalkChannel, parseRobotMessage };
