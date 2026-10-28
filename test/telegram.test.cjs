"use strict";

/**
 * telegram：update 解析、回调数据解码、文本分段、Markdown 回落决策，
 * 以及适配器发送路径（注入 requestJson，不触网）。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  createTelegramChannel,
  parseUpdate,
  splitTelegramText,
  decodeCallbackData,
  shouldResendAsPlain,
} = require("../lib/telegram.cjs");

test("解析私聊文本消息", () => {
  const parsed = parseUpdate({
    update_id: 10,
    message: {
      message_id: 77,
      text: "  你好  ",
      chat: { id: 4242, type: "private" },
      from: { id: 99, username: "alice" },
    },
  });
  assert.equal(parsed.chatId, "4242");
  assert.equal(parsed.userId, "99");
  assert.equal(parsed.text, "你好");
  assert.equal(parsed.messageId, "77");
  assert.equal(parsed.chatType, "private");
  assert.deepEqual(parsed.attachments, []);
});

test("解析图片消息：photo 取最大尺寸，caption 作为文本", () => {
  const parsed = parseUpdate({
    message: {
      message_id: 78,
      caption: "看这个",
      chat: { id: -100, type: "supergroup" },
      from: { id: 99 },
      photo: [
        { file_id: "small", width: 90 },
        { file_id: "large", width: 1280, file_size: 20480 },
      ],
    },
  });
  assert.equal(parsed.text, "看这个");
  assert.equal(parsed.chatType, "group");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].providerFileId, "large");
  assert.equal(parsed.attachments[0].kind, "image");
  assert.equal(parsed.attachments[0].sizeBytes, 20480);
});

test("解析文档与语音附件", () => {
  const parsed = parseUpdate({
    message: {
      message_id: 79,
      chat: { id: 5, type: "private" },
      from: { id: 99 },
      document: { file_id: "doc1", file_name: "报表.pdf", mime_type: "application/pdf" },
      voice: { file_id: "v1" },
    },
  });
  assert.equal(parsed.text, "");
  assert.deepEqual(
    parsed.attachments.map((item) => [item.kind, item.filename]),
    [
      ["file", "报表.pdf"],
      ["audio", "telegram-voice.ogg"],
    ],
  );
});

test("解析按钮回调：序号透传，携带 callbackQueryId", () => {
  const parsed = parseUpdate({
    callback_query: {
      id: "cb-9",
      data: "2",
      from: { id: 99 },
      message: { message_id: 80, chat: { id: 4242, type: "private" } },
    },
  });
  assert.equal(parsed.text, "2");
  assert.equal(parsed.messageId, "cb-9");
  assert.equal(parsed.callbackQueryId, "cb-9");
  assert.equal(parsed.chatId, "4242");
});

test("无 message 也无 callback 的 update 返回 null", () => {
  assert.equal(parseUpdate({ update_id: 1, edited_message: {} }), null);
  assert.equal(parseUpdate({ message: { chat: { id: 1 }, from: { id: 2 } } }), null);
});

test("decodeCallbackData 保留 zc: 约定，裸序号透传", () => {
  assert.equal(decodeCallbackData("zc:cancel"), "/cancel");
  assert.equal(decodeCallbackData("zc:e:tok-1:2"), "/elicitation tok-1 2");
  assert.equal(decodeCallbackData("zc:cmd:/model set 1"), "/model set 1");
  assert.equal(decodeCallbackData("zc:plan:1"), "/plan 1");
  assert.equal(decodeCallbackData("1"), "1");
});

test("splitTelegramText 按 3900 分段，空串返回原串", () => {
  assert.equal(splitTelegramText("x".repeat(3900)).length, 1);
  assert.equal(splitTelegramText("x".repeat(3901)).length, 2);
  assert.deepEqual(splitTelegramText(""), [""]);
});

test("shouldResendAsPlain 仅对明确格式拒绝回落", () => {
  assert.equal(shouldResendAsPlain({ status: 400, data: { description: "can't parse entities" } }), true);
  assert.equal(shouldResendAsPlain({ status: 400, data: {} }), true);
  assert.equal(shouldResendAsPlain({ status: 400, data: { description: "chat not found" } }), false);
  assert.equal(shouldResendAsPlain({ status: 429, data: { description: "flood" } }), false);
});

function createAdapter(overrides = {}) {
  const requests = [];
  const channel = createTelegramChannel({
    botToken: "T",
    dataDir: os.tmpdir(),
    onMessage: () => {},
    requestJson: async (options) => {
      requests.push(options);
      const handler = overrides[options.url.split("/botT/")[1]?.split("?")[0]];
      return handler ? handler(options) : { status: 200, data: { ok: true, result: [] } };
    },
    ...overrides.channelOptions,
  });
  return { channel, requests };
}

test("sendText：Markdown 被拒时自动回落纯文本重发", async () => {
  let sendCount = 0;
  const { channel, requests } = createAdapter({
    sendMessage: (options) => {
      sendCount += 1;
      if (sendCount === 1) {
        return { status: 400, data: { ok: false, description: "Bad Request: can't parse entities" } };
      }
      assert.equal(options.body.parse_mode, undefined, "第二次不得带 parse_mode");
      return { status: 200, data: { ok: true } };
    },
  });
  const result = await channel.sendText("4242", "**加粗**");
  assert.deepEqual(result, { delivered: true });
  assert.equal(sendCount, 2);
  assert.equal(requests[0].body.parse_mode, "Markdown");
});

test("sendText：投递失败返回 delivered:false 并记录原因", async () => {
  const { channel } = createAdapter({
    sendMessage: () => ({ status: 403, data: { ok: false, description: "bot was blocked" } }),
  });
  const result = await channel.sendText("4242", "hi");
  assert.equal(result.delivered, false);
  assert.match(result.reason, /bot was blocked/);
  assert.match(channel.getDeliveryError(), /bot was blocked/);
});

test("sendChoice：编号文本 + 内联按钮，按钮只挂在最后一条", async () => {
  const { channel, requests } = createAdapter();
  const result = await channel.sendChoice("4242", {
    choiceId: "p1",
    title: "Plan 检查点需要批准",
    prompt: "部署计划\n1. 批准执行\n2. 拒绝",
    options: ["批准执行", "拒绝"],
  });
  assert.deepEqual(result, { delivered: true });
  assert.equal(requests.length, 1);
  const body = requests[0].body;
  assert.equal(body.reply_markup.inline_keyboard.length, 2);
  assert.equal(body.reply_markup.inline_keyboard[0][0].text, "批准执行");
  assert.match(body.reply_markup.inline_keyboard[0][0].callback_data, /^pi:[^:]+:1$/);
  assert.match(body.reply_markup.inline_keyboard[1][0].callback_data, /^pi:[^:]+:2$/);
  assert.ok(Buffer.byteLength(body.reply_markup.inline_keyboard[0][0].callback_data) <= 64);
  assert.match(body.text, /也可以直接点击下方按钮。/);
});

test("命令菜单：Telegram 保留数字回复及按钮，取消按钮保持原有回调映射", async () => {
  const { channel, requests } = createAdapter();
  await channel.sendChoice("4242", { choiceId: "menu:project", title: "选择项目", prompt: "", options: ["项目甲", "项目乙", "取消"] });
  const body = requests[0].body;
  assert.equal(body.text, "选择项目\n0. 取消\n\n1. 项目甲\n2. 项目乙\n\n回复数字选择，0 取消。\n也可以直接点击下方按钮。");
  assert.deepEqual(body.reply_markup.inline_keyboard.map(row => row[0].text), ["项目甲", "项目乙", "取消"]);
  assert.match(body.reply_markup.inline_keyboard[2][0].callback_data, /:3$/);
});

test("sendTyping 发送 sendChatAction", async () => {
  const { channel, requests } = createAdapter();
  await channel.sendTyping("4242");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /sendChatAction$/);
  assert.deepEqual(requests[0].body, { chat_id: "4242", action: "typing" });
});

test("start：getMe 失败即抛出，不进入轮询", async () => {
  const { channel } = createAdapter({
    getMe: () => ({ status: 401, data: { ok: false, description: "Unauthorized" } }),
  });
  await assert.rejects(() => channel.start(), /Unauthorized/);
});

test("start：getMe 通过后报 connected", async () => {
  const statuses = [];
  const { channel } = createAdapter({
    channelOptions: { onStatus: (status) => statuses.push(status) },
  });
  await channel.start();
  assert.deepEqual(statuses, ["connecting", "connected"]);
  await channel.stop();
});
