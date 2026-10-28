"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { IPC_EVENTS } = require("../lib/constants.cjs");
const { replyModeFor } = require("../lib/reply-mode.cjs");
const { randomUUID } = require("node:crypto");
const { formatToolSummary } = require("../lib/tool-summary.cjs");
const { captureFile, countLineChanges } = require("../lib/file-changes.cjs");

function harness(reply = () => undefined) {
  const source = fs.readFileSync(path.join(__dirname, "../extensions/agent.js"), "utf8");
  const events = [];
  const handlers = new Map();
  const tools = new Map();
  const context = { sessionManager: { getSessionId: () => "session-1" } };
  const sandbox = { randomUUID, IPC_EVENTS, formatToolSummary, captureFile, countLineChanges, path, process, setTimeout, clearTimeout, ipc: { send: (value) => {
    const { runId, ...payload } = JSON.parse(JSON.stringify(value));
    assert.ok(runId);
    events.push(payload);
    return reply(value);
  } }, REMOTE_TAG_PREFIX: "[Remote:", module: { exports: {} } };
  vm.runInNewContext(source.slice(source.indexOf("function extractText")).replace("export default function", "module.exports = function"), sandbox);
  sandbox.module.exports({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => {
    assert.equal(typeof tool.execute, "function"); tools.set(tool.name, tool);
  } });
  return { events, tools, emit: (type, event = {}) => handlers.get(type)(event, context) };
}

const message = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });

test("旧设置默认标准回复，各渠道独立，飞书固定流式", () => {
  for (const legacy of [undefined, "text", "streaming_card"]) {
    assert.equal(replyModeFor({ replyMode: legacy }, "telegram"), "standard");
  }
  const settings = { telegramReplyMode: "summary", weixinReplyMode: "full", replyMode: "text" };
  assert.equal(replyModeFor(settings, "telegram"), "summary");
  assert.equal(replyModeFor(settings, "weixin"), "full");
  assert.equal(replyModeFor(settings, "feishu"), "streaming_card");
});

test("真实宿主快照结构转为不重复的增量，最终结果取最后助手消息", () => {
  const h = harness();
  h.emit("agent_start");
  h.emit("message_start", { message: message("") });
  h.emit("message_update", { message: message("第一"), assistantMessageEvent: { type: "text_delta", delta: "第一" } });
  h.emit("message_update", { message: message("第一段"), assistantMessageEvent: { type: "text_delta", delta: "段" } });
  h.emit("message_end", { message: message("第一段", "toolUse") });
  h.emit("message_end", { message: message("最终结果") });
  h.emit("agent_end", { messages: [message("第一段", "toolUse"), { role: "toolResult" }, message("最终结果")] });
  const chunks = h.events.filter(event => event.type === "assistant_chunk");
  assert.equal(chunks.map(event => event.content).join(""), "第一段\n\n最终结果");
  assert.equal(h.events.at(-1).finalText, "最终结果");
  assert.equal(h.events.at(-1).sessionId, "session-1");
});

test("成功编辑报告文件变更，失败编辑不报告，工具进度不携带原始结果", () => {
  const h = harness();
  h.emit("agent_start");
  h.emit("tool_execution_start", { toolCallId: "t1", toolName: "Edit", args: { path: "app.js" } });
  h.emit("tool_execution_update", { toolCallId: "t1", toolName: "Edit", partialResult: { content: [{ text: "secret tool output" }] } });
  h.emit("tool_execution_end", { toolCallId: "t1", toolName: "Edit", isError: false });
  h.emit("tool_execution_start", { toolCallId: "t2", toolName: "write", args: { path: "failed.js" } });
  h.emit("tool_execution_end", { toolCallId: "t2", toolName: "write", isError: true });
  const changes = h.events.filter(event => event.type === "file_change");
  assert.deepEqual(changes, [{ type: "file_change", sessionId: "session-1", path: "app.js", operation: "修改", addedLines: 0, removedLines: 0 }]);
  assert.equal(h.events.filter(event => event.type === "tool_progress").length, 5);
  assert.ok(!JSON.stringify(h.events).includes("secret tool output"));
});
test("工具进度在更新和结束事件缺少参数时沿用开始事件的命令摘要", () => {
  const h = harness();
  h.emit("agent_start");
  h.emit("tool_execution_start", { toolCallId: "cmd1", toolName: "powershell", args: { command: "Get-Location" } });
  h.emit("tool_execution_update", { toolCallId: "cmd1", toolName: "powershell", partialResult: { content: [{ text: "private output" }] } });
  h.emit("tool_execution_end", { toolCallId: "cmd1", toolName: "powershell", isError: false });
  const progress = h.events.filter(event => event.type === "tool_progress");
  assert.deepEqual(progress.map(event => event.summary), [
    "执行中 · powershell · `Get-Location`",
    "执行中 · powershell · `Get-Location`",
    "完成 · powershell · `Get-Location`",
  ]);
  assert.ok(!JSON.stringify(progress).includes("private output"));
});

test("中断和错误保留真实终态，不把工具调用前正文当最终结果", () => {
  const h = harness();
  h.emit("agent_start");
  h.emit("agent_end", { messages: [message("准备调用工具", "toolUse")] });
  assert.equal(h.events.at(-1).finalText, "");
  h.emit("agent_end", { messages: [message("", "aborted")] });
  assert.equal(h.events.at(-1).error, "任务已中断");
});

test("远程轮次通过宿主支持的 before_agent_start 识别，两种启动顺序都保留来源", () => {
  for (const beforeFirst of [true, false]) {
    const h = harness();
    if (beforeFirst) h.emit("before_agent_start", { prompt: "[Remote:telegram] 你好" });
    h.emit("agent_start");
    if (!beforeFirst) h.emit("before_agent_start", { prompt: "[Remote:telegram] 你好" });
    assert.equal(h.emit("tool_call", { toolName: "asktool" }).block, true);
    assert.equal(h.events.at(-1).sessionId, "session-1");
    h.emit("agent_end");
    h.emit("before_agent_start", { prompt: "桌面任务" });
    h.emit("agent_start");
    assert.equal(h.emit("tool_call", { toolName: "asktool" }), undefined);
    assert.ok(h.events.every(event => event.sessionId === "session-1"));
  }
});

test("扩展 IPC 串行投递，结束事件等待前序事件处理完成", { timeout: 5000 }, async () => {
  const http = require("node:http");
  const received = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        received.push(JSON.parse(body).type);
        inFlight -= 1;
        res.end("ok");
      }, 10);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = fs.readFileSync(path.join(__dirname, "../extensions/agent.js"), "utf8");
    const code = source.slice(source.indexOf("function createIpcClient()"), source.indexOf("const ipc = createIpcClient();"));
    const sandbox = { http, Buffer, PRIMARY_IPC_FILE: "ipc", FALLBACK_IPC_FILE: "fallback", module: { exports: {} },
      fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ port: server.address().port }) } };
    vm.runInNewContext(code + "\nmodule.exports = createIpcClient;", sandbox);
    const client = sandbox.module.exports();
    await Promise.all([client.send({ type: "assistant_chunk" }), client.send({ type: "file_change" }), client.send({ type: "agent_end" })]);
    assert.deepEqual(received, ["assistant_chunk", "file_change", "agent_end"]);
    assert.equal(maxInFlight, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("文件工具使用真实 execute 签名并等待投递结果，桌面来源不得发送", async () => {
  let success = true;
  const h = harness(event => event.type === "send_file" ? { success, name: "report.txt", error: "upload failed" } : undefined);
  const tool = h.tools.get("send_file_to_phone");
  await assert.rejects(tool.execute("file-1", { path: "report.txt" }), /仅手机/);
  h.emit("before_agent_start", { prompt: "[Remote:telegram] 发文件" }); h.emit("agent_start");
  const result = await tool.execute("file-1", { path: "report.txt" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(result.details.success, true);
  assert.match(result.content[0].text, /文件已发送/);
  success = false;
  await assert.rejects(tool.execute("file-2", { path: "report.txt" }), /upload failed/);
});

test("手机问答等待答案并清理请求，失效与中断返回错误", async () => {
  let state = "answered";
  const h = harness(event => {
    if (event.type === "phone_question") return { requestId: "q1" };
    if (event.type === "phone_question_poll") return { state, answers: [["A", "B"], ["自定义"]] };
  });
  h.emit("before_agent_start", { prompt: "[Remote:feishu] 提问" }); h.emit("agent_start");
  const tool = h.tools.get("ask_phone");
  const result = await tool.execute("q", { questions: [{ question: "选择", options: ["A", "B"], multiSelect: true }] });
  assert.equal(JSON.stringify(result.details.answers), '[["A","B"],["自定义"]]');
  assert.equal(h.events.at(-1).type, "phone_question_cancel");
  state = "expired";
  await assert.rejects(tool.execute("q", { questions: [] }), /取消或失效/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute("q", { questions: [] }, controller.signal), /中断/);
});

test("文件增删行数以本轮首次编辑为基线，重复编辑后还原归零", t => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "remote-file-lines-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sample.txt"); fs.writeFileSync(file, "A\nB\nC\n", "utf8");
  const h = harness(); h.emit("agent_start");
  h.emit("tool_execution_start", { toolCallId: "e1", toolName: "Edit", args: { path: file } });
  fs.writeFileSync(file, "A\nchanged\nC\nD\n", "utf8");
  h.emit("tool_execution_end", { toolCallId: "e1", toolName: "Edit" });
  let change = h.events.filter(e => e.type === "file_change").at(-1);
  assert.equal(change.addedLines, 2); assert.equal(change.removedLines, 1);
  h.emit("tool_execution_start", { toolCallId: "e2", toolName: "Edit", args: { path: file } });
  fs.writeFileSync(file, "A\nB\nC\n", "utf8");
  h.emit("tool_execution_end", { toolCallId: "e2", toolName: "Edit" });
  change = h.events.filter(e => e.type === "file_change").at(-1);
  assert.equal(change.addedLines, 0); assert.equal(change.removedLines, 0);
  assert.deepEqual(countLineChanges({ text: "" }, { text: "one\r\ntwo\r\n" }), { addedLines: 2, removedLines: 0 });
  assert.equal(countLineChanges({ text: "a\n".repeat(1001) }, { text: "b\n".repeat(1001) }), null);
});
