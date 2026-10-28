"use strict";
const { randomUUID } = require("node:crypto");
const TTL_MS = 10 * 60 * 1000;

function createPhoneQuestions({ sendChoice, send, isAuthorized, now = Date.now }) {
  const requests = new Map();
  function live(request) {
    if (!request || now() >= request.expiresAt || !isAuthorized(request)) {
      if (request) requests.delete(request.id);
      return false;
    }
    return true;
  }
  async function show(request) {
    const question = request.questions[request.index];
    request.choiceId = `${request.id}:${request.index}`;
    const result = await sendChoice(request.chatId, {
      choiceId: request.choiceId,
      guard: () => live(request),
      title: `请回答 (${request.index + 1}/${request.questions.length})`,
      prompt: `${question.question}\n${question.multiSelect ? "可多选，回复序号以逗号分隔；也可直接输入答案。" : "请选择或直接输入答案。"}\n发送 /取消提问 结束等待。`,
      options: question.options,
    });
    if (result?.delivered === false) throw new Error("手机问题发送失败，请检查渠道后重新提问");
  }
  return {
    async request(event, location) {
      for (const request of requests.values()) {
        if (!live(request)) continue;
        if (request.channel === location.channel && request.chatId === location.chatId && !request.done) throw new Error("已有待回答的问题");
      }
      if (!Array.isArray(event.questions) || !event.questions.length || event.questions.length > 10) throw new Error("问题数量应为 1 至 10");
      const questions = event.questions.map(q => {
        if (typeof q.question !== "string" || !q.question.trim() || q.question.length > 300 || !Array.isArray(q.options) || !q.options.length || q.options.length > 20 || q.options.some(o => typeof o !== "string" || !o.trim() || o.length > 300)) throw new Error("问题或选项格式无效");
        return { question: q.question.trim(), options: q.options.map(o => o.trim()), multiSelect: q.multiSelect === true };
      });
      const request = { ...location, id: randomUUID(), runId: event.runId, sessionId: event.sessionId, questions, answers: [], index: 0, expiresAt: now() + TTL_MS };
      requests.set(request.id, request);
      try { await show(request); }
      catch (error) { requests.delete(request.id); throw error; }
      return { requestId: request.id };
    },
    poll(event) {
      const request = requests.get(event.requestId);
      if (!live(request) || request.sessionId !== event.sessionId || request.runId !== event.runId) return { state: "expired" };
      if (!request.done) return { state: "pending" };
      requests.delete(request.id);
      return { state: request.cancelled ? "cancelled" : "answered", answers: request.answers };
    },
    cancel(event) {
      const request = requests.get(event.requestId);
      if (request?.sessionId === event.sessionId && request.runId === event.runId) requests.delete(request.id);
    },
    async answer(channel, chatId, text, choiceId) {
      const request = [...requests.values()].find(r => r.channel === channel && r.chatId === chatId && !r.done && live(r));
      if (!request || (choiceId && request.choiceId !== choiceId)) return false;
      if (text === "/取消提问") {
        request.cancelled = request.done = true;
        await send(chatId, "已取消提问。");
        return true;
      }
      if (!choiceId && text.startsWith("/")) return false;
      if (!text.trim() || text.length > 4000) { await send(chatId, "答案应为 1 至 4000 字。"); return true; }
      const question = request.questions[request.index];
      let answer;
      if (/^\s*\d+(?:\s*[,，、]\s*\d+)*\s*$/.test(text)) {
        const indexes = [...new Set(text.split(/[,，、]/).map(n => Number(n.trim())))];
        if ((!question.multiSelect && indexes.length > 1) || indexes.some(n => n < 1 || n > question.options.length)) {
          await send(chatId, "请选择有效的选项序号。");
          return true;
        }
        answer = indexes.map(n => question.options[n - 1]);
      } else answer = [text.trim()];
      request.answers.push(answer);
      request.index += 1;
      if (request.index === request.questions.length) {
        request.done = true;
        await send(chatId, "已收到答案，继续执行。");
      } else {
        try { await show(request); }
        catch {
          request.done = request.cancelled = true;
          await send(chatId, "后续问题发送失败，本次提问已取消，请稍后重新提问。");
        }
      }
      return true;
    },
    clear() { requests.clear(); },
  };
}
module.exports = { createPhoneQuestions };
