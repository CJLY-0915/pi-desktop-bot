"use strict";

async function readTurnMessages(invoke, sessionId, turnId, messageId) {
  let messages = [];
  let before;
  const boundaries = new Set();
  for (let page = 0; page < 100; page += 1) {
    const result = await invoke("session/get", [{ id: sessionId, messageLimit: 100, contentLimit: 65536, ...(before === undefined ? {} : { messageBefore: before }) }]);
    const session = result?.session;
    if (!Array.isArray(session?.messages)) throw new Error("宿主未返回会话消息");
    const seen = new Set(messages.filter(m => m.id).map(m => m.id));
    messages = [...session.messages.filter(m => !m.id || !seen.has(m.id)), ...messages];
    const start = messages.findIndex(m => messageId && m.id === messageId);
    const user = messages.findIndex(m => m.turnId === turnId && m.role === "user" && !m.parentToolCallId);
    const more = session.hasMoreBefore ?? result.hasMoreBefore;
    if (start >= 0 || user >= 0 || !more) {
      const anchor = start >= 0 ? start : user;
      const nextUser = messages.findIndex((m, index) => index > anchor && m.role === "user" && !m.parentToolCallId);
      const current = messages.filter((m, index) => m.turnId ? m.turnId === turnId : anchor >= 0 && index > anchor && (nextUser < 0 || index < nextUser));
      if (!current.length) throw new Error("快照未包含本轮消息");
      return current;
    }
    const boundary = session.messageStart ?? result.messageStart;
    if (!Number.isInteger(boundary) || boundary < 0 || boundaries.has(boundary)) throw new Error("宿主未提供有效的会话分页边界");
    boundaries.add(boundary);
    before = boundary;
  }
  throw new Error("本轮消息超过分页读取上限，请在桌面查看完整记录");
}
module.exports = { readTurnMessages };
