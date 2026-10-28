"use strict";

const TEXT_REPLY_MODES = ["standard", "full", "summary"];
const TEXT_REPLY_CHANNELS = ["telegram", "weixin"];

function replyModeFor(settings, channel) {
  if (channel === "feishu") return "streaming_card";
  const saved = settings?.[`${channel}ReplyMode`] ?? settings?.replyMode;
  return TEXT_REPLY_MODES.includes(saved) ? saved : "standard";
}

module.exports = { TEXT_REPLY_MODES, TEXT_REPLY_CHANNELS, replyModeFor };
