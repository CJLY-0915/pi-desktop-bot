"use strict";

/**
 * 插件内跨进程共享常量。
 * main.js（插件进程）与 extensions/agent.js（Agent 进程）都依赖本文件，
 * 修改 REMOTE_TAG 或 IPC 事件名时必须同步两侧行为。
 */

const PLUGIN_ID = "pi.mobile-remote-control";
const SERVICE_ID = "bridge";

/** 远程注入 prompt 的来源标记；Agent 扩展据此识别“本轮由远程驱动”。 */
const REMOTE_TAG_PREFIX = "[远程/";

const CHANNEL_KIND_FEISHU = "feishu";
const CHANNEL_KIND_DINGTALK = "dingtalk";
const CHANNEL_KIND_TELEGRAM = "telegram";
const CHANNEL_KIND_WEIXIN = "weixin";
const CHANNEL_KINDS = [
  CHANNEL_KIND_FEISHU,
  CHANNEL_KIND_DINGTALK,
  CHANNEL_KIND_TELEGRAM,
  CHANNEL_KIND_WEIXIN,
];

// ---------- Telegram Bot API ----------
const TELEGRAM_API_BASE = "https://api.telegram.org";
/** 单条消息文本上限（官方 4096，留余量）；选择提示按钮挂在最后一条上。 */
const TELEGRAM_TEXT_LIMIT = 3900;
/** 服务端长轮询等待秒数（官方上限 25s 内的保守值）。 */
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
/** 客户端请求超时：必须大于服务端等待，覆盖响应体读取。 */
const TELEGRAM_POLL_TIMEOUT_MS = 40000;
/** 轮询出错后的重试间隔。 */
const TELEGRAM_POLL_RETRY_MS = 2000;
/** 附件下载超时。 */
const TELEGRAM_FILE_TIMEOUT_MS = 30000;

// ---------- 微信 iLink Bot ----------
const WEIXIN_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_BOT_API_PREFIX = "/ilink/bot";
const WEIXIN_CHANNEL_VERSION = "2.0.0";
// iLink 公共客户端使用 bot 应用标识，版本按 major/minor/patch 编为 uint32。
const WEIXIN_APP_HEADERS = Object.freeze({
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": String(WEIXIN_CHANNEL_VERSION.split(".").reduce((value, part) => (value << 8) | Number(part), 0)),
});
/** 入站消息中机器人自己发出的类型，需过滤避免自环。 */
const WEIXIN_MESSAGE_TYPE_BOT = 2;
const WEIXIN_GET_UPDATES_TIMEOUT_MS = 90000;
const WEIXIN_LOGIN_INTERVAL_SECONDS = 3;
const WEIXIN_LOGIN_EXPIRE_SECONDS = 120;
const WEIXIN_LOGIN_REQUEST_TIMEOUT_MS = 30000;

const IPC_EVENTS = {
  agentStart: "agent_start",
  assistantChunk: "assistant_chunk",
  assistantMessage: "assistant_message",
  toolProgress: "tool_progress",
  fileChange: "file_change",
  agentEnd: "agent_end",
  askBlocked: "ask_blocked",
  sendFile: "send_file",
  phoneQuestion: "phone_question",
  phoneQuestionPoll: "phone_question_poll",
  phoneQuestionCancel: "phone_question_cancel",
};

const STATE_FILE = "state.json";
const CREDENTIALS_FILE = "credentials.json";
const IPC_FILE = "ipc.json";
const AUDIT_FILE = "audit.jsonl";
const AUDIT_MAX_BYTES = 512 * 1024;

/** 与宿主 agent/askTool/resolve、plans/resolve 的取值保持一致。 */
const PERMISSION_DECISIONS = ["allow-once", "allow-session", "deny"];

const DANGEROUS_COMMANDS = new Set(["/project", "/model", "/think", "/mode", "/permission"]);

/** 飞书 Card JSON 2.0 单卡组件预算：官方上限 200，留余量防 230099/11310。 */
const FEISHU_CARD_ELEMENT_BUDGET = 180;
/** 卡片写失败连续次数达到该值即开路，本回合不再写卡（新入站消息开新回合）。 */
const FEISHU_CARD_CIRCUIT_FAILURES = 3;
/** 卡片写失败退避序列（事件驱动，不建重试定时器）。 */
const FEISHU_CARD_BACKOFF_MS = [1000, 2000];
/** 卡片更新合并窗口：增量文本到达后最多每这么久真正写一次卡。 */
const FEISHU_CARD_UPDATE_INTERVAL_MS = 1000;
/** 单条入站消息附件个数与单附件字节上限（对齐 ZCode Bot 实测规则）。 */
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** 仅有附件、无文本时的默认提示语。 */
const ATTACHMENT_ONLY_PROMPT = "请查看附件并根据内容协助我。";

module.exports = {
  PLUGIN_ID,
  SERVICE_ID,
  REMOTE_TAG_PREFIX,
  CHANNEL_KIND_FEISHU,
  CHANNEL_KIND_DINGTALK,
  CHANNEL_KIND_TELEGRAM,
  CHANNEL_KIND_WEIXIN,
  CHANNEL_KINDS,
  TELEGRAM_API_BASE,
  TELEGRAM_TEXT_LIMIT,
  TELEGRAM_POLL_TIMEOUT_SECONDS,
  TELEGRAM_POLL_TIMEOUT_MS,
  TELEGRAM_POLL_RETRY_MS,
  TELEGRAM_FILE_TIMEOUT_MS,
  WEIXIN_ILINK_BASE_URL,
  WEIXIN_BOT_API_PREFIX,
  WEIXIN_CHANNEL_VERSION,
  WEIXIN_APP_HEADERS,
  WEIXIN_MESSAGE_TYPE_BOT,
  WEIXIN_GET_UPDATES_TIMEOUT_MS,
  WEIXIN_LOGIN_INTERVAL_SECONDS,
  WEIXIN_LOGIN_EXPIRE_SECONDS,
  WEIXIN_LOGIN_REQUEST_TIMEOUT_MS,
  IPC_EVENTS,
  STATE_FILE,
  CREDENTIALS_FILE,
  IPC_FILE,
  AUDIT_FILE,
  AUDIT_MAX_BYTES,
  PERMISSION_DECISIONS,
  DANGEROUS_COMMANDS,
  FEISHU_CARD_ELEMENT_BUDGET,
  FEISHU_CARD_CIRCUIT_FAILURES,
  FEISHU_CARD_BACKOFF_MS,
  FEISHU_CARD_UPDATE_INTERVAL_MS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_ONLY_PROMPT,
};
