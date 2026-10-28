"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function harness(options = {}) {
  const file = require.resolve("../lib/feishu.cjs");
  const localRequire = createRequire(file);
  const calls = [];
  const api = {
    async sendMessage(...args) { calls.push({ type: "create", args }); await options.send?.(); return { message_id: "original-card" }; },
    async updateMessage(...args) { calls.push({ type: "update", args }); await options.update?.(); },
    async addReaction() { return { reaction_id: "typing-reaction" }; },
    async removeReaction(...args) { calls.push({ type: "remove-reaction", args }); },
  };
  const sandbox = {
    module: { exports: {} }, setTimeout, clearTimeout, structuredClone, Date: options.Date ?? Date,
    require: name => name === "../vendor/feishu.cjs" ? {
      WSClient: class {}, EventDispatcher: class { register() {} },
    } : name === "./feishu-api.cjs" ? { createFeishuApi: () => api } : localRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  return { calls, create: () => sandbox.module.exports.createFeishuChannel({ appId: "cli_test", appSecret: "secret" }) };
}

test("飞书暂停等待首次建卡，恢复复用原卡片与 typing 反应", async () => {
  let release;
  const sending = new Promise(resolve => { release = resolve; });
  const h = harness({ send: () => sending });
  const old = h.create().beginTurn({ chatId: "oc_test", messageId: "inbound" });
  old.appendText("已输出正文");
  let paused = false;
  const pending = old.pause().then(() => { paused = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused, false);
  release();
  await pending;
  const snapshot = old.snapshot();
  assert.equal(snapshot.cardMessageId, "original-card");
  assert.equal(snapshot.typingReactionId, "typing-reaction");
  const before = h.calls.length;
  old.appendText("暂停后丢弃的旧事件");
  await assert.rejects(old.end("completed"), /已暂停/);
  assert.equal(h.calls.length, before);
  const restored = h.create().beginTurn({ chatId: "oc_test", messageId: "inbound", resume: snapshot });
  restored.appendText("，最终回复。");
  await restored.end("completed");
  assert.equal(h.calls.filter(call => call.type === "create").length, 1);
  const update = h.calls.filter(call => call.type === "update").at(-1);
  assert.equal(update.args[0], "original-card");
  assert.match(update.args[2], /已输出正文，最终回复。/);
  assert.match(update.args[2], /已完成/);
  assert.ok(!update.args[2].includes("暂停后丢弃"));
  assert.equal(h.calls.filter(call => call.type === "remove-reaction").length, 1);
});

test("暂停恢复保留工具 id、顺序、展开状态，旧块结束事件不产生重复工具", async () => {
  const h = harness();
  const old = h.create().beginTurn({ chatId: "oc_test" });
  old.appendText("先说明");
  old.appendTool("执行中 · Read · `a.js`", "read-1");
  await old.pause();
  const snapshot = old.snapshot();
  assert.equal(snapshot.blocks[1].expanded, true);
  assert.equal(snapshot.blocks[1].toolCallIds[0], "read-1");
  const turn = h.create().beginTurn({ chatId: "oc_test", resume: snapshot });
  turn.appendTool("完成 · Read · `a.js`", "read-1");
  assert.equal(turn.snapshot().blocks[1].summaries.length, 1);
  turn.appendText("再解释");
  turn.appendTool("执行中 · Bash · `npm test`", "bash-1");
  turn.appendTool("失败 · Read · `a.js`", "read-1");
  assert.equal(snapshot.blocks[1].summaries[0], "执行中 · Read · `a.js`");
  await turn.end("error");
  const elements = JSON.parse(h.calls.filter(c => c.type === "update").at(-1).args[2]).body.elements;
  assert.deepEqual(elements.map(e => e.tag), ["markdown", "collapsible_panel", "markdown", "collapsible_panel", "markdown"]);
  assert.equal(elements[1].header.title.content, "🛠️ 工具摘要 (1)");
  assert.equal(elements[1].elements[0].content, "失败 · Read · `a.js`");
  assert.equal(elements[1].expanded, false);
  assert.equal(elements[3].expanded, false);
  assert.equal(elements.at(-1).content, "**❌ 已终止**");
  assert.equal(h.calls.filter(c => c.type === "create").length, 1);
});

test("已排队的 flush 与结束写入不能绕开前一请求失败后的退避", async () => {
  let rejectSend;
  const pending = new Promise((resolve, reject) => { rejectSend = reject; });
  const h = harness({ send: () => pending });
  const channel = h.create();
  const turn = channel.beginTurn({ chatId: "oc_test" });
  turn.appendText("正文");
  turn.appendTool("执行中 · Bash", "bash-1");
  const ending = turn.end("error");
  await new Promise(resolve => setImmediate(resolve));
  rejectSend(new Error("write rejected"));
  await ending;
  assert.equal(h.calls.filter(c => c.type === "create").length, 1);
  assert.equal(h.calls.filter(c => c.type === "update").length, 0);
  assert.equal(channel.getDeliveryError(), "write rejected");
  assert.equal(turn.snapshot().circuitState.failures, 1);
});

test("恢复同一回合保留开路状态，不发送工具进度或结束写入", async () => {
  let clock = 10000;
  const h = harness({ Date: { now: () => clock }, update: () => { throw new Error("update failed"); } });
  const turn = h.create().beginTurn({ chatId: "oc_test", resume: { cardMessageId: "existing", blocks: [] } });
  for (let index = 0; index < 3; index += 1) {
    turn.appendTool(`执行中 · Bash · \`step ${index}\``, "bash-1");
    await new Promise(resolve => setImmediate(resolve));
    clock += 3000;
  }
  await turn.pause();
  const snapshot = turn.snapshot();
  assert.equal(snapshot.circuitState.open, true);
  const before = h.calls.length;
  const restored = h.create().beginTurn({ chatId: "oc_test", resume: snapshot });
  restored.appendTool("完成 · Bash", "bash-1");
  await restored.end("completed");
  assert.equal(h.calls.length, before);
  assert.equal(restored.snapshot().blocks[0].summaries.length, 1);
});

test("封存工具块折叠，后续工具从新卡开始", async () => {
  const h = harness();
  const turn = h.create().beginTurn({ chatId: "oc_test" });
  turn.appendTool("执行中 · Read", "read-1");
  await new Promise(resolve => setImmediate(resolve));
  await turn.seal();
  const sealed = JSON.parse(h.calls.filter(c => c.type === "update").at(-1).args[2]).body.elements;
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0].expanded, false);
  turn.appendTool("执行中 · Bash", "bash-1");
  assert.equal(turn.snapshot().blocks[0].expanded, true);
  await turn.end("completed");
  assert.equal(h.calls.filter(c => c.type === "create").length, 2);
});

test("真实飞书句柄结束时输出折叠过程与独立最终答复，尾注不进入过程", async () => {
  const h = harness();
  const turn = h.create().beginTurn({ chatId: "oc_test" });
  turn.appendText("先检查");
  turn.appendTool("完成 · Read · app.js", "read-1");
  turn.appendText("最终答复");
  turn.appendText("\n\n文件变更：1 个文件");
  await turn.end("completed", { finalText: "最终答复", footerText: "文件变更：1 个文件" });
  const elements = JSON.parse(h.calls.filter(c => c.type === "update").at(-1).args[2]).body.elements;
  assert.equal(elements[0].tag, "collapsible_panel");
  assert.equal(elements[0].expanded, false);
  assert.match(JSON.stringify(elements[0]), /先检查.*Read/);
  assert.doesNotMatch(JSON.stringify(elements[0]), /最终答复|文件变更/);
  assert.equal(elements[1].content, "最终答复");
  assert.equal(elements[2].content, "文件变更：1 个文件");
  assert.equal(elements.at(-1).content, "**✅ 已完成**");
});

test("长过程先分段再更新原卡，所有请求遵守预算且最终答复只出现一次", async () => {
  const { countTaggedElements } = require("../lib/feishu-card.cjs");
  const { FEISHU_CARD_ELEMENT_BUDGET } = require("../lib/constants.cjs");
  const h = harness();
  const blocks = Array.from({ length: 500 }, (_, index) => ({ type: "message", text: `过程${index}` }));
  const turn = h.create().beginTurn({ chatId: "oc_test", resume: { cardMessageId: "existing", blocks } });
  await turn.end("completed", { finalText: "最终答复", footerText: "文件变更" });
  const writes = h.calls.filter(call => ["create", "update"].includes(call.type));
  assert.equal(writes[0].type, "update");
  assert.equal(writes[0].args[0], "existing");
  for (const write of writes) assert.ok(countTaggedElements(JSON.parse(write.args[2])) <= FEISHU_CARD_ELEMENT_BUDGET);
  const all = writes.map(write => write.args[2]).join("\n");
  assert.equal((all.match(/最终答复/g) || []).length, 1);
  for (let index = 0; index < 500; index++) assert.equal((all.match(new RegExp(`过程${index}\\"`, "g")) || []).length, 1);
  assert.match(writes.at(-1).args[2], /最终答复.*文件变更.*已完成/);
});
