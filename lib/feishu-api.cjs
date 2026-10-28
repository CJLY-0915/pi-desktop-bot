"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { requestJson: httpRequestJson, request: httpRequest, buildMultipart } = require("./http.cjs");
const { redactSecrets } = require("./security.cjs");
const { attachmentMetadata, validateAttachments, normalizeMimeType, mimeTypeFromFilename } = require("./attachment.cjs");
const { MAX_ATTACHMENT_BYTES } = require("./constants.cjs");

/**
 * 飞书开放平台 API 封装：tenant_access_token 缓存、发消息、消息更新、媒体上传/下载。
 * 只访问 open.feishu.cn（manifest.net.domains 已声明）。
 */

const BASE = "https://open.feishu.cn";
const TOKEN_URL = `${BASE}/open-apis/auth/v3/tenant_access_token/internal`;
/** 提前刷新窗口：剩余有效期不足这么久就重新换取（飞书可能返回已被缩短的旧令牌）。 */
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

function createFeishuApi({ appId, appSecret }) {
  let token = null;
  let tokenExpiresAt = 0;
  let inflight = null;

  function errorMessage(error) {
    let message = String(error?.message ?? error);
    for (const secret of [appSecret, token]) {
      if (secret) message = message.split(secret).join("[REDACTED]");
    }
    return redactSecrets(message.replace(/https?:\/\/[^\s)]+/giu, "[URL]"));
  }

  async function transport(impl, options) {
    try { return await impl(options); }
    catch (error) { throw new Error(errorMessage(error)); }
  }
  const requestJson = options => transport(httpRequestJson, options);
  const request = options => transport(httpRequest, options);

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) return token;
    if (!inflight) {
      inflight = (async () => {
        const requestedAt = Date.now();
        const { status, data } = await requestJson({
          method: "POST",
          url: TOKEN_URL,
          body: { app_id: appId, app_secret: appSecret },
        });
        if (status !== 200 || data?.code !== 0 || !data?.tenant_access_token) {
          throw new Error(errorMessage(`feishu token failed: status=${status} code=${data?.code} msg=${data?.msg ?? "unknown"}`));
        }
        // 过期时间必须以“请求开始时”为基准：接口 expire 是剩余秒数，
        // 固定缓存时长会把网络耗时算进令牌寿命，实测会提前拿到 99991663。
        const expire = Number(data.expire);
        if (Number.isFinite(expire) && expire > 0) {
          token = data.tenant_access_token;
          tokenExpiresAt = requestedAt + expire * 1000;
        } else {
          // 缺 expire 的令牌只用于本次请求，不进缓存，不猜测有效期。
          token = data.tenant_access_token;
          tokenExpiresAt = 0;
        }
        return token;
      })()
        .catch((error) => {
          throw error;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function api(method, apiPath, { params, body } = {}) {
    const accessToken = await getToken();
    const query = params
      ? `?${new URLSearchParams(params).toString()}`
      : "";
    const { status, data } = await requestJson({
      method,
      url: `${BASE}${apiPath}${query}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      body,
    });
    if (status !== 200 || (data && typeof data.code === "number" && data.code !== 0)) {
      throw new Error(errorMessage(`feishu api ${method} ${apiPath} failed: status=${status} code=${data?.code} msg=${data?.msg ?? "unknown"}`));
    }
    return data?.data ?? data;
  }

  /** 发送前按 receive_id 前缀选择 id 类型：oc_ 为群聊，其余按 open_id（官方推荐私聊用 open_id）。 */
  function receiveIdType(receiveId) {
    return String(receiveId).startsWith("oc_") ? "chat_id" : "open_id";
  }

  /** options: provider filename, mimeType and sizeBytes; the downloaded byte count is authoritative. */
  async function downloadAttachment(messageId, fileKey, kind, dataDir, options = {}) {
    validateAttachments([options]);
    const accessToken = await getToken();
    const response = await request({
      method: "GET",
      url: `${BASE}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${kind === "image" ? "image" : "file"}`,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status !== 200) {
      throw new Error(`feishu resource download failed: status=${response.status}`);
    }
    const header = name => {
      const entry = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === name);
      return typeof entry?.[1] === "string" ? entry[1] : "";
    };
    const disposition = header("content-disposition");
    const encodedName = /filename\*\s*=\s*UTF-8''([^;\r\n]+)/iu.exec(disposition)?.[1];
    let headerFilename = "";
    if (encodedName) {
      try { headerFilename = decodeURIComponent(encodedName.trim()); }
      catch { throw new Error("feishu resource filename encoding is invalid"); }
    }
    headerFilename ||= /filename\s*=\s*(?:"([^"]*)"|([^;\r\n]+))/iu.exec(disposition)?.slice(1).find(Boolean)?.trim() || "";
    const filename = options.filename || headerFilename || `${["image", "audio", "video"].includes(kind) ? kind : "file"}-attachment`;
    const metadata = attachmentMetadata("", {
      kind, filename,
      mimeType: normalizeMimeType(options.mimeType) || normalizeMimeType(header("content-type")) || mimeTypeFromFilename(filename),
    }, response.buffer.length);
    const dir = path.join(dataDir, "attachments");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `feishu-${randomUUID()}-${metadata.filename}`);
    fs.writeFileSync(target, response.buffer);
    return { ...metadata, path: target };
  }

  return {
    getToken,
    receiveIdType,

    sendMessage(chatId, msgType, content) {
      return api("POST", "/open-apis/im/v1/messages", {
        params: { receive_id_type: receiveIdType(chatId) },
        body: { receive_id: chatId, msg_type: msgType, content },
      });
    },

    /** 就地更新已发送消息（流式卡片 / 审批卡刷新）。 */
    updateMessage(messageId, msgType, content) {
      return api(msgType === "interactive" ? "PATCH" : "PUT", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
        body: { msg_type: msgType, content },
      });
    },

    /** 给入站消息加表情反应（Typing 作为“正在输入”指示；飞书无原生 typing API）。 */
    addReaction(messageId, emojiType) {
      return api("POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
        body: { reaction_type: { emoji_type: emojiType } },
      });
    },

    removeReaction(messageId, reactionId) {
      return api(
        "DELETE",
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      );
    },

    /** 上传文件换取 file_key，再以文件消息发出。 */
    async uploadAndSendFile(chatId, filePath, displayName) {
      const name = displayName || path.basename(filePath);
      const buffer = fs.readFileSync(filePath);
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `feishu file too large: ${buffer.length} bytes > ${MAX_ATTACHMENT_BYTES} limit`,
        );
      }
      const multipart = buildMultipart(
        { file_type: "stream", file_name: name },
        { field: "file", filename: name, contentType: "application/octet-stream", data: buffer },
      );
      const accessToken = await getToken();
      const upload = await request({
        method: "POST",
        url: `${BASE}/open-apis/im/v1/files`,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": multipart.contentType,
          "Content-Length": String(multipart.body.length),
        },
        body: multipart.body,
      });
      let parsed = null;
      try {
        parsed = JSON.parse(upload.buffer.toString("utf8"));
      } catch {
        parsed = null;
      }
      const fileKey = parsed?.data?.file_key;
      if (upload.status !== 200 || parsed?.code !== 0 || !fileKey) {
        throw new Error(errorMessage(`feishu file upload failed: status=${upload.status} msg=${parsed?.msg ?? "unknown"}`));
      }
      await this.sendMessage(chatId, "file", JSON.stringify({ file_key: fileKey }));
      return { name, size: buffer.length };
    },

    downloadAttachment,

    /** Compatibility API: return only the local path; metadata callers use downloadAttachment. */
    async downloadMessageResource(messageId, fileKey, kind, dataDir, options = {}) {
      return (await downloadAttachment(messageId, fileKey, kind, dataDir, options)).path;
    },
  };
}

module.exports = { createFeishuApi };
