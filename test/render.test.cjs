"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chunkText,
  formatSessionList,
  formatSessionStatus,
  formatHelp,
  HARD_MAX_CHARS,
} = require("../lib/render.cjs");

test("chunkText keeps short text intact", () => {
  assert.deepEqual(chunkText("hello", 800), ["hello"]);
  assert.deepEqual(chunkText("", 800), []);
});

test("chunkText splits on paragraph boundaries without losing content", () => {
  const a = "x".repeat(300);
  const b = "y".repeat(300);
  const text = `${a}\n\n${b}`;
  const chunks = chunkText(text, 400);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join("\n\n"), text);
});

test("chunkText hard-splits a single oversized paragraph", () => {
  const text = "z".repeat(1000);
  const chunks = chunkText(text, 300);
  assert.equal(chunks.length, 4);
  assert.equal(chunks.join(""), text);
});

test("chunkText clamps the limit to the platform hard maximum", () => {
  const text = "q".repeat(HARD_MAX_CHARS + 50);
  const chunks = chunkText(text, 999999);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= HARD_MAX_CHARS));
});

test("formatSessionList renders index, id and project", () => {
  const text = formatSessionList([
    { id: "s1", title: "修复登录", projectPath: "D:\\work\\app" },
    { id: "s2", title: "" },
  ]);
  assert.match(text, /1\. 修复登录/);
  assert.match(text, /s1/);
  assert.match(text, /D:\\work\\app/);
  assert.match(text, /2\. \(未命名\)/);
  assert.equal(formatSessionList([]), "当前没有会话。用 /new 创建一个。");
});

test("formatSessionStatus surfaces state and model", () => {
  const text = formatSessionStatus({ state: "running", modelId: "gpt-x", permissionMode: "ask" });
  assert.match(text, /状态：执行中/);
  assert.match(text, /模型：gpt-x/);
  assert.match(text, /权限模式：ask/);
});

test("状态快照对象不会被当成文本，读取运行标志与嵌套模型", () => {
  const text = formatSessionStatus({ state: { isRunning: true, model: { id: "gpt-x" }, permissionMode: "ask" } });
  assert.match(text, /状态：执行中/);
  assert.match(text, /模型：gpt-x/);
  assert.match(text, /权限模式：ask/);
  assert.ok(!text.includes("[object Object]"));
});

test("宿主 status 包装兼容空闲、等待确认和未知结构", () => {
  assert.match(formatSessionStatus({ status: { isRunning: false, pendingToolConfirmations: 0 } }), /状态：空闲/);
  assert.match(formatSessionStatus({ status: { isRunning: true, pendingToolConfirmations: 1 } }), /状态：等待确认/);
  assert.match(formatSessionStatus({ state: { isStreaming: false, isCompacting: true } }), /状态：压缩上下文中/);
  assert.match(formatSessionStatus({ state: {} }), /状态：未知/);
});

test("状态消息参考 ZCode 的字段顺序，显示名称、标题和独立时长", () => {
  const text = formatSessionStatus({ status: { isRunning: true } }, {
    session: { id: "s1", title: "修复登录", projectPath: "D:/work/app", providerId: "p1", modelId: "m1" },
    providers: [{ id: "p1", name: "供应商", models: [{ id: "m1", alias: "模型名称" }] }],
    elapsedMs: 3661000, progress: "正在运行测试\n检查结果",
  });
  assert.equal(text, "工作区：D:/work/app\n模型：供应商 / 模型名称\n------\n会话：修复登录 (s1)\n状态：执行中\n本轮已用：1h 1m 1s\n进展：正在运行测试 检查结果");
});

test("模型以运行时为准，不把同名模型误归属到其他供应商", () => {
  const context = {
    session: { id: "s1", providerId: "old", modelId: "old-model" },
    providers: [{ id: "a", name: "甲", models: [{ id: "m1", alias: "甲模型" }] }, { id: "b", name: "乙", models: [{ id: "m1", alias: "乙模型" }] }],
  };
  assert.match(formatSessionStatus({ state: { isRunning: true, model: { id: "m1", providerId: "b" } } }, context), /模型：乙 \/ 乙模型/);
  const ambiguous = formatSessionStatus({ state: { isRunning: true, model: { id: "m1" } } }, context);
  assert.match(ambiguous, /模型：m1\n/);
  assert.ok(!ambiguous.includes("old") && !ambiguous.includes("甲") && !ambiguous.includes("乙"));
});

test("结束与未知状态隐藏时长和旧进展，缺失配置明确显示", () => {
  for (const state of ["idle", "completed", "failed", "unknown"]) {
    const text = formatSessionStatus({ state }, { elapsedMs: 1000, progress: "旧进展" });
    assert.ok(!text.includes("本轮已用") && !text.includes("进展"));
    assert.match(text, /工作区：未设置\n模型：未知/);
  }
  const waiting = formatSessionStatus({ status: { isRunning: true, pendingToolConfirmations: 1 } }, { busy: true, elapsedMs: 0 });
  assert.match(waiting, /状态：等待确认\n本轮已用：0s/);
});

test("常用帮助保留配置入口，仅显式关闭时提示面板开关", () => {
  const help = formatHelp({ allowDangerousRemote: false });
  assert.match(help, /^常用命令\n/);
  for (const command of ["/新建", "/会话", "/状态", "/停止", "/项目", "/模型", "/思考", "/帮助 更多"]) {
    assert.ok(help.includes(command), `missing ${command}`);
  }
  for (const alias of ["/new", "/clear", "/task", "/切换", "/use", "/model", "/think"]) assert.ok(!help.includes(alias));
  for (const extra of ["/权限", "/回复", "/发送", "/解绑"]) assert.ok(!help.includes(extra));
  assert.match(help, /机器人设置.*允许远程配置切换/);
  assert.match(help, /已有会话不会移动/);
  assert.ok(!formatHelp({ allowDangerousRemote: true }).includes("配置切换已关闭"));
  assert.ok(!formatHelp().includes("配置切换已关闭"));
});

test("更多帮助按渠道展示可用功能，不重复常用配置入口", () => {
  const feishu = formatHelp({ channel: "feishu" }, true);
  assert.match(feishu, /^其他命令\n/);
  for (const command of ["/模式", "/权限", "/改动", "/发送", "/解绑", "/bind", "/帮助"]) assert.ok(feishu.includes(command));
  assert.ok(!feishu.includes("/回复") && !feishu.includes("/模型"));
  assert.match(feishu, /解除会话关联，保留聊天授权/);
  const telegram = formatHelp({ channel: "telegram" }, true);
  assert.ok(telegram.includes("/回复") && telegram.includes("/发送"));
  const weixin = formatHelp({ channel: "weixin" }, true);
  assert.ok(weixin.includes("/回复") && !weixin.includes("/发送"));
});
