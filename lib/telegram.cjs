"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { request, requestJson, buildMultipart } = require("./http.cjs");
const { redactSecrets } = require("./security.cjs");
const { formatChoicePrompt } = require("./render.cjs");
const { attachmentMetadata, validateAttachments, mimeTypeFromFilename } = require("./attachment.cjs");
const {
  TELEGRAM_API_BASE,
  TELEGRAM_TEXT_LIMIT,
  TELEGRAM_POLL_TIMEOUT_SECONDS,
  TELEGRAM_POLL_TIMEOUT_MS,
  TELEGRAM_POLL_RETRY_MS,
  TELEGRAM_FILE_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
} = require("./constants.cjs");

/**
 * Telegram 通道：Bot API 长轮询收消息（无需公网 URL），
 * 发送用 sendMessage（Markdown，格式被拒自动回落纯文本），
 * 选择请求渲染为内联按钮（callback_data 为序号，点击后按序号文本回灌桥接）。
 */

function splitTelegramText(text, limit = TELEGRAM_TEXT_LIMIT) {
  const chunks = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}

/** 仅对明确的格式拒绝回落纯文本；限流、封禁和结果未知不盲目重发。 */
function shouldResendAsPlain(response) {
  if (response?.status !== 400) return false;
  const description = response?.data?.description;
  return !description || /parse|entities|markdown/i.test(description);
}

/** 按钮回调数据 → 桥接可解析的文本。保留 ZCode 的 zc: 约定，裸序号直接透传。 */
function decodeCallbackData(data) {
  const raw = String(data ?? "");
  if (raw === "zc:cancel") return "/cancel";
  if (raw.startsWith("zc:e:")) {
    const [, , token, value] = raw.split(":");
    return token && value ? `/elicitation ${token} ${value}` : "/elicitation";
  }
  if (raw.startsWith("zc:cmd:")) {
    return raw.slice("zc:cmd:".length);
  }
  if (raw.startsWith("zc:")) {
    return `/${raw.slice(3).replace(":", " ")}`;
  }
  return raw;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function defaultMimeType(kind) {
  if (kind === "image") return "image/jpeg";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

function readTelegramAttachments(message) {
  const attachments = [];
  const push = (value, kind, fallbackName) => {
    if (!isRecord(value) || typeof value.file_id !== "string" || !value.file_id) return;
    attachments.push({
      providerFileId: value.file_id,
      kind,
      filename: typeof value.file_name === "string" && value.file_name.trim() ? value.file_name : fallbackName,
      mimeType: typeof value.mime_type === "string" && value.mime_type.trim()
        ? value.mime_type
        : mimeTypeFromFilename(value.file_name || fallbackName) || defaultMimeType(kind),
      ...(typeof value.file_size === "number" ? { sizeBytes: value.file_size } : {}),
    });
  };
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    // photo 是多个尺寸的数组，取最大一张。
    const largest = message.photo.filter(isRecord).at(-1);
    if (largest) push(largest, "image", "telegram-photo.jpg");
  }
  push(message.document, "file", "telegram-document");
  push(message.video, "video", "telegram-video.mp4");
  push(message.audio, "audio", "telegram-audio");
  push(message.voice, "audio", "telegram-voice.ogg");
  return attachments;
}

/**
 * 解析单条 update 为统一入站结构（不含下载）。
 * 返回 { chatId, userId, text, messageId, attachments, chatType, callbackQueryId? } 或 null。
 */
function parseUpdate(update) {
  if (!isRecord(update)) return null;

  const message = isRecord(update.message) ? update.message : null;
  if (message) {
    const chat = isRecord(message.chat) ? message.chat : null;
    const from = isRecord(message.from) ? message.from : null;
    const userId =
      typeof from?.id === "number" || typeof from?.id === "string" ? String(from.id) : "";
    const chatId =
      typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : "";
    const text =
      typeof message.text === "string"
        ? message.text
        : typeof message.caption === "string"
          ? message.caption
          : "";
    const attachments = readTelegramAttachments(message);
    if (!chatId || !userId || (!text && attachments.length === 0)) return null;
    return {
      chatId,
      userId,
      text: text.trim(),
      messageId:
        typeof message.message_id === "number" || typeof message.message_id === "string"
          ? String(message.message_id)
          : "",
      attachments,
      chatType: chat?.type === "private" ? "private" : "group",
    };
  }

  const callbackQuery = isRecord(update.callback_query) ? update.callback_query : null;
  if (callbackQuery) {
    const from = isRecord(callbackQuery.from) ? callbackQuery.from : null;
    const callbackMessage = isRecord(callbackQuery.message) ? callbackQuery.message : null;
    const chat = isRecord(callbackMessage?.chat) ? callbackMessage.chat : null;
    const userId =
      typeof from?.id === "number" || typeof from?.id === "string" ? String(from.id) : "";
    const chatId =
      typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : "";
    const data = typeof callbackQuery.data === "string" ? callbackQuery.data : "";
    if (!chatId || !userId || !data) return null;
    const callbackQueryId = typeof callbackQuery.id === "string" ? callbackQuery.id : "";
    return {
      chatId,
      userId,
      text: decodeCallbackData(data),
      messageId: callbackQueryId,
      attachments: [],
      chatType: chat?.type === "private" ? "private" : "group",
      ...(callbackQueryId ? { callbackQueryId } : {}),
    };
  }

  return null;
}

function safeJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function createTelegramChannel({
  botToken,
  dataDir,
  onMessage,
  onChoice,
  onLog,
  onStatus,
  requestJson: requestJsonTransport = requestJson,
  request: requestTransport = request,
  loadOffset = async () => null,
  saveOffset = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let controller = null;
  let stopped = false;
  let deliveryError = "";
  const choices = new Map();

  function errorMessage(error) {
    const message = String(error?.message ?? error);
    return redactSecrets((botToken ? message.split(botToken).join("[REDACTED]") : message)
      .replace(/https?:\/\/[^\s)]+/giu, "[URL]"));
  }

  async function transport(impl, options) {
    try { return await impl(options); }
    catch (error) {
      throw Object.assign(new Error(errorMessage(error)), { name: error?.name || "Error" });
    }
  }
  const requestJsonImpl = options => transport(requestJsonTransport, options);
  const requestImpl = options => transport(requestTransport, options);

  function log(level, message, data) {
    onLog?.(level, message, data);
  }

  function noteDeliveryError(error) {
    deliveryError = errorMessage(error);
  }

  function apiUrl(method, suffix = "") {
    return `${TELEGRAM_API_BASE}/bot${botToken}/${method}${suffix}`;
  }

  async function postMessage(chatId, text, replyMarkup) {
    const send = (markdown) =>
      requestJsonImpl({
        method: "POST",
        url: apiUrl("sendMessage"),
        body: {
          chat_id: chatId,
          text,
          ...(markdown ? { parse_mode: "Markdown" } : {}),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
      });
    let response = await send(true);
    if (shouldResendAsPlain(response)) {
      response = await send(false);
    }
    if (!response?.data?.ok) {
      return {
        ok: false,
        reason: errorMessage(`telegram send failed (${response?.data?.error_code ?? response?.status}): ${response?.data?.description ?? "unknown"}`),
      };
    }
    return { ok: true };
  }

  async function downloadInbound(attachment) {
    validateAttachments([attachment]);
    const fileResponse = await requestJsonImpl({
      method: "POST",
      url: apiUrl("getFile"),
      body: { file_id: attachment.providerFileId },
      timeoutMs: TELEGRAM_FILE_TIMEOUT_MS,
    });
    const filePath = fileResponse?.data?.result?.file_path;
    if (!fileResponse?.data?.ok || !filePath) {
      throw new Error(errorMessage(fileResponse?.data?.description ?? "telegram getFile 未返回 file_path"));
    }
    validateAttachments([{ sizeBytes: fileResponse.data.result.file_size }]);
    const response = await requestImpl({
      method: "GET",
      url: `${TELEGRAM_API_BASE}/file/bot${botToken}/${filePath}`,
      timeoutMs: TELEGRAM_FILE_TIMEOUT_MS,
      signal: controller?.signal,
    });
    if (response.status !== 200) {
      throw new Error(`telegram file download failed: HTTP ${response.status}`);
    }
    const metadata = attachmentMetadata("", attachment, response.buffer.length);
    const dir = path.join(dataDir, "attachments");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `telegram-${randomUUID()}-${metadata.filename}`);
    fs.writeFileSync(target, response.buffer);
    return { ...metadata, path: target };
  }

  async function handleUpdate(update) {
    const parsed = parseUpdate(update);
    if (!parsed) return;

    if (parsed.callbackQueryId) {
      // 先应答回调清除客户端转圈，再按序号文本回灌桥接。
      await requestJsonImpl({
        method: "POST",
        url: apiUrl("answerCallbackQuery"),
        body: { callback_query_id: parsed.callbackQueryId },
      }).catch((error) => {
        log("warn", "telegram answerCallbackQuery failed", {
          error: errorMessage(error),
        });
      });
      const choice = /^pi:([^:]+):([0-9]+)$/.exec(parsed.text);
      const pending = choice && choices.get(choice[1]);
      if (!pending || pending.chatId !== parsed.chatId) {
        await sendText(parsed.chatId, "该确认请求已过期，请重新触发。");
        return;
      }
      await onChoice?.({ chatId: parsed.chatId, userId: parsed.userId, choiceId: pending.choiceId, selection: choice[2] });
      return;
    }

    const attachments = [];
    try {
      validateAttachments(parsed.attachments);
      for (const attachment of parsed.attachments) {
        attachments.push(await downloadInbound(attachment));
      }
    } catch (error) {
      for (const attachment of attachments) fs.rmSync(attachment.path, { force: true });
      if (error.code !== "ATTACHMENT_LIMIT") throw error;
      const result = await sendText(parsed.chatId, `附件无法接收：${error.message}`);
      if (!result.delivered) throw new Error(result.reason);
      return;
    }
    const images = attachments.map(attachment => attachment.path);
    if (!parsed.text && attachments.length === 0) return;

    await onMessage({
      channel: "telegram",
      chatId: parsed.chatId,
      userId: parsed.userId,
      text: parsed.text,
      messageId: parsed.messageId,
      images,
      attachments,
      meta: { chatType: parsed.chatType },
    });
  }

  async function pollLoop() {
    let offset = await loadOffset();
    while (!stopped) {
      try {
        const response = await requestJsonImpl({
          method: "POST",
          url: apiUrl("getUpdates"),
          body: {
            ...(offset === null || offset === undefined ? {} : { offset }),
            timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
            allowed_updates: ["message", "callback_query"],
          },
          timeoutMs: TELEGRAM_POLL_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (stopped) return;
        if (!response?.data?.ok || !Array.isArray(response.data.result)) {
          throw new Error(
            errorMessage(`telegram getUpdates failed: ${response?.data?.description ?? `HTTP ${response?.status}`}`),
          );
        }
        for (const update of response.data.result) {
          if (stopped) return;
          await handleUpdate(update);
          if (typeof update?.update_id === "number") {
            const nextOffset = update.update_id + 1;
            await saveOffset(nextOffset);
            offset = nextOffset;
          }
        }
      } catch (error) {
        if (stopped || error?.name === "AbortError") return;
        noteDeliveryError(error);
        log("warn", "telegram poll failed", { error: errorMessage(error) });
        await sleep(TELEGRAM_POLL_RETRY_MS);
      }
    }
  }

  async function sendText(chatId, text) {
    const chunks = splitTelegramText(redactSecrets(text));
    for (const chunk of chunks) {
      const result = await postMessage(chatId, chunk);
      if (!result.ok) {
        deliveryError = result.reason;
        return { delivered: false, reason: result.reason };
      }
    }
    deliveryError = "";
    return { delivered: true };
  }

  /** 选择请求：编号文本 + 内联按钮（按钮挂在最后一条，与长文拆分一致）。 */
  async function sendChoice(chatId, request) {
    const options = Array.isArray(request?.options) ? request.options : [];
    const text = `${formatChoicePrompt(request)}\n也可以直接点击下方按钮。`;
    const token = randomUUID();
    choices.set(token, { chatId, choiceId: request.choiceId });
    if (choices.size > 100) choices.delete(choices.keys().next().value);
    const replyMarkup = {
      inline_keyboard: options.map((option, index) => [
        { text: option, callback_data: `pi:${token}:${index + 1}` },
      ]),
    };
    const chunks = splitTelegramText(text);
    for (const [index, chunk] of chunks.entries()) {
      const result = await postMessage(
        chatId,
        chunk,
        index === chunks.length - 1 ? replyMarkup : undefined,
      );
      if (!result.ok) {
        deliveryError = result.reason;
        return { delivered: false, reason: result.reason };
      }
    }
    deliveryError = "";
    return { delivered: true };
  }

  async function sendTyping(chatId) {
    try {
      await requestJsonImpl({
        method: "POST",
        url: apiUrl("sendChatAction"),
        body: { chat_id: chatId, action: "typing" },
      });
    } catch (error) {
      log("warn", "telegram typing failed", { error: errorMessage(error) });
    }
  }

  async function uploadMedia(chatId, filePath, displayName) {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`文件过大：${stat.size} 字节 > ${MAX_ATTACHMENT_BYTES} 上限`);
    }
    const filename = displayName || path.basename(resolved);
    const { body, contentType } = buildMultipart(
      { chat_id: chatId },
      {
        field: "document",
        filename,
        contentType: "application/octet-stream",
        data: fs.readFileSync(resolved),
      },
    );
    const response = await requestImpl({
      method: "POST",
      url: apiUrl("sendDocument"),
      headers: { "Content-Type": contentType },
      body,
      timeoutMs: TELEGRAM_FILE_TIMEOUT_MS,
    });
    const payload = safeJson(response.buffer);
    if (!payload?.ok) {
      throw new Error(
        errorMessage(`telegram sendDocument failed (${response.status}): ${payload?.description ?? "unknown"}`),
      );
    }
    return { name: filename, size: stat.size };
  }

  async function start() {
    if (stopped) throw new Error("channel already stopped");
    stopped = false;
    controller = new AbortController();
    onStatus?.("connecting");
    const me = await requestJsonImpl({ method: "POST", url: apiUrl("getMe") });
    if (!me?.data?.ok) {
      stopped = true;
      onStatus?.("stopped");
      throw new Error(errorMessage(`telegram getMe failed: ${me?.data?.description ?? `HTTP ${me?.status}`}`));
    }
    log("info", "telegram bot verified", { username: me.data.result?.username ?? "" });
    onStatus?.("connected");
    void pollLoop();
  }

  async function stop() {
    stopped = true;
    controller?.abort();
    controller = null;
    onStatus?.("stopped");
  }

  return {
    kind: "telegram",
    capabilities: { streamingCard: false },
    start,
    stop,
    sendText,
    sendChoice,
    sendTyping,
    uploadMedia,
    getDeliveryError: () => deliveryError,
    describe: () => ({ botToken: botToken ? "***" : "", deliveryError }),
  };
}

module.exports = {
  createTelegramChannel,
  parseUpdate,
  splitTelegramText,
  decodeCallbackData,
  shouldResendAsPlain,
};
