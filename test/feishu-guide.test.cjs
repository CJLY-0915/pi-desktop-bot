"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { formatHelp } = require("../lib/render.cjs");

function harness() {
  const filename = require.resolve("../lib/feishu.cjs");
  const localRequire = createRequire(filename);
  const calls = [];
  let handlers;
  const choices = [];
  let failure = null;
  const sandbox = {
    module: { exports: {} },
    setTimeout, clearTimeout, structuredClone,
    require(name) {
      if (name === "../vendor/feishu.cjs") {
        return { EventDispatcher: class { register(value) { handlers = value; } } };
      }
      if (name === "./feishu-api.cjs") {
        return { createFeishuApi: () => ({ async sendMessage(chatId, type, content) {
          calls.push({ chatId, type, content: JSON.parse(content) });
          if (failure) throw failure;
          return { message_id: `om_${calls.length}` };
        }, async updateMessage(id, type, content) { calls.push({ id, type, content: JSON.parse(content), update: true }); } }) };
      }
      return localRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  return {
    channel: sandbox.module.exports.createFeishuChannel({ appId: "test", appSecret: "test", onChoice: async (choice) => { choices.push(choice); } }),
    calls,
    choices,
    click: (value) => handlers["card.action.trigger"]({ context: { open_chat_id: "oc_test" }, action: { value } }),
    fail: (error) => { failure = error; },
  };
}

test("帮助与绑定卡片展示精简主命令，更多卡片保留完整操作和授权语义", async () => {
  const h = harness();
  for (const more of [false, true]) {
    for (const prefix of ["", "绑定成功。发送 /帮助 查看可用命令。\n\n"]) {
      const text = prefix + formatHelp({ channel: "feishu" }, more);
      await h.channel.sendText("oc_test", text, { format: "command-guide" });
      const sent = h.calls.at(-1);
      assert.equal(sent.type, "interactive");
      assert.equal(sent.content.schema, "2.0");
      assert.equal(sent.content.body.elements.length, 1);
      const markdown = sent.content.body.elements[0];
      assert.equal(markdown.tag, "markdown");
      assert.match(markdown.content, /\*\*\/帮助\*\*/);
      assert.equal(markdown.content.replace(/\*\*/g, "").replace(/  \n/g, "\n"), text);
      if (more) {
        assert.match(markdown.content, /\*\*\/bind\*\* <绑定码>/);
        assert.match(markdown.content, /解除会话关联，保留聊天授权/);
        assert.ok(!markdown.content.includes("/回复"));
      } else {
        for (const command of ["项目", "模型", "思考"]) assert.ok(markdown.content.includes(`**/${command}**`));
        assert.ok(!markdown.content.includes("/model") && !markdown.content.includes("/切换"));
      }
    }
  }
});

test("普通回复也使用卡片，失败保留错误并在成功后清除", async () => {
  const h = harness();
  await h.channel.sendText("ou_test", "普通回复");
  assert.equal(h.calls[0].type, "interactive");
  assert.equal(h.calls[0].content.body.elements[0].content, "普通回复");
  h.fail(new Error("card rejected"));
  await assert.rejects(h.channel.sendText("ou_test", formatHelp(), { format: "command-guide" }), /card rejected/);
  assert.equal(h.channel.getDeliveryError(), "card rejected");
  h.fail(null);
  await h.channel.sendText("ou_test", formatHelp(), { format: "command-guide" });
  assert.equal(h.channel.getDeliveryError(), "");
});

test("状态、错误和长结果默认使用卡片并按顺序分段", async () => {
  const h = harness();
  for (const text of ["状态：idle\n模型：test", "执行失败：连接超时", "长结果".repeat(1500)]) {
    const start = h.calls.length;
    await h.channel.sendText("oc_test", text);
    const messages = h.calls.slice(start);
    assert.ok(messages.every((message) => message.type === "interactive"));
    const parts = messages.map((message) => message.content.body.elements[0].content.replace(/  \n/g, "\n"));
    assert.equal(parts.join(""), text);
    if (text.length > 1800) assert.ok(messages.length > 1);
  }
});

test("选择卡片使用 2.0 按钮回调并传回原选择", async () => {
  const h = harness();
  await h.channel.sendChoice("oc_test", { choiceId: "choice-1", title: "需要确认", prompt: "是否继续？", options: ["批准", "拒绝"] });
  const message = h.calls[0];
  assert.equal(message.type, "interactive");
  assert.equal(message.content.schema, "2.0");
  const elements = message.content.body.elements;
  assert.equal(elements[0].tag, "markdown");
  assert.ok(elements.slice(1).every((element) => element.tag === "button"));
  const behavior = elements[2].behaviors[0];
  assert.equal(behavior.type, "callback");
  await h.click(behavior.value);
  assert.equal(h.choices.length, 1);
  assert.equal(h.choices[0].choiceId, "choice-1");
  assert.equal(h.choices[0].selection, "2");
  assert.equal(h.choices[0].chatId, "oc_test");
});

test("流式正文与工具按序同卡更新，同 id 不重复，旧工具块及完成状态折叠", async () => {
  const h = harness();
  const turn = h.channel.beginTurn({ chatId: "oc_test" });
  turn.appendText("正在处理");
  turn.appendTool("执行中 · Read · `src/app.js`", "read-1");
  turn.appendTool("执行中 · Read · `src/app.js:10`", "read-1");
  await new Promise(resolve => setImmediate(resolve));
  const running = h.calls.at(-1).content.body.elements;
  assert.equal(running[1].expanded, true);
  assert.equal(running[1].header.title.content, "🛠️ 工具摘要 (1)");
  assert.match(running.at(-1).content, /⏳ 运行中/);
  turn.appendText("已读完文件");
  turn.appendTool("完成 · Read · `src/app.js`", "read-1");
  turn.appendTool("执行中 · Bash · `npm test`", "bash-1");
  turn.appendTool("兼容字符串工具");
  const snapshot = turn.snapshot();
  assert.equal(snapshot.blocks[1].expanded, false);
  assert.equal(snapshot.blocks[1].summaries.length, 1);
  assert.equal(snapshot.blocks[3].expanded, true);
  assert.equal(snapshot.blocks[3].summaries.length, 2);
  await turn.end("completed");
  const elements = h.calls.at(-1).content.body.elements;
  assert.deepEqual(Array.from(elements, e => e.tag), ["markdown", "collapsible_panel", "markdown", "collapsible_panel", "markdown"]);
  assert.equal(elements[0].content, "正在处理");
  assert.equal(elements[2].content, "已读完文件");
  assert.equal(elements[1].expanded, false);
  assert.equal(elements[3].expanded, false);
  assert.equal(elements.at(-1).content, "**✅ 已完成**");
  assert.equal(h.calls.filter(call => !call.update).length, 1);
});

test("status 卡片使用 hr 且保持代码块原文，普通消息保留 markdown 分隔线", async () => {
  const h = harness();
  const code = "```text\n------\nvalue\n```";
  await h.channel.sendText("oc_test", `状态：idle\n------\n${code}\n------\n模型：test`, { format: "status" });
  const elements = h.calls.at(-1).content.body.elements;
  assert.deepEqual(elements.map(e => e.tag), ["markdown", "hr", "markdown", "hr", "markdown"]);
  assert.equal(elements[2].content, code);
  await h.channel.sendText("oc_test", "正文\n------\n后续");
  assert.equal(h.calls.at(-1).content.body.elements.length, 1);
  assert.match(h.calls.at(-1).content.body.elements[0].content, /---/);
});

test("status 的大量分隔线和长正文仍受元素和文本预算限制", async () => {
  const h = harness();
  const { FEISHU_CARD_ELEMENT_BUDGET } = require("../lib/constants.cjs");
  await h.channel.sendText("oc_test", `${"项\n------\n".repeat(200)}${"长正文".repeat(1400)}`, { format: "status" });
  assert.ok(h.calls.length > 2);
  assert.ok(h.calls.every(call => call.content.body.elements.length <= FEISHU_CARD_ELEMENT_BUDGET));
  assert.equal(h.calls.flatMap(call => call.content.body.elements).filter(e => e.tag === "hr").length, 200);
  assert.equal(h.calls.flatMap(call => call.content.body.elements).filter(e => e.tag === "markdown").map(e => e.content).join(""), `${"项".repeat(200)}${"长正文".repeat(1400)}`);
});
