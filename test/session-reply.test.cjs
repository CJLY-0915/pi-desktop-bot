"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readTurnMessages } = require("../lib/session-reply.cjs");

test("长轮次向前分页、按消息去重，并排除相邻轮次", async () => {
  const calls = [];
  const messages = await readTurnMessages(async (operation, [input]) => {
    assert.equal(operation, "session/get"); calls.push(input);
    return input.messageBefore === undefined
      ? { session: { messageStart: 100, hasMoreBefore: true, messages: [{ id: "tool", role: "tool", turnId: "t" }, { id: "answer", role: "assistant", content: "结果", turnId: "t" }, { id: "other", role: "assistant", content: "其他轮次", turnId: "later" }] } }
      : { session: { messageStart: 0, hasMoreBefore: false, messages: [{ id: "old", role: "assistant", turnId: "old" }, { id: "user", role: "user", turnId: "t" }, { id: "tool", role: "tool", turnId: "t" }] } };
  }, "session", "t", "user");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messageBefore, 100);
  assert.deepEqual(messages.map(m => m.id), ["user", "tool", "answer"]);
});

test("没有 turnId 的旧消息使用确切用户消息边界，找不到时不猜最近消息", async () => {
  const invoke = async () => ({ session: { messages: [{ id: "u", role: "user" }, { id: "a", role: "assistant", content: "本轮" }, { id: "u2", role: "user" }, { id: "a2", role: "assistant", content: "后轮" }] } });
  assert.deepEqual((await readTurnMessages(invoke, "s", "t", "u")).map(m => m.id), ["a"]);
  await assert.rejects(readTurnMessages(invoke, "s", "unknown", "missing"), /未包含本轮/);
});
