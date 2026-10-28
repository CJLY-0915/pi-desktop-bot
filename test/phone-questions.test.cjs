"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPhoneQuestions } = require("../lib/phone-questions.cjs");

test("手机问答支持逐题、多选和自定义文字，旧按钮与其他聊天不消费", async () => {
  const shown = []; const messages = [];
  const questions = createPhoneQuestions({ sendChoice: async (chatId, request) => shown.push({ chatId, ...request }), send: async (_chatId, text) => messages.push(text), isAuthorized: () => true });
  const event = { sessionId: "s1", runId: "r1", questions: [{ question: "平台", options: ["飞书", "微信"], multiSelect: true }, { question: "名称", options: ["默认"] }] };
  const { requestId } = await questions.request(event, { channel: "feishu", chatId: "c1" });
  const poll = { ...event, requestId };
  assert.equal(questions.poll(poll).state, "pending");
  assert.equal(await questions.answer("feishu", "other", "1"), false);
  await questions.answer("feishu", "c1", "1,3");
  assert.match(messages.at(-1), /有效的选项/);
  const old = shown[0].choiceId;
  await questions.answer("feishu", "c1", "1,2");
  assert.equal(shown.length, 2);
  assert.equal(await questions.answer("feishu", "c1", "1", old), false);
  await questions.answer("feishu", "c1", "自定义名称");
  assert.deepEqual(questions.poll(poll), { state: "answered", answers: [["飞书", "微信"], ["自定义名称"]] });
  assert.equal(questions.poll(poll).state, "expired");
});

test("手机问答隔离 run、授权和过期，支持取消且清理等待", async () => {
  let allowed = true; let clock = 0;
  const questions = createPhoneQuestions({ sendChoice: async () => {}, send: async () => {}, isAuthorized: () => allowed, now: () => clock });
  const event = { sessionId: "s1", runId: "r1", questions: [{ question: "确认内容", options: ["A"] }] };
  const location = { channel: "telegram", chatId: "c1" };
  let poll = { ...event, ...(await questions.request(event, location)) };
  assert.equal(questions.poll({ ...poll, runId: "other" }).state, "expired");
  assert.equal(questions.poll(poll).state, "pending");
  assert.equal(await questions.answer("telegram", "c1", "/status"), false);
  await questions.answer("telegram", "c1", "/取消提问");
  assert.equal(questions.poll(poll).state, "cancelled");
  poll = { ...event, ...(await questions.request(event, location)) };
  allowed = false;
  assert.equal(questions.poll(poll).state, "expired");
  allowed = true;
  poll = { ...event, ...(await questions.request(event, location)) };
  clock = 600001;
  assert.equal(questions.poll(poll).state, "expired");
  poll = { ...event, ...(await questions.request(event, location)) };
  questions.clear();
  assert.equal(questions.poll(poll).state, "expired");
});
