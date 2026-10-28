"use strict";

const { WSClient, EventDispatcher } = require("../vendor/feishu.cjs");
const { createFeishuApi } = require("./feishu-api.cjs");
const { redactSecrets } = require("./security.cjs");
const fs = require("node:fs");
const { validateAttachments } = require("./attachment.cjs");
const { chunkText, HARD_MAX_CHARS } = require("./render.cjs");
const {
  formatCardMarkdown,
  buildCardPayload,
  finalizeCardBlocks,
  splitCardStates,
  fitsInCard,
  createCardCircuit,
} = require("./feishu-card.cjs");
const {
  MAX_ATTACHMENTS_PER_MESSAGE,
  FEISHU_CARD_UPDATE_INTERVAL_MS,
} = require("./constants.cjs");

/**
 * 飞书通道。
 * 收：WSClient 长连接 + EventDispatcher（无需公网 URL）。
 * 发：feishu-api（自管控 HTTPS，token 按 expire 缓存提前刷新）。
 * 回传：streaming_card 用 Card JSON 2.0 单卡就地更新（消息块 + 工具摘要折叠面板 + 状态行），
 *       超过元素预算自动封存分段；写卡失败走退避与断路，不阻塞任务生命周期。
 * 私聊投递用 open_id（入站时从 sender 学习），群聊用 chat_id。
 */

const EVENT_MESSAGE = "im.message.receive_v1";
const EVENT_CARD_ACTION = "card.action.trigger";
const TYPING_EMOJI = "Typing";

function parseContent(raw, messageType) {
  let text = "";
  const resourceKeys = [];
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (messageType === "text") {
      text = parsed.text ?? "";
    } else if (messageType === "post") {
      const lines = [];
      for (const locale of Object.keys(parsed)) {
        for (const paragraph of parsed[locale]?.content ?? []) {
          for (const element of paragraph ?? []) {
            if (element?.tag === "text") lines.push(element.text ?? "");
            if (element?.tag === "img" && element.image_key) resourceKeys.push({ key: element.image_key, kind: "image" });
          }
        }
      }
      text = lines.join("\n");
    } else if (messageType === "image") {
      if (parsed.image_key) resourceKeys.push({ key: parsed.image_key, kind: "image" });
      text = "";
    } else if (messageType === "file") {
      if (parsed.file_key) resourceKeys.push({ key: parsed.file_key, kind: "file", filename: parsed.file_name, sizeBytes: parsed.file_size });
      text = "";
    } else if (messageType === "audio" || messageType === "media") {
      if (parsed.file_key) resourceKeys.push({ key: parsed.file_key, kind: messageType === "audio" ? "audio" : "video", filename: parsed.file_name, sizeBytes: parsed.file_size });
      text = "";
    }
  } catch {
    text = "";
  }
  return { text: text.replace(/@_user_\d+/g, "").trim(), resourceKeys };
}

function createFeishuChannel({ appId, appSecret, dataDir, onMessage, onChoice, onLog, onStatus }) {
  const api = createFeishuApi({ appId, appSecret });
  const dispatcher = new EventDispatcher({});
  let wsClient = null;
  let stopped = false;
  /** chatId -> open_id：私聊入站时学习，发送优先用 open_id（官方推荐）。 */
  const openIdByChat = new Map();
  let deliveryError = "";

  function log(level, message, data) {
    onLog?.(level, message, data);
  }

  function noteDeliveryError(error) {
    deliveryError = String(error?.message ?? error);
  }

  /** 内部路由键 chatId → 实际投递 id 与类型。 */
  function resolveTarget(chatId) {
    const openId = openIdByChat.get(chatId);
    if (openId) return { receiveId: openId, type: "open_id" };
    return { receiveId: chatId, type: chatId.startsWith("oc_") ? "chat_id" : "open_id" };
  }

  dispatcher.register({
    [EVENT_MESSAGE]: async (data) => {
      try {
        const message = data?.message ?? {};
        const chatId = message.chat_id ?? "";
        if (!chatId) return;
        if (!["p2p", "private"].includes(message.chat_type)) return;
        const openId = data?.sender?.sender_id?.open_id ?? "";
        const chatType = message.chat_type ?? "";
        if (openId && (chatType === "p2p" || chatType === "private")) {
          openIdByChat.set(chatId, openId);
        }
        const { text, resourceKeys } = parseContent(message.content, message.message_type);
        const attachments = [];
        try {
          validateAttachments(resourceKeys);
          for (const resource of resourceKeys) {
            attachments.push(await api.downloadAttachment(message.message_id, resource.key, resource.kind, dataDir, resource));
          }
        } catch (error) {
          for (const file of attachments) fs.rmSync(file.path, { force: true });
          log("warn", "feishu attachment rejected", { reason: error.code === "ATTACHMENT_LIMIT" ? "limit" : "download-failed" });
          await sendText(chatId, error.code === "ATTACHMENT_LIMIT" ? "附件超限：每条最多 4 个，每个最多 5 MiB，本条任务未执行。" : "附件下载失败，本条任务未执行，请重新发送本条消息。");
          return;
        }
        if (!text && attachments.length === 0) return;
        await onMessage({
          channel: "feishu",
          chatId,
          userId: openId,
          text,
          messageId: message.message_id ?? "",
          attachments,
          images: attachments.filter(file => file.kind === "image").map(file => file.path),
          meta: { chatType: "private" },
        });
      } catch (error) {
        log("error", "feishu message handling failed", { error: String(error?.message ?? error) });
      }
    },

    [EVENT_CARD_ACTION]: async (data) => {
      try {
        if (data?.context?.chat_type === "group") return;
        const value = data?.action?.value ?? {};
        const chatId = data?.context?.open_chat_id ?? value.chatId ?? "";
        if (!chatId || !value.choiceId) return;
        await onChoice({ chatId, userId: data?.operator?.open_id, choiceId: String(value.choiceId), selection: String(value.selection ?? "") });
      } catch (error) {
        log("error", "feishu card action failed", { error: String(error?.message ?? error) });
      }
    },
  });

  async function sendText(chatId, text, options) {
    try {
      const target = resolveTarget(chatId);
      const content = redactSecrets(text);
      const markdown = options?.format === "command-guide"
        ? content.replace(/^(\/\S+)/gm, "**$1**") : content;
      const cards = [];
      if (options?.format === "status") {
        const { buildStatusElements } = require("./feishu-card.cjs");
        const { FEISHU_CARD_ELEMENT_BUDGET } = require("./constants.cjs");
        let elements = [];
        let chars = 0;
        for (const element of buildStatusElements(markdown)) {
          const parts = element.tag === "markdown"
            ? chunkText(element.content, HARD_MAX_CHARS).map(content => ({ tag: "markdown", content }))
            : [element];
          for (const part of parts) {
            const size = part.content?.length ?? 0;
            if (elements.length && (chars + size > HARD_MAX_CHARS || elements.length >= FEISHU_CARD_ELEMENT_BUDGET)) {
              cards.push(elements);
              elements = [];
              chars = 0;
            }
            elements.push(part);
            chars += size;
          }
        }
        if (elements.length) cards.push(elements);
      } else {
        for (const part of chunkText(markdown, HARD_MAX_CHARS)) {
          cards.push([{ tag: "markdown", content: formatCardMarkdown(part) }]);
        }
      }
      for (const elements of cards) {
        const card = {
          schema: "2.0",
          config: { wide_screen_mode: true },
          body: { elements },
        };
        await api.sendMessage(target.receiveId, "interactive", JSON.stringify(card));
      }
      deliveryError = "";
      return { delivered: true };
    } catch (error) {
      noteDeliveryError(error);
      throw error;
    }
  }

  async function sendChoice(chatId, request) {
    const actions = request.options.map((option, index) => ({
      tag: "button",
      text: { tag: "plain_text", content: `${index + 1}. ${option}` },
      type: index === 0 ? "primary" : "default",
      behaviors: [{ type: "callback", value: { choiceId: request.choiceId, selection: String(index + 1), chatId } }],
    }));
    const card = {
      schema: "2.0",
      config: { wide_screen_mode: true },
      body: { elements: [
        { tag: "markdown", content: formatCardMarkdown(redactSecrets([request.title || "需要你的确认", request.prompt].join("\n\n"))) },
        ...actions,
      ] },
    };
    try {
      const target = resolveTarget(chatId);
      await api.sendMessage(target.receiveId, "interactive", JSON.stringify(card));
      deliveryError = "";
      return { delivered: true };
    } catch (error) {
      noteDeliveryError(error);
      throw error;
    }
  }

  async function uploadMedia(chatId, filePath, displayName) {
    try {
      const target = resolveTarget(chatId);
      const result = await api.uploadAndSendFile(target.receiveId, filePath, displayName);
      deliveryError = "";
      return result;
    } catch (error) {
      noteDeliveryError(error);
      throw error;
    }
  }

  // ---------- 流式卡片回合 ----------

  /**
   * 开始一个回传回合：立即建卡（执行中状态行）并对入站消息加 Typing 反应。
   * 返回回合句柄；通道不支持时返回 null，由 bridge 回落文本分段。
   */
  function beginTurn({ chatId, messageId, resume }) {
    if (stopped) return null;
    const target = resume?.target ?? resolveTarget(chatId);
    const state = {
      chatId,
      target,
      blocks: structuredClone(resume?.blocks ?? []),
      status: "running",
      cardMessageId: resume?.cardMessageId ?? null,
      circuit: createCardCircuit({ initialState: resume?.circuitState, now: () => Date.now() }),
      lastWriteAt: resume?.lastWriteAt ?? 0,
      flushTimer: null,
      writeChain: Promise.resolve(),
      ended: false,
    };
    let typingReactionId = resume?.typingReactionId ?? null;
    let paused = false;

    function enqueue(task) {
      state.writeChain = state.writeChain.then(task).catch((error) => {
        log("warn", "feishu card write failed", { error: String(error?.message ?? error) });
      });
      return state.writeChain;
    }

    async function sendActiveCard(cardState) {
      const result = await api.sendMessage(
        state.target.receiveId,
        "interactive",
        JSON.stringify(buildCardPayload(cardState)),
      );
      return result?.message_id ?? null;
    }

    async function writeCard() {
      if (!state.cardMessageId) {
        if (fitsInCard(state)) {
          state.cardMessageId = await sendActiveCard(state);
          return;
        }
        // 超预算：前序段封存保留，末段成为活跃卡。
        const segments = splitCardStates(state);
        for (let index = 0; index < segments.length - 1; index += 1) {
          await sendActiveCard(segments[index]);
        }
        const last = segments[segments.length - 1];
        state.blocks = last.blocks;
        state.cardMessageId = await sendActiveCard(last);
        return;
      }
      if (!fitsInCard(state)) {
        const segments = splitCardStates(state);
        await api.updateMessage(
          state.cardMessageId,
          "interactive",
          JSON.stringify(buildCardPayload(segments[0])),
        );
        for (let index = 1; index < segments.length - 1; index += 1) {
          await sendActiveCard(segments[index]);
        }
        const last = segments[segments.length - 1];
        state.blocks = last.blocks;
        state.cardMessageId = await sendActiveCard(last);
        return;
      }
      await api.updateMessage(
        state.cardMessageId,
        "interactive",
        JSON.stringify(buildCardPayload(state)),
      );
    }

    function flush() {
      if (state.ended || paused) return;
      const gate = state.circuit.check();
      if (!gate.allowed) {
        log("debug", "feishu card write suppressed", { reason: gate.reason });
        return;
      }
      return enqueue(async () => {
        // 排队期间前一请求可能失败；必须在实际写入前重新检查退避/开路。
        if (!state.circuit.check().allowed) return;
        try {
          await writeCard();
          state.circuit.recordSuccess();
          state.lastWriteAt = Date.now();
          deliveryError = "";
        } catch (error) {
          state.circuit.recordFailure();
          noteDeliveryError(error);
        }
      });
    }

    function scheduleFlush() {
      if (state.ended || paused) return;
      const elapsed = Date.now() - state.lastWriteAt;
      if (elapsed >= FEISHU_CARD_UPDATE_INTERVAL_MS) {
        void flush();
        return;
      }
      if (state.flushTimer) return;
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        void flush();
      }, FEISHU_CARD_UPDATE_INTERVAL_MS - elapsed);
      state.flushTimer.unref?.();
    }

    function appendText(text) {
      if (paused || state.ended) return;
      const value = String(text ?? "");
      if (!value) return;
      for (const block of state.blocks) {
        if (block.type === "tools") block.expanded = false;
      }
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.type === "message") {
        last.text += value;
      } else {
        state.blocks.push({ type: "message", text: value });
      }
      scheduleFlush();
    }

    function appendTool(summary, toolCallId) {
      if (paused || state.ended) return;
      const value = String(summary ?? "").trim();
      if (!value) return;
      const id = toolCallId == null || toolCallId === "" ? null : String(toolCallId);
      if (id !== null) {
        for (const block of state.blocks) {
          if (block.type !== "tools") continue;
          const index = block.toolCallIds?.indexOf(id) ?? -1;
          if (index < 0) continue;
          block.summaries[index] = value;
          scheduleFlush();
          return;
        }
      }
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.type === "tools") {
        last.toolCallIds ??= last.summaries.map(() => null);
        last.summaries.push(value);
        last.toolCallIds.push(id);
        last.expanded = true;
      } else {
        for (const block of state.blocks) {
          if (block.type === "tools") block.expanded = false;
        }
        state.blocks.push({ type: "tools", summaries: [value], toolCallIds: [id], expanded: true });
      }
      scheduleFlush();
    }

    async function startTyping() {
      if (!messageId) return;
      try {
        const data = await api.addReaction(messageId, TYPING_EMOJI);
        typingReactionId = data?.reaction_id ?? null;
      } catch (error) {
        // 缺 message_id 或权限不足时跳过，不发误导性的聊天级信号。
        log("debug", "feishu typing reaction skipped", { error: String(error?.message ?? error) });
      }
    }

    async function stopTyping() {
      if (!typingReactionId || !messageId) return;
      const reactionId = typingReactionId;
      typingReactionId = null;
      try {
        await api.removeReaction(messageId, reactionId);
      } catch (error) {
        log("debug", "feishu typing reaction cleanup failed", { error: String(error?.message ?? error) });
      }
    }

    /** 阻塞式交互（审批/提问）前封存当前卡：后续输出另起新卡。 */
    async function seal() {
      if (state.ended) return;
      const cardId = state.cardMessageId;
      // 快照封存时的 blocks：并入写卡链后，新输出可能已开始累积到新卡。
      const sealedBlocks = state.blocks;
      for (const block of sealedBlocks) {
        if (block.type === "tools") block.expanded = false;
      }
      state.cardMessageId = null;
      state.blocks = [];
      if (!cardId) return;
      const gate = state.circuit.check();
      if (!gate.allowed) return;
      await enqueue(async () => {
        if (!state.circuit.check().allowed) return;
        try {
          await api.updateMessage(
            cardId,
            "interactive",
            JSON.stringify(buildCardPayload({ blocks: sealedBlocks, status: "sealed" })),
          );

          state.circuit.recordSuccess();
        } catch (error) {
          state.circuit.recordFailure();
          noteDeliveryError(error);
        }
      });
    }

    async function end(status, details) {
      if (state.ended) return;
      if (paused) throw new Error("卡片已暂停，等待连接恢复");
      state.ended = true;
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      state.status = status === "error" ? "error" : "completed";
      if (details) state.blocks = finalizeCardBlocks(state.blocks, details);
      for (const block of state.blocks) {
        if (block.type === "tools") block.expanded = false;
      }
      await stopTyping();
      const gate = state.circuit.check();
      if (!gate.allowed) {
        log("warn", "feishu card terminal update suppressed", { reason: gate.reason, status: state.status });
        return;
      }
      await enqueue(async () => {
        if (!state.circuit.check().allowed) return;
        try {
          await writeCard();
          state.circuit.recordSuccess();
          deliveryError = "";
        } catch (error) {
          state.circuit.recordFailure();
          noteDeliveryError(error);
        }
      });
    }

    const typingReady = resume ? Promise.resolve() : startTyping();
    if (!resume) void flush();

    function snapshot() {
      return {
        target: { ...state.target }, blocks: structuredClone(state.blocks),
        cardMessageId: state.cardMessageId, typingReactionId,
        status: state.status, circuitState: state.circuit.state, lastWriteAt: state.lastWriteAt,
      };
    }
    async function pause() {
      paused = true;
      if (state.flushTimer) clearTimeout(state.flushTimer);
      state.flushTimer = null;
      await Promise.all([state.writeChain, typingReady]);
    }

    return { appendText, appendTool, seal, end, snapshot, pause };
  }

  async function start() {
    if (stopped) throw new Error("channel already stopped");
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret) throw new Error("飞书 App ID 或 App Secret 无效");
    onStatus?.("connecting");
    const reportStatus = (status) => {
      if (!stopped) onStatus?.(status);
    };
    const reportFailure = (error) => {
      if (stopped) return;
      const reason = String(error?.message ?? error);
      log("error", "feishu connection failed", { error: reason });
      onStatus?.("stopped", reason);
    };
    wsClient = new WSClient({
      appId,
      appSecret,
      onReady: () => reportStatus("connected"),
      onReconnecting: () => reportStatus("connecting"),
      onReconnected: () => reportStatus("connected"),
      onError: reportFailure,
    });
    void Promise.resolve(wsClient.start({ eventDispatcher: dispatcher })).catch(reportFailure);
  }

  async function stop() {
    stopped = true;
    try {
      wsClient?.close?.();
    } catch {
      /* 停机路径不因关闭报错而失败 */
    }
    wsClient = null;
    onStatus?.("stopped");
  }

  return {
    kind: "feishu",
    capabilities: { streamingCard: true },
    start,
    stop,
    sendText,
    sendChoice,
    uploadMedia,
    beginTurn,
    getDeliveryError: () => deliveryError,
    describe: () => ({ appId, deliveryError }),
  };
}

module.exports = { createFeishuChannel, parseContent };
