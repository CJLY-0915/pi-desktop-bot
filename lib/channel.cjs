"use strict";

/**
 * 统一通道接口。飞书 / 钉钉 / Telegram / 微信适配器都实现它；
 * 新增通道只需再写一个适配器并在此注册。
 *
 * 入站消息统一为：
 * { chatId, userId, text, messageId, images: string[] }  images 为已下载到本机的路径
 *
 * 选择请求（远程审批 / Agent 提问）统一为：
 * { choiceId, prompt, options: string[], multiSelect }
 * 适配器自行渲染：飞书用互动卡片按钮，钉钉用编号文本，Telegram 用内联按钮。
 *
 * 回传回合（可选能力，capabilities.streamingCard 为 true 时提供）：
 * channel.beginTurn({ chatId, messageId }) → 回合句柄 | null
 *   handle.appendText(text)  增量正文（通道内部合并写卡）
 *   handle.appendTool(summary)  工具调用摘要
 *   handle.seal()            阻塞式交互前封存当前卡，后续输出另起新卡
 *   handle.end(status)       回合结束（completed / error），封存终态
 * 句柄为 null 或通道未提供时，bridge 回落 sendChunked 文本分段。
 *
 * 可选 sendTyping(chatId)：文本回落通道的"正在输入"提示
 * （Telegram sendChatAction / 微信 sendtyping），失败不影响任务。
 * sendText(chatId, text, options?)：飞书统一发送 Markdown 卡片；format="command-guide" 额外加粗帮助命令。
 */

const {
  CHANNEL_KIND_FEISHU,
  CHANNEL_KIND_DINGTALK,
  CHANNEL_KIND_TELEGRAM,
  CHANNEL_KIND_WEIXIN,
} = require("./constants.cjs");

function createChannel(kind, options) {
  if (kind === CHANNEL_KIND_FEISHU) {
    const { createFeishuChannel } = require("./feishu.cjs");
    return createFeishuChannel(options);
  }
  if (kind === CHANNEL_KIND_DINGTALK) {
    const { createDingtalkChannel } = require("./dingtalk.cjs");
    return createDingtalkChannel(options);
  }
  if (kind === CHANNEL_KIND_TELEGRAM) {
    const { createTelegramChannel } = require("./telegram.cjs");
    return createTelegramChannel(options);
  }
  if (kind === CHANNEL_KIND_WEIXIN) {
    const { createWeixinChannel } = require("./weixin.cjs");
    return createWeixinChannel(options);
  }
  throw new Error(`unsupported channel: ${kind}`);
}

module.exports = { createChannel };
