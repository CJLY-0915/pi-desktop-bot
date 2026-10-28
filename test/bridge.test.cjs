"use strict";

/**
 * 桥接核心冒烟测试：mock 宿主 desktop.control 与假通道，
 * 验证“远程消息 → 宿主调用 → 结果回传”的完整链路。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../lib/store.cjs");
const { createBridge } = require("../lib/bridge.cjs");
const { generatePairingCode } = require("../lib/security.cjs");

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-bridge-"));
  const store = createStore(dir);
  const calls = [];
  const sent = [];
  const settings = {
    channel: options.kind ?? "feishu",
    requirePairing: options.requirePairing ?? true,
    autoCreateSession: options.autoCreateSession ?? true,
    resultChunkChars: options.resultChunkChars ?? 800,
    maxQueuePerChat: options.maxQueuePerChat ?? 3,
    allowDangerousRemote: options.allowDangerousRemote ?? false,
  };
  if (options.autoPair !== false) {
    store.pair(options.kind ?? "feishu", "oc_1", { userId: "ou_1" });
  }

  globalThis.pi = {
    desktop: {
      invoke: async (payload) => {
        calls.push(payload);
        const handler = options.handlers?.[payload.operation];
        if (handler) return handler(payload);
        switch (payload.operation) {
          case "session/getScratchPath":
            return { path: path.join(dir, "session-scratch") };
          case "project/list":
            return { projects: [{ path: "D:/work/other", name: "Other" }] };
          case "project/get":
            return { workspace: { path: "D:/work/other" } };
          case "project/set":
            return { workspace: { path: payload.args[0] } };
          case "session/get":
            return { session: { id: payload.args[0], mode: "plan", providerId: "p1", modelId: "m1", thinkingLevel: "high", supportedThinkingLevels: ["off", "low", "high"] } };
          case "session/configure":
            return { session: { id: payload.args[0], ...payload.args[1] } };
          case "providers/list":
            return { providers: [{ id: "p1", name: "Provider", enabled: true, models: [{ id: "m1", alias: "Model One", thinkingLevels: ["off", "low", "high"], defaultThinkingLevel: "low" }, { id: "m2", thinkingLevels: ["off", "low"], defaultThinkingLevel: "low" }] }, { id: "disabled", enabled: false, models: [{ id: "hidden" }] }] };
          case "session/create":
            return { session: { id: "sess-new", title: "t" } };
          case "session/list":
            return {
              sessions: [
                { id: "sess-1", title: "会话一" },
                { id: "sess-2", title: "会话二" },
              ],
            };
          case "plans/pending":
            return {
              plans: [
                {
                  id: "plan-1",
                  sessionId: payload.args[0].sessionId,
                  turnId: "turn-1",
                  toolCallId: "tc-1",
                  title: "部署计划",
                },
              ],
            };
          case "agent/getStatus":
            return { state: "idle", modelId: "m1" };
          case "workspace/diff":
            return "diff --git a/x b/x";
          default:
            return { ok: true };
        }
      },
    },
  };

  const turnCalls = [];
  const typingCalls = [];
  const fakeChannel = {
    kind: options.kind ?? "feishu",
    capabilities: { streamingCard: Boolean(options.card) },
    async sendText(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { delivered: true };
    },
    async sendChoice(chatId, request) {
      sent.push({ chatId, choice: request });
      return { delivered: true };
    },
    async uploadMedia(chatId, filePath) {
      sent.push({ chatId, upload: filePath });
      return { name: path.basename(filePath) };
    },
    async sendTyping(chatId) {
      typingCalls.push(chatId);
    },
  };

  if (options.card) {
    fakeChannel.beginTurn = ({ chatId, messageId, resume }) => {
      const handle = resume ? turnCalls.find(card => card.id === resume.cardMessageId) : { id: `card-${turnCalls.length + 1}`, chatId, messageId, texts: [], tools: [], sealed: false, ended: null };
      if (!resume) turnCalls.push(handle);
      return {
        appendText: (text) => handle.texts.push(text),
        appendTool: (summary) => handle.tools.push(summary),
        seal: async () => {
          handle.sealed = true;
        },
        end: async (status, details) => {
          handle.ended = status;
          handle.details = details;
        },
        snapshot: () => ({ cardMessageId: handle.id }),
        pause() {},
      };
    };
  }

  const makeBridge = (disk = store) => createBridge({
    store: disk,
    getSettings: () => settings,
    getChannel: () => fakeChannel,
    now: options.now ?? Date.now,
    setReplyMode: async (channel, mode) => { settings[`${channel}ReplyMode`] = mode; },
    log: () => {},
    audit: (entry) => store.audit(entry),
  });
  const bridge = makeBridge();

  return {
    dir,
    store,
    calls,
    sent,
    turnCalls,
    typingCalls,
    bridge,
    channel: fakeChannel,
    recreate: () => makeBridge(createStore(dir)),
    setSettings: (patch) => Object.assign(settings, patch),
    operations: () => calls.map((call) => call.operation),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

let inboundSeq = 0;
function inbound(text, extra = {}) {
  inboundSeq += 1;
  return { channel: "feishu", chatId: "oc_1", userId: "ou_1", text, messageId: `m${inboundSeq}`, images: [], ...extra };
}

test("未绑定聊天只接受 /bind，/pair 不绑定且不消耗绑定码", async () => {
  const h = harness({ autoPair: false });
  await h.bridge.handleInbound(inbound("帮我改个 bug"));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /尚未绑定/);
  assert.match(h.sent[0].text, /\/bind/);
  assert.equal(h.calls.length, 0, "未配对不得调用宿主");

  const { code } = generatePairingCode();
  h.store.setPairingCode(code);
  await h.bridge.handleInbound(inbound(`/pair ${code}`));
  assert.equal(h.store.isPaired("feishu", "oc_1"), false);
  assert.ok(h.store.getPairingCode());
  assert.equal(h.calls.length, 0);
  await h.bridge.handleInbound(inbound(`/bind ${code}`));
  assert.match(h.sent.at(-1).text, /绑定成功/);
  assert.equal(h.sent.at(-1).options.format, "command-guide");
  const guide = h.sent.at(-1).text;
  assert.match(guide, /^绑定成功。发送 \/帮助 查看可用命令。\n\n常用命令\n/);
  assert.match(guide, /\/帮助 更多/);
  await h.bridge.handleInbound(inbound("/帮助"));
  assert.equal(h.sent.at(-1).text, guide.split("\n\n").slice(1).join("\n\n"));
  assert.equal(h.sent.at(-1).options.format, "command-guide");
  assert.equal(h.store.isPaired("feishu", "oc_1"), true);
  const { code: nextCode } = generatePairingCode();
  h.store.setPairingCode(nextCode);
  await h.bridge.handleInbound(inbound(`/pair ${nextCode}`));
  assert.ok(h.store.getPairingCode(), "已绑定聊天也不能通过 /pair 消耗绑定码");
  assert.doesNotMatch(h.sent.at(-1).text, /绑定成功/);
  h.cleanup();
});

test("完整链路：配对 → 自动建会话 → 派发 → 结果分段回传", async () => {
  const h = harness({ resultChunkChars: 40 });
  await h.bridge.handleInbound(inbound("帮我把登录页改成暗色模式"));

  assert.ok(h.operations().includes("session/create"), "首个指令应自动建会话");
  assert.ok(h.operations().includes("agent/prompt"), "指令应注入宿主会话");

  const promptCall = h.calls.find((call) => call.operation === "agent/prompt");
  assert.equal(promptCall.args[0].sessionId, "sess-new");
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new" });
  const bigChunk = "第一部分".repeat(40); // 120 字，超过 80 字符的分段下限
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: bigChunk });
  assert.ok(h.sent.length >= 2, "超过分段阈值应立即推送");
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: "收尾" });
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new" });
  assert.match(h.sent.at(-1).text, /收尾/);
  assert.match(h.sent.map((item) => item.text).join(""), /第一部分/);
  h.cleanup();
});

test("会话执行中第二个指令排队，回合结束后自动推进", async () => {
  const h = harness();
  await h.bridge.handleInbound(inbound("第一个任务"));
  assert.equal(h.calls.filter((call) => call.operation === "agent/prompt").length, 1);

  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new" });
  await h.bridge.handleInbound(inbound("第二个任务"));
  assert.equal(h.calls.filter((call) => call.operation === "agent/prompt").length, 1, "执行中不得重复派发");
  assert.match(h.sent.at(-1).text, /排队/);

  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new" });
  assert.equal(h.calls.filter((call) => call.operation === "agent/prompt").length, 2, "结束后应推进队列");
  h.cleanup();
});

test("/cancel 调用 agent/abort", async () => {
  const h = harness();
  await h.bridge.handleInbound(inbound("跑个长任务"));
  await h.bridge.handleInbound(inbound("/cancel"));
  assert.ok(h.operations().includes("agent/abort"));
  const abort = h.calls.find((call) => call.operation === "agent/abort");
  assert.equal(abort.args[0].sessionId, "sess-new");
  h.cleanup();
});

test("/use 绑定已有会话，/unbind 解除", async () => {
  const h = harness();
  await h.bridge.handleInbound(inbound("/use 2"));
  assert.equal(h.store.getBinding("feishu", "oc_1").sessionId, "sess-2");
  await h.bridge.handleInbound(inbound("/unbind"));
  assert.equal(h.store.getBinding("feishu", "oc_1"), null);
  h.cleanup();
});

test("Plan 检查点轮询推送审批，回复 1 走 approve", async () => {
  const h = harness();
  await h.bridge.handleInbound(inbound("按计划部署"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new" });

  await h.bridge.pollApprovals();

  const choice = h.sent.find((item) => item.choice);
  assert.ok(choice, "应推送审批请求");
  assert.equal(choice.choice.choiceId, "plan-1");
  assert.deepEqual(choice.choice.options, ["批准执行", "拒绝"]);
  assert.ok(h.operations().includes("plans/pending"));

  await h.bridge.handleInbound(inbound("1"));
  const resolve = h.calls.find((call) => call.operation === "plans/resolve");
  assert.ok(resolve, "回复序号应触发 plans/resolve");
  assert.equal(resolve.args[0].action, "approve");
  assert.equal(resolve.args[0].proposalId, "plan-1");
  assert.equal(resolve.args[0].turnId, "turn-1");
  assert.equal(resolve.args[0].toolCallId, "tc-1");
  assert.equal(resolve.args[0].targetPermissionMode, "ask");
  assert.equal(resolve.confirm, true, "审批是危险操作，必须 confirm");
  assert.match(h.sent.at(-1).text, /已批准/);
  h.cleanup();
});

test("Plan 审批回复 2 走 reject", async () => {
  const h = harness();
  await h.bridge.handleInbound(inbound("按计划部署"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new" });
  await h.bridge.pollApprovals();

  await h.bridge.handleInbound(inbound("2"));
  const resolve = h.calls.find((call) => call.operation === "plans/resolve");
  assert.equal(resolve.args[0].action, "reject");
  assert.match(h.sent.at(-1).text, /已拒绝/);
  h.cleanup();
});

test("危险指令默认拒绝，开启后才放行", async () => {
  const h = harness();
  await h.bridge.handleInbound(inbound("/project D:/work/other"));
  assert.match(h.sent.at(-1).text, /未开放/);
  assert.equal(h.operations().includes("project/set"), false);

  h.setSettings({ allowDangerousRemote: true });
  await h.bridge.handleInbound(inbound("/project D:/work/other"));
  assert.ok(h.operations().includes("project/set"));
  const call = h.calls.find((item) => item.operation === "project/set");
  assert.equal(call.confirm, true, "危险操作必须带 confirm");
  h.cleanup();
});

test("/diff 返回工作区改动并分段", async () => {
  const h = harness();
  await h.bridge.handleInbound(inbound("/diff"));
  assert.ok(h.operations().includes("workspace/diff"));
  assert.match(h.sent.at(-1).text, /diff --git/);
  h.cleanup();
});

test("重复 messageId 的入站消息被去重，不会二次派发", async () => {
  const h = harness();
  const dup = { messageId: "dup-1" };
  await h.bridge.handleInbound(inbound("同一个任务", dup));
  await h.bridge.handleInbound(inbound("同一个任务", dup));
  assert.equal(
    h.calls.filter((call) => call.operation === "agent/prompt").length,
    1,
    "相同 messageId 只应派发一次",
  );
  h.cleanup();
});
test("卡片模式：派发后开回合，增量并入卡片，结束时封存终态", async () => {
  const h = harness({ card: true });
  await h.bridge.handleInbound(inbound("总结一下当前改动"));
  assert.equal(h.turnCalls.length, 1, "派发成功应开启一个回传回合");
  const turn = h.turnCalls[0];
  assert.equal(turn.chatId, "oc_1");
  assert.ok(turn.messageId && typeof turn.messageId === "string", "回合应携带入站 messageId（Typing 反应用）");

  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: "第一段" });
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: "第二段" });
  assert.deepEqual(turn.texts, ["第一段", "第二段"], "增量应原样进入卡片回合");
  assert.equal(h.sent.length, 0, "卡片模式不得再发文本消息");

  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new" });
  assert.equal(turn.ended, "completed", "回合结束必须封存终态");
  h.cleanup();
});

test("飞书固定流式卡片，不受历史 text 设置影响", async () => {
  const h = harness({ card: true });
  h.setSettings({ replyMode: "text", resultChunkChars: 100 });
  await h.bridge.handleInbound(inbound("跑个任务"));
  assert.equal(h.turnCalls.length, 1);
  await h.bridge.handleAgentEvent({ type: "tool_progress", sessionId: "sess-new", toolCallId: "tool-1", phase: "start", summary: "执行中：Read" });
  assert.deepEqual(h.turnCalls[0].tools, ["执行中：Read"]);
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: "结果" });
  assert.deepEqual(h.turnCalls[0].texts, ["结果"]);
  assert.equal(h.sent.length, 0);
  h.cleanup();
});

test("审批前封存当前卡，回复后仍可继续写新卡", async () => {
  const h = harness({ card: true });
  await h.bridge.handleInbound(inbound("按计划部署"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new" });
  await h.bridge.pollApprovals();

  const choice = h.sent.find((item) => item.choice);
  assert.ok(choice, "应推送审批请求");
  assert.equal(h.turnCalls[0].sealed, true, "阻塞式交互前必须封存当前卡");

  await h.bridge.handleInbound(inbound("1"));
  assert.ok(h.operations().includes("plans/resolve"));
  // 封存不是终止：后续输出仍进入同一回合（通道内部另起新卡）
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: "继续执行" });
  assert.deepEqual(h.turnCalls[0].texts.at(-1), "继续执行");
  h.cleanup();
});

test("仅有附件、无文本时使用默认提示语派发", async () => {
  const h = harness();
  const image = path.join(h.dir, "a.png");
  fs.writeFileSync(image, Buffer.from([137, 80, 78, 71]));
  await h.bridge.handleInbound(inbound("", { images: [image] }));
  const promptCall = h.calls.find((call) => call.operation === "agent/prompt");
  assert.ok(promptCall, "附件消息也应派发");
  assert.match(promptCall.args[0].content, /请查看附件并根据内容协助我。/);
  assert.equal(promptCall.args[0].attachments[0].kind, "image");
  assert.equal(promptCall.args[0].attachments[0].size, 4);
  assert.ok(fs.existsSync(promptCall.args[0].attachments[0].path));
  assert.ok(promptCall.args[0].attachments[0].path.startsWith(path.join(h.dir, "session-scratch")));
  h.cleanup();
});

test("文本回落通道在派发成功后发送一次 typing 提示", async () => {
  const h = harness();
  await h.bridge.handleInbound(inbound("跑个任务"));
  assert.deepEqual(h.typingCalls, ["oc_1"], "非卡片通道派发后应发一次正在输入");
  h.cleanup();
});

test("卡片模式不开 typing 提示（回合内含 Typing 反应）", async () => {
  const h = harness({ card: true });
  await h.bridge.handleInbound(inbound("跑个任务"));
  assert.equal(h.typingCalls.length, 0, "卡片模式不得再发 typing");
  h.cleanup();
});

test("指定项目过滤会话、拒绝范围外执行，并在允许项目新建会话", async () => {
  const sessions = [{ id: "sess-1", title: "允许会话", projectPath: "E:\\A" }, { id: "sess-2", title: "禁止会话", projectPath: "E:\\B" }];
  const h = harness({ handlers: {
    "session/list": () => ({ sessions }),
    "project/list": () => ({ projects: [{ path: "E:\\A", name: "A" }] }),
    "session/create": () => { sessions.push({ id: "sess-new", projectPath: "E:\\A" }); return { session: { id: "sess-new" } }; },
    "project/get": () => ({ workspace: { path: "E:\\B" } }),
  } });
  try {
    h.store.setProjectAccess("feishu", { mode: "selected", paths: ["E:\\A"] });
    await h.bridge.handleInbound(inbound("/sessions"));
    assert.match(h.sent.at(-1).text, /允许会话/);
    assert.doesNotMatch(h.sent.at(-1).text, /禁止会话/);
    await h.bridge.handleInbound(inbound("/use sess-2"));
    assert.equal(h.store.getBinding("feishu", "oc_1"), null);
    h.store.setBinding("feishu", "oc_1", "sess-2");
    await h.bridge.handleInbound(inbound("执行任务"));
    assert.equal(h.operations().includes("agent/prompt"), false);
    assert.match(h.sent.at(-1).text, /项目范围/);
    await h.bridge.handleInbound(inbound("/diff"));
    assert.equal(h.operations().includes("workspace/diff"), false);
    h.setSettings({ allowDangerousRemote: true });
    await h.bridge.handleInbound(inbound("/project E:\\B"));
    assert.equal(h.operations().includes("project/set"), false);
    h.store.clearBinding("feishu", "oc_1");
    await h.bridge.handleInbound(inbound("创建并执行"));
    assert.equal(h.calls.find(call => call.operation === "session/create").args[0].projectPath, "E:\\A");
    assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
  } finally { h.bridge.dispose(); h.cleanup(); }
});

test("收紧项目范围后不执行已排队任务，宿主读取失败不放行", async () => {
  let fail = false;
  const h = harness({ handlers: { "session/list": () => { if (fail) throw new Error("host offline"); return { sessions: [{ id: "sess-1", projectPath: "E:\\A" }] }; } } });
  try {
    h.store.setBinding("feishu", "oc_1", "sess-1");
    await h.bridge.handleInbound(inbound("任务一"));
    await h.bridge.handleInbound(inbound("任务二"));
    h.store.setProjectAccess("feishu", { mode: "selected", paths: ["E:\\B"] });
    const sentBeforeEnd = h.sent.length;
    await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-1" });
    assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
    assert.equal(h.sent.length, sentBeforeEnd, "范围变化后不继续投递旧轮次");
    const result = await h.bridge.handleAgentEvent({ type: "send_file", sessionId: "sess-1", filePath: "E:\\A\\report.txt" });
    assert.equal(h.sent.some(item => item.upload), false);
    assert.equal(result.success, false);
    fail = true;
    await h.bridge.handleInbound(inbound("任务三"));
    assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
    assert.match(h.sent.at(-1).text, /host offline/);
  } finally { h.bridge.dispose(); h.cleanup(); }
});

for (const mode of ["all", "selected"]) {
  for (const automatic of [false, true]) {
    test(`${mode} 项目范围：切换工作区后${automatic ? "首条消息自动创建" : "/新建"}归属当前项目`, async () => {
      let current = "E:\\A";
      let created;
      const h = harness({ allowDangerousRemote: true, handlers: {
        "project/list": () => ({ projects: [{ path: "E:\\A" }, { path: "E:\\B" }] }),
        "project/get": () => ({ workspace: { path: current } }),
        "project/set": ({ args }) => { current = args[0]; return { workspace: { path: current } }; },
        "session/create": ({ args }) => {
          created = { id: "sess-new", ...args[0] };
          return { session: created };
        },
        "session/list": () => ({ sessions: created ? [created] : [] }),
        "session/get": () => ({ session: created }),
      } });
      try {
        h.store.setProjectAccess("feishu", { mode, paths: mode === "selected" ? ["E:\\A", "E:\\B"] : [] });
        await h.bridge.handleInbound(inbound("/项目 E:\\B"));
        assert.equal(current, "E:\\B");
        await h.bridge.handleInbound(inbound(automatic ? "执行任务" : "/新建 项目会话"));
        assert.equal(created?.projectPath, "E:\\B");
        assert.equal(h.store.getBinding("feishu", "oc_1")?.sessionId, "sess-new");
        assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, automatic ? 1 : 0);
        if (!automatic) assert.match(h.sent.at(-1).text, /工作区：E:\\B/);
      } finally { h.bridge.dispose(); h.cleanup(); }
    });
  }
}

test("未打开工作区时新建仍保留临时会话行为", async () => {
  const h = harness({ handlers: { "project/get": () => ({ workspace: null }) } });
  try {
    await h.bridge.handleInbound(inbound("/新建"));
    const create = h.calls.find(call => call.operation === "session/create");
    assert.ok(create);
    assert.equal(create.args[0].projectPath, undefined);
    assert.equal(h.store.getBinding("feishu", "oc_1")?.sessionId, "sess-new");
  } finally { h.bridge.dispose(); h.cleanup(); }
});

test("读取当前工作区失败时不意外创建临时会话或替换原绑定", async () => {
  const h = harness({ handlers: { "project/get": () => { throw new Error("workspace unavailable"); } } });
  try {
    h.store.setBinding("feishu", "oc_1", "sess-1");
    await h.bridge.handleInbound(inbound("/新建"));
    assert.equal(h.operations().includes("session/create"), false);
    assert.equal(h.store.getBinding("feishu", "oc_1")?.sessionId, "sess-1");
    assert.match(h.sent.at(-1).text, /创建会话失败：workspace unavailable/);
  } finally { h.bridge.dispose(); h.cleanup(); }
});

test("中文状态、新建和 clear 别名调用现有命令", async () => {
  const h = harness();
  try {
    await h.bridge.handleInbound(inbound("/新建 中文标题"));
    assert.equal(h.calls.find(call => call.operation === "session/create").args[0].title, "中文标题");
    await h.bridge.handleInbound(inbound("/状态"));
    assert.ok(h.operations().includes("agent/getStatus"));
    assert.match(h.sent.at(-1).text, /工作区：.*\n模型：.*\n------\n任务：草稿\n状态：草稿/);
    await h.bridge.handleInbound(inbound("/clear"));
    assert.equal(h.calls.filter(call => call.operation === "session/create").length, 2);
    assert.equal(h.operations().includes("agent/prompt"), false);
  } finally { h.bridge.dispose(); h.cleanup(); }
});

for (const kind of ["weixin", "telegram"]) {
  for (const mode of ["standard", "full", "summary"]) {
    test(`${kind} ${mode}：正文、进度、最终结果与文件变更按颗粒度回传`, async () => {
      const h = harness({ kind, resultChunkChars: 80 });
      try {
        h.setSettings({ [`${kind}ReplyMode`]: mode });
        await h.bridge.handleInbound(inbound("执行任务", { channel: kind }));
        const emit = (type, data) => h.bridge.handleAgentEvent({ type, sessionId: "sess-new", ...data });
        await emit("assistant_chunk", { content: "中间正文".repeat(30) });
        await emit("assistant_message", { content: "中间正文", stopReason: "toolUse" });
        await emit("tool_progress", { toolCallId: "t1", phase: "start", summary: "执行中：Edit" });
        await emit("tool_progress", { toolCallId: "t1", phase: "end", summary: "完成：Edit" });
        await emit("file_change", { path: "src/app.js", operation: "修改" });
        await emit("file_change", { path: "src/app.js", operation: "修改" });
        await emit("file_change", { path: "failed.js", operation: "修改", isError: true });
        if (mode === "summary") {
          assert.equal(h.sent.length, 0);
          assert.equal(h.typingCalls.length, 0);
        }
        await emit("assistant_chunk", { content: "最终结果：完成" });
        await emit("assistant_message", { content: "最终结果：完成", stopReason: "stop" });
        await emit("agent_end", { finalText: "最终结果：完成" });
        const output = h.sent.map(item => item.text ?? "").join("\n");
        assert.ok(output.includes("最终结果：完成"));
        assert.ok(output.includes("src/app.js"));
        assert.ok(!output.includes("failed.js"));
        assert.equal(output.includes("执行中：Edit"), mode === "full");
        assert.equal(output.includes("中间正文"), mode !== "summary");
        assert.equal(output.includes("文件变更摘要"), mode === "summary");
        assert.equal(output.split("src/app.js").length - 1, 1);
      } finally { h.cleanup(); }
    });
  }
}

test("颗粒度变更下一轮生效，摘要模式仍显示失败原因", async () => {
  const h = harness({ kind: "telegram" });
  try {
    h.setSettings({ telegramReplyMode: "summary" });
    await h.bridge.handleInbound(inbound("任务", { channel: "telegram" }));
    h.setSettings({ telegramReplyMode: "full" });
    await h.bridge.handleAgentEvent({ type: "tool_progress", sessionId: "sess-new", phase: "start", summary: "不应显示" });
    assert.equal(h.sent.length, 0);
    await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", error: "连接超时", finalText: "" });
    assert.match(h.sent.at(-1).text, /连接超时/);
  } finally { h.cleanup(); }
});

const lastMenu = h => h.sent.filter(item => item.choice).at(-1).choice;
const pickMenu = (h, selection, extra = {}) => h.bridge.handleChoice({ channel: "feishu", chatId: "oc_1", choiceId: lastMenu(h).choiceId, selection: String(selection), ...extra });

test("中文模型菜单：供应商过滤、两级选择、保留运行模式并调整不支持的思考档位", async t => {
  const h = harness({ allowDangerousRemote: true }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/模型"));
  assert.deepEqual(lastMenu(h).options, ["Provider", "取消"]);
  await pickMenu(h, 1);
  assert.deepEqual(lastMenu(h).options, ["Model One · 当前", "m2", "取消"]);
  const id = lastMenu(h).choiceId;
  await pickMenu(h, 2);
  const call = h.calls.find(item => item.operation === "session/configure");
  assert.deepEqual(call.args, ["sess-1", { mode: "plan", providerId: "p1", modelId: "m2", thinkingLevel: "low" }]);
  assert.equal(call.confirm, true);
  await h.bridge.handleChoice({ channel: "feishu", chatId: "oc_1", choiceId: id, selection: "2" });
  assert.equal(h.calls.filter(item => item.operation === "session/configure").length, 1);
});

test("思考、运行模式和权限命令使用当前会话配置，兼容旧 /mode ask", async t => {
  const h = harness({ allowDangerousRemote: true }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  for (const [text, config] of [["/思考 low", { mode: "plan", thinkingLevel: "low" }], ["/模式 goal", { mode: "goal" }], ["/权限 auto", { mode: "plan", permissionMode: "auto" }], ["/mode ask", { mode: "plan", permissionMode: "ask" }]]) {
    await h.bridge.handleInbound(inbound(text));
    assert.deepEqual(h.calls.filter(item => item.operation === "session/configure").at(-1).args, ["sess-1", config]);
  }
  const count = h.calls.length;
  await h.bridge.handleInbound(inbound("/思考 max"));
  assert.match(h.sent.at(-1).text, /不支持/);
  assert.ok(!h.calls.slice(count).some(item => item.operation === "session/configure"));
});

test("配置切换检查危险开关及宿主执行状态", async t => {
  let busy = false;
  const h = harness({ handlers: { "agent/getStatus": () => ({ busy }) } }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/模式 goal"));
  assert.match(h.sent.at(-1).text, /未开放/);
  h.setSettings({ allowDangerousRemote: true }); busy = true;
  await h.bridge.handleInbound(inbound("/模式 goal"));
  assert.match(h.sent.at(-1).text, /仍在执行/);
  await h.bridge.handleInbound(inbound("/use sess-2"));
  assert.equal(h.store.getBinding("feishu", "oc_1").sessionId, "sess-1");
  assert.ok(!h.operations().includes("session/configure"));
});

test("会话菜单分页、数字选择不派发任务，旧页不可重放", async t => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `会话${i}` }));
  const h = harness({ handlers: { "session/list": () => ({ sessions }) } }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("/会话"));
  const firstId = lastMenu(h).choiceId;
  assert.equal(lastMenu(h).options[8], "下一页");
  await h.bridge.handleInbound(inbound("9"));
  assert.equal(lastMenu(h).options[0], "会话8");
  await h.bridge.handleInbound(inbound("1"));
  assert.equal(h.store.getBinding("feishu", "oc_1").sessionId, "s8");
  assert.ok(!h.operations().includes("agent/prompt"));
  await h.bridge.handleChoice({ channel: "feishu", chatId: "oc_1", choiceId: firstId, selection: "1" });
  assert.match(h.sent.at(-1).text, /过期/);
});

test("取消、新命令、超时、跨聊天与渠道均不能继续操作旧菜单", async t => {
  let time = Date.now();
  const h = harness({ now: () => time }); t.after(h.cleanup);
  for (const cancel of ["/取消", "0", "/帮助"]) {
    await h.bridge.handleInbound(inbound("/会话"));
    const id = lastMenu(h).choiceId;
    await h.bridge.handleInbound(inbound(cancel));
    await h.bridge.handleChoice({ channel: "feishu", chatId: "oc_1", choiceId: id, selection: "1" });
    assert.match(h.sent.at(-1).text, /过期/);
  }
  await h.bridge.handleInbound(inbound("/会话"));
  await pickMenu(h, 1, { chatId: "other" });
  await pickMenu(h, 1, { channel: "telegram" });
  assert.equal(h.store.getBinding("feishu", "oc_1"), null);
  time += 600001;
  await pickMenu(h, 1);
  assert.match(h.sent.at(-1).text, /过期/);
  assert.equal(h.store.getBinding("feishu", "oc_1"), null);
});

test("菜单选择前重新检查授权、会话关联与目标是否仍存在", async t => {
  let sessions = [{ id: "sess-1" }];
  const h = harness({ handlers: { "session/list": () => ({ sessions }) } }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("/会话"));
  sessions = [];
  await pickMenu(h, 1);
  assert.match(h.sent.at(-1).text, /已删除|范围/);
  sessions = [{ id: "sess-1" }];
  await h.bridge.handleInbound(inbound("/会话"));
  h.store.setBinding("feishu", "oc_1", "sess-2");
  await pickMenu(h, 1);
  assert.match(h.sent.at(-1).text, /关联会话已变化/);
  await h.bridge.handleInbound(inbound("/会话"));
  h.store.unpair("feishu", "oc_1");
  await pickMenu(h, 1);
  assert.match(h.sent.at(-1).text, /授权已失效/);
});

test("项目菜单提交时复查项目范围，成功切换不移动已有会话", async t => {
  const h = harness({ allowDangerousRemote: true }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/项目"));
  await pickMenu(h, 1);
  assert.equal(h.calls.find(item => item.operation === "project/set").confirm, true);
  assert.equal(h.store.getBinding("feishu", "oc_1").sessionId, "sess-1");
  await h.bridge.handleInbound(inbound("/项目"));
  h.store.setProjectAccess("feishu", { mode: "selected", paths: [] });
  const count = h.calls.length;
  await pickMenu(h, 1);
  assert.ok(!h.calls.slice(count).some(item => item.operation === "project/set"));
});

test("回复命令按渠道保存，飞书固定卡片且不写文本颗粒度", async t => {
  const h = harness({ kind: "telegram" }); t.after(h.cleanup);
  const msg = text => inbound(text, { channel: "telegram" });
  await h.bridge.handleInbound(msg("/回复"));
  await pickMenu(h, 3, { channel: "telegram" });
  await h.bridge.handleInbound(msg("/reply"));
  assert.match(lastMenu(h).title, /摘要回复/);
  h.store.pair("weixin", "oc_1", {});
  await h.bridge.handleInbound(inbound("/回复 完整", { channel: "weixin" }));
  await h.bridge.handleInbound(msg("/回复"));
  assert.match(lastMenu(h).title, /摘要回复/);
  h.store.pair("feishu", "oc_1", {});
  await h.bridge.handleInbound(inbound("/回复"));
  assert.match(h.sent.at(-1).text, /固定使用 Card JSON 2.0/);
});

test("新命令使尚未返回的旧菜单请求失效", async t => {
  let release;
  const h = harness({ handlers: { "session/list": () => new Promise(resolve => { release = resolve; }) } }); t.after(h.cleanup);
  const pending = h.bridge.handleInbound(inbound("/会话"));
  for (let i = 0; i < 8 && !release; i++) await Promise.resolve();
  assert.equal(typeof release, "function");
  await h.bridge.handleInbound(inbound("/帮助"));
  release({ sessions: [{ id: "stale", title: "旧会话" }] });
  await pending;
  assert.equal(h.sent.filter(item => item.choice).length, 0);
});

test("思考命令支持继承桌面模型的能力档位", async t => {
  const h = harness({ allowDangerousRemote: true, handlers: { "session/get": payload => ({ session: { id: payload.args[0], mode: "agent", supportedThinkingLevels: ["off", "high"] } }) } }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/thought-level high"));
  assert.deepEqual(h.calls.find(item => item.operation === "session/configure").args[1], { mode: "agent", thinkingLevel: "high" });
});

test("异步读取期间关闭危险开关或更换会话，不提交旧配置", async t => {
  for (const change of [h => h.setSettings({ allowDangerousRemote: false }), h => h.store.setBinding("feishu", "oc_1", "sess-2")]) {
    let release;
    const h = harness({ allowDangerousRemote: true, handlers: { "agent/getStatus": () => new Promise(resolve => { release = resolve; }) } });
    t.after(h.cleanup);
    h.store.setBinding("feishu", "oc_1", "sess-1");
    const pending = h.bridge.handleInbound(inbound("/模式 goal"));
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    assert.equal(typeof release, "function");
    change(h);
    release({ busy: false });
    await pending;
    assert.ok(!h.operations().includes("session/configure"));
    assert.match(h.sent.at(-1).text, /未开放|关联会话已变化/);
  }
});

test("群聊不能消费绑定码，已绑定聊天的其他 actor 不能派发", async t => {
  const h = harness({ autoPair: false }); t.after(h.cleanup);
  h.store.setPairingCode("AB2345");
  await h.bridge.handleInbound(inbound("/bind AB2345", { meta: { chatType: "group" } }));
  assert.equal(h.store.getPairingCode().code, "AB2345");
  assert.equal(h.store.isPaired("feishu", "oc_1"), false);
  h.store.pair("feishu", "oc_1", { userId: "owner" });
  await h.bridge.handleInbound(inbound("执行任务", { userId: "other" }));
  assert.equal(h.calls.length, 0);
});

test("不同聊天的相同 messageId 不互相去重", async t => {
  const h = harness({ kind: "telegram" }); t.after(h.cleanup);
  h.store.pair("telegram", "other", { userId: "other" });
  await h.bridge.handleInbound(inbound("/帮助", { channel: "telegram", messageId: "10" }));
  await h.bridge.handleInbound(inbound("/帮助", { channel: "telegram", chatId: "other", userId: "other", messageId: "10" }));
  assert.deepEqual(h.sent.map(item => item.chatId), ["oc_1", "other"]);
});

test("非图片附件保留类型、文件名和本地路径，附件本身可以触发任务", async t => {
  const h = harness(); t.after(h.cleanup);
  const file = path.join(h.dir, "report.pdf");
  fs.writeFileSync(file, "%PDF-fixture", "utf8");
  await h.bridge.handleInbound(inbound("", { attachments: [{ kind: "file", filename: "report.pdf", mimeType: "application/pdf", path: file }] }));
  const prompt = h.calls.find(call => call.operation === "agent/prompt").args[0];
  assert.match(prompt.content, /请查看附件/);
  assert.equal(prompt.attachments[0].name, "report.pdf");
  assert.equal(prompt.attachments[0].kind, "file");
  assert.equal(prompt.attachments[0].mimeType, "application/pdf");
  assert.equal(fs.readFileSync(prompt.attachments[0].path, "utf8"), "%PDF-fixture");
});

test("审批点击重新检查授权、会话与选择值", async t => {
  for (const change of ["unpair", "binding", "selection"]) {
    const h = harness(); t.after(h.cleanup);
    await h.bridge.handleInbound(inbound("任务"));
    await h.bridge.pollApprovals();
    if (change === "unpair") h.store.unpair("feishu", "oc_1");
    if (change === "binding") h.store.setBinding("feishu", "oc_1", "different");
    await h.bridge.handleChoice({ channel: "feishu", chatId: "oc_1", choiceId: "plan-1", selection: change === "selection" ? "3" : "1" });
    assert.ok(!h.calls.some(call => call.operation === "plans/resolve"));
  }
});

test("状态命令解析嵌套快照，不输出对象默认字符串", async t => {
  const h = harness({ handlers: { "agent/getStatus": () => ({ state: { isRunning: false, model: { id: "test-model" } } }) } });
  t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/状态"));
  assert.match(h.sent.at(-1).text, /状态：空闲/);
  assert.match(h.sent.at(-1).text, /模型：test-model/);
  assert.ok(!h.sent.at(-1).text.includes("[object Object]"));
});

test("嵌套快照正在运行或等待确认时，不能切换会话配置", async t => {
  for (const result of [
    { state: { isRunning: true } },
    { status: { isRunning: true, pendingToolConfirmations: 1 } },
  ]) {
    const h = harness({ allowDangerousRemote: true, handlers: { "agent/getStatus": () => result } });
    t.after(h.cleanup);
    h.store.setBinding("feishu", "oc_1", "sess-1");
    await h.bridge.handleInbound(inbound("/模式 plan"));
    assert.ok(!h.calls.some(call => call.operation === "session/configure"));
    assert.match(h.sent.at(-1).text, /仍在执行/);
  }
});

test("状态命令查询绑定会话的配置和模型名称", async t => {
  const h = harness({ handlers: {
    "agent/getStatus": () => ({ status: { isRunning: false } }),
    "session/get": payload => ({ session: { id: payload.args[0], title: "目标会话", projectPath: "D:/bound/project", providerId: "p1", modelId: "m1" } }),
  } });
  t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/status"));
  assert.equal(h.sent.at(-1).text, "工作区：D:/bound/project\n模型：Provider / Model One\n------\n会话：目标会话 (sess-1)\n状态：空闲");
  assert.deepEqual(h.calls.find(call => call.operation === "session/get").args, ["sess-1"]);
  assert.ok(!h.operations().includes("project/get"));
});

test("摘要模式仍能查本轮时长和最新进展，结束后不残留", async t => {
  let clock = 1000;
  const h = harness({ kind: "telegram", now: () => clock, handlers: { "agent/getStatus": () => ({ status: { isRunning: clock < 63000 } }) } });
  t.after(h.cleanup);
  h.setSettings({ telegramReplyMode: "summary" });
  await h.bridge.handleInbound(inbound("执行任务", { channel: "telegram" }));
  await h.bridge.handleAgentEvent({ type: "tool_progress", sessionId: "sess-new", summary: "执行中：测试" });
  assert.equal(h.sent.length, 0);
  clock = 62000;
  await h.bridge.handleInbound(inbound("/状态", { channel: "telegram" }));
  assert.match(h.sent.at(-1).text, /状态：执行中\n本轮已用：1m 1s\n进展：执行中：测试/);
  assert.ok(!h.sent.at(-1).text.includes("桥接侧"));
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", finalText: "完成" });
  clock = 63000;
  await h.bridge.handleInbound(inbound("/状态", { channel: "telegram" }));
  assert.match(h.sent.at(-1).text, /状态：空闲/);
  assert.ok(!h.sent.at(-1).text.includes("进展") && !h.sent.at(-1).text.includes("本轮已用"));
});

test("供应商名称不可读时保留模型 ID，必要会话查询失败明确报错", async t => {
  const h = harness({ handlers: { "providers/list": () => { throw new Error("供应商不可用"); } } });
  t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/状态"));
  assert.match(h.sent.at(-1).text, /模型：m1\n/);
  assert.match(h.sent.at(-1).text, /状态：空闲/);
  const failed = harness({ handlers: { "session/get": () => { throw new Error("会话不可用"); } } });
  t.after(failed.cleanup);
  failed.store.setBinding("feishu", "oc_1", "sess-1");
  await failed.bridge.handleInbound(inbound("/状态"));
  assert.equal(failed.sent.at(-1).text, "读取状态失败：会话不可用");
});

test("短任务在 prompt 返回前完成，卡片仍收到正文和终态且不再 busy", async t => {
  let h;
  h = harness({ card: true, handlers: { "agent/prompt": async () => {
    await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new" });
    await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: "你好！" });
    await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", finalText: "你好！" });
    return { accepted: true };
  } } });
  t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("你好"));
  assert.equal(h.turnCalls.length, 1);
  assert.deepEqual(h.turnCalls[0].texts, ["你好！"]);
  assert.equal(h.turnCalls[0].ended, "completed");
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
  await h.bridge.handleInbound(inbound("再问一句"));
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 2);
});

test("只有最终快照也能回传结果，派发失败会结束预建卡片", async t => {
  for (const card of [true, false]) {
    const h = harness({ card }); t.after(h.cleanup);
    await h.bridge.handleInbound(inbound("你好"));
    await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", finalText: "你好，已完成。" });
    assert.equal(card ? h.turnCalls[0].texts.join("") : h.sent.at(-1).text, "你好，已完成。");
    assert.deepEqual(h.bridge.snapshot().busySessions, []);
  }
  const failed = harness({ card: true, handlers: { "agent/prompt": () => { throw new Error("宿主不可用"); } } });
  t.after(failed.cleanup);
  await failed.bridge.handleInbound(inbound("任务"));
  assert.equal(failed.turnCalls[0].ended, "error");
  assert.match(failed.sent.at(-1).text, /派发失败：宿主不可用/);
  assert.deepEqual(failed.bridge.snapshot().busySessions, []);
});

test("宿主明确空闲时本地遗留 busy 不篡改状态，桌面其他会话事件不污染 busy", async t => {
  const h = harness(); t.after(h.cleanup);
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "desktop-only" });
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
  await h.bridge.handleInbound(inbound("任务"));
  await h.bridge.handleInbound(inbound("/状态"));
  assert.match(h.sent.at(-1).text, /状态：空闲/);
  assert.ok(!h.sent.at(-1).text.includes("本轮已用"));
});

test("宿主结束事件独立补取本轮正文，忽略历史回复与子任务输出", async t => {
  let h;
  h = harness({ card: true, handlers: {
    "agent/prompt": () => ({ accepted: true, turnId: "host-turn-1" }),
    "session/get": () => ({ session: { messages: [
      { role: "assistant", content: "上轮回复", turnId: "old-turn" },
      { id: h.calls.find(call => call.operation === "agent/prompt").args[0].messageId, role: "user", content: "你好" },
      { role: "assistant", content: "子任务私有内容", parentToolCallId: "child", turnId: "host-turn-1" },
      { role: "assistant", content: "你好，已完成。", turnId: "host-turn-1" },
    ] } }),
  } });
  t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("你好"));
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "old-turn", reason: "completed" });
  assert.equal(h.turnCalls[0].ended, null);
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "host-turn-1", reason: "completed" });
  assert.equal(h.turnCalls[0].texts.join(""), "你好，已完成。");
  assert.equal(h.turnCalls[0].ended, "completed");
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
});

test("宿主完成早于派发返回也能关联，重复完成不清掉下一轮", async t => {
  let h;
  let count = 0;
  h = harness({ card: true, handlers: {
    "agent/prompt": async () => {
      const turnId = `host-${++count}`;
      if (count === 1) await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId, reason: "completed" });
      return { accepted: true, turnId };
    },
    "session/get": () => ({ session: { messages: [{ role: "assistant", content: "本轮回复", turnId: "host-1" }] } }),
  } });
  t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("第一条"));
  assert.equal(h.turnCalls[0].ended, "completed");
  await h.bridge.handleInbound(inbound("第二条"));
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "host-1", reason: "completed" });
  assert.equal(h.turnCalls[1].ended, null);
  assert.deepEqual(h.bridge.snapshot().busySessions, ["sess-new"]);
});

test("有宿主轮次时扩展结束只缓存正文，宿主终态收束且补齐缺失正文", async t => {
  const h = harness({ card: true, handlers: {
    "agent/prompt": () => ({ accepted: true, turnId: "host-turn" }),
    "session/get": () => ({ session: { messages: [{ role: "assistant", content: "你好，完整回复。", turnId: "host-turn" }] } }),
  } });
  t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("你好"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new", runId: "ext-1" });
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", runId: "ext-1", content: "你好" });
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", runId: "ext-1", finalText: "你好，完整回复。" });
  assert.equal(h.turnCalls[0].ended, null);
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "host-turn", reason: "completed" });
  assert.equal(h.turnCalls[0].texts.join(""), "你好，完整回复。");
  assert.equal(h.turnCalls[0].ended, "completed");
});

test("宿主已完成但快照读取失败时提示回复同步失败，清理 busy 且不发送历史正文", async t => {
  const h = harness({ card: true, handlers: {
    "agent/prompt": () => ({ accepted: true, turnId: "host-turn" }),
    "session/get": () => { throw new Error("读取失败"); },
  } });
  t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("你好"));
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "host-turn", reason: "completed" });
  assert.match(h.turnCalls[0].texts.join(""), /回复同步失败：无法读取本轮回复/);
  assert.doesNotMatch(h.turnCalls[0].texts.join(""), /执行未完成|未产生最终回复/);
  assert.equal(h.turnCalls[0].ended, "completed");
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
});

test("已结束扩展轮次的迟到事件不能结束或污染下一条远程任务", async t => {
  const h = harness({ card: true }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("第一条"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new", runId: "ext-old" });
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", runId: "ext-old", finalText: "第一轮" });
  await h.bridge.handleInbound(inbound("第二条"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new", runId: "ext-new" });
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", runId: "ext-old", content: "迟到正文" });
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", runId: "ext-old", finalText: "第一轮" });
  assert.deepEqual(h.turnCalls[1].texts, []);
  assert.equal(h.turnCalls[1].ended, null);
  assert.deepEqual(h.bridge.snapshot().busySessions, ["sess-new"]);
});

test("中断调用返回前的宿主完成事件不能启动已取消的排队任务", async t => {
  let h;
  h = harness({ card: true, handlers: {
    "agent/prompt": () => ({ accepted: true, turnId: "host-turn" }),
    "session/get": () => ({ session: { messages: [{ role: "assistant", content: "", turnId: "host-turn" }] } }),
    "agent/abort": async () => {
      await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "host-turn", reason: "aborted" });
      return { ok: true };
    },
  } });
  t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("第一条"));
  await h.bridge.handleInbound(inbound("排队任务"));
  await h.bridge.handleInbound(inbound("/cancel"));
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
  assert.equal(h.turnCalls[0].ended, "error");
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
  assert.deepEqual(h.bridge.snapshot().queued, {});
});

test("开发卸载后重新创建桥接可更新原卡片，任务不重新派发", async t => {
  const h = harness({ card: true, handlers: {
    "agent/prompt": () => ({ accepted: true, turnId: "reload-turn" }),
    "agent/getStatus": () => ({ status: { isRunning: true } }),
    "session/get": () => ({ session: { messages: [{ role: "assistant", content: "第一段，最终结果。", turnId: "reload-turn" }] } }),
  } });
  t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("执行任务"));
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: "第一段" });
  await h.bridge.detachChannel({ preserveTurns: true });
  h.bridge.dispose();
  const restored = h.recreate(); t.after(() => restored.dispose());
  await restored.attachChannel();
  assert.deepEqual(restored.snapshot().busySessions, ["sess-new"]);
  await restored.handleHostTurnEnded({ sessionId: "sess-new", turnId: "reload-turn", reason: "completed" });
  assert.equal(h.turnCalls.length, 1);
  assert.equal(h.turnCalls[0].texts.join(""), "第一段，最终结果。");
  assert.equal(h.turnCalls[0].ended, "completed");
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
  assert.deepEqual(createStore(h.dir).getPendingTurns(), []);
});

test("任务在重载期间结束，重新连接补回本轮结果并清理恢复记录", async t => {
  const h = harness({ handlers: {
    "agent/prompt": () => ({ accepted: true, turnId: "reload-turn" }),
    "session/get": () => ({ session: { messages: [{ role: "assistant", content: "重载期间完成的回复", turnId: "reload-turn" }] } }),
  } }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("执行任务"));
  await h.bridge.detachChannel({ preserveTurns: true });
  const restored = h.recreate(); t.after(() => restored.dispose());
  await restored.attachChannel();
  assert.equal(h.sent.at(-1).text, "重载期间完成的回复");
  assert.deepEqual(restored.snapshot().busySessions, []);
  assert.deepEqual(createStore(h.dir).getPendingTurns(), []);
});

test("解绑、换绑或关闭授权后不恢复旧任务，也不转发结果给新会话", async t => {
  for (const revoke of [disk => disk.unpair("feishu", "oc_1"), disk => disk.setBinding("feishu", "oc_1", "other-session")]) {
    const h = harness({ handlers: { "agent/prompt": () => ({ accepted: true, turnId: "reload-turn" }) } }); t.after(h.cleanup);
    await h.bridge.handleInbound(inbound("执行任务"));
    await h.bridge.detachChannel({ preserveTurns: true });
    revoke(createStore(h.dir));
    const restored = h.recreate(); t.after(() => restored.dispose());
    const before = h.sent.length;
    await restored.attachChannel();
    await restored.handleHostTurnEnded({ sessionId: "sess-new", turnId: "reload-turn", reason: "completed" });
    assert.equal(h.sent.length, before);
    assert.deepEqual(restored.snapshot().busySessions, []);
  }
});

test("重载等待尚未返回的派发确认，恢复使用原轮次且不重复执行", async t => {
  let confirm;
  const accepted = new Promise(resolve => { confirm = resolve; });
  const h = harness({ handlers: {
    "agent/prompt": () => accepted,
    "session/get": () => ({ session: { messages: [{ role: "assistant", content: "确认后完成", turnId: "late-accepted" }] } }),
  } }); t.after(h.cleanup);
  const input = h.bridge.handleInbound(inbound("执行任务"));
  while (!h.calls.some(call => call.operation === "agent/prompt")) await new Promise(resolve => setImmediate(resolve));
  const stopping = h.bridge.detachChannel({ preserveTurns: true });
  confirm({ accepted: true, turnId: "late-accepted" });
  await Promise.all([stopping, input]);
  assert.equal(createStore(h.dir).getPendingTurns()[0].hostTurnId, "late-accepted");
  const restored = h.recreate(); t.after(() => restored.dispose());
  await restored.attachChannel();
  assert.equal(h.sent.at(-1).text, "确认后完成");
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
});

test("恢复前收紧项目范围，不恢复旧卡片或接收旧任务输出", async t => {
  const h = harness({ card: true, handlers: { "agent/prompt": () => ({ accepted: true, turnId: "restricted-turn" }) } }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("执行任务"));
  await h.bridge.detachChannel({ preserveTurns: true });
  createStore(h.dir).setProjectAccess("feishu", { mode: "selected", paths: ["D:/work/allowed"] });
  const restored = h.recreate(); t.after(() => restored.dispose());
  await restored.attachChannel();
  await restored.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", content: "不允许转发" });
  assert.deepEqual(h.turnCalls[0].texts, []);
  assert.deepEqual(restored.snapshot().busySessions, []);
});

test("主动停止会清除待恢复记录，后续启动不补发已放弃的结果", async t => {
  const h = harness({ handlers: { "agent/prompt": () => ({ accepted: true, turnId: "stopped-turn" }) } }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("执行任务"));
  await h.bridge.detachChannel({ preserveTurns: true });
  await h.bridge.detachChannel();
  assert.deepEqual(createStore(h.dir).getPendingTurns(), []);
});

test("帮助分层兼容英文入口，不派发任务或修改配置", async t => {
  const h = harness(); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("/帮助"));
  assert.match(h.sent.at(-1).text, /^常用命令/);
  for (const command of ["/项目", "/模型", "/思考"]) assert.ok(h.sent.at(-1).text.includes(command));
  await h.bridge.handleInbound(inbound("/帮助 更多"));
  const more = h.sent.at(-1).text;
  assert.match(more, /^其他命令/);
  assert.match(more, /\/权限/);
  assert.ok(!more.includes("/回复"));
  assert.equal(h.sent.at(-1).options.format, "command-guide");
  await h.bridge.handleInbound(inbound("/help more"));
  assert.equal(h.sent.at(-1).text, more);
  assert.equal(h.calls.length, 0);
});

test("三个中文配置命令可通过数字菜单完成选择，显示名称和可读思考等级", async t => {
  const h = harness({ allowDangerousRemote: true }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/项目"));
  await h.bridge.handleInbound(inbound("1"));
  assert.ok(h.calls.some(call => call.operation === "project/set"));
  assert.match(h.sent.at(-1).text, /已有会话未移动/);
  await h.bridge.handleInbound(inbound("/模型"));
  assert.match(lastMenu(h).title, /^选择服务商\n当前模型：Provider \/ Model One$/);
  await h.bridge.handleInbound(inbound("1"));
  assert.equal(lastMenu(h).title, "Provider · 选择模型");
  await h.bridge.handleInbound(inbound("2"));
  assert.deepEqual(h.calls.filter(call => call.operation === "session/configure").at(-1).args[1], { mode: "plan", providerId: "p1", modelId: "m2", thinkingLevel: "low" });
  await h.bridge.handleInbound(inbound("/思考"));
  assert.deepEqual(lastMenu(h).options, ["关闭（off）", "低（low）", "高（high） · 当前", "取消"]);
  await h.bridge.handleInbound(inbound("2"));
  assert.deepEqual(h.calls.filter(call => call.operation === "session/configure").at(-1).args[1], { mode: "plan", thinkingLevel: "low" });
  assert.match(h.sent.at(-1).text, /思考等级：低（low）/);
  assert.ok(!h.calls.some(call => call.operation === "agent/prompt"));
});

test("绑定会话从桌面连续执行也回传，重复终态不会重发，解绑后停止同步", async t => {
  const h = harness({ card: true, handlers: {
    "session/get": () => ({ session: { messages: [{ role: "assistant", content: "桌面结果", turnId: "desktop-1" }] } }),
  } }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-1", runId: "run-desktop" });
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-1", runId: "run-desktop", content: "桌面结果" });
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-1", turnId: "desktop-1", reason: "completed" });
  assert.equal(h.turnCalls[0].ended, "completed");
  assert.equal(h.turnCalls[0].texts.join(""), "桌面结果");
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-1", turnId: "desktop-1", reason: "completed" });
  assert.equal(h.turnCalls.length, 1);
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-1", turnId: "desktop-2", reason: "completed" });
  assert.equal(h.turnCalls.length, 1, "未观察到的轮次终态不能触发历史补读");
  h.store.clearBinding("feishu", "oc_1");
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-1", runId: "after-unbind" });
  assert.equal(h.turnCalls.length, 1);
  assert.equal(h.operations().includes("agent/prompt"), false);
});

test("执行中从临时会话 /use 绑定后接收当前扩展输出，完成不误报快照失败", async t => {
  let running = true;
  const h = harness({ card: true, handlers: {
    "agent/getStatus": ({ args }) => ({ status: { isRunning: args[0] === "sess-1" && running,
      ...(args[0] === "sess-1" && running ? { currentTurnId: "desktop-running" } : {}) } }),
    "session/get": () => ({ session: { id: "sess-1", messages: [{ id: "history", role: "assistant", content: "历史正文" }] } }),
  } }); t.after(() => { h.bridge.dispose(); h.cleanup(); });
  h.store.setBinding("feishu", "oc_1", "sess-temp");
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-1", runId: "older-run" });
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-1", runId: "desktop-run" });
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-1", runId: "desktop-run", content: "绑定前正文" });
  await h.bridge.handleInbound(inbound("/use sess-1"));
  assert.equal(h.store.getBinding("feishu", "oc_1").sessionId, "sess-1");
  await h.bridge.handleInbound(inbound("/状态"));
  assert.match(h.sent.at(-1).text, /状态：执行中/);
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-1", runId: "older-run", content: "迟到历史正文" });
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-1", runId: "older-run", finalText: "迟到历史正文" });
  await assert.rejects(h.bridge.handleAgentEvent({ type: "phone_question", sessionId: "sess-1", runId: "desktop-run", questions: [] }), /只有手机发起/);
  const file = await h.bridge.handleAgentEvent({ type: "send_file", sessionId: "sess-1", runId: "desktop-run", filePath: "report.txt" });
  assert.equal(file.success, false);
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-1", runId: "desktop-run", content: "本轮完整回复" });
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-1", runId: "desktop-run", finalText: "本轮完整回复" });
  running = false;
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-1", turnId: "desktop-running", reason: "completed" });
  assert.equal(h.turnCalls.length, 1);
  assert.equal(h.turnCalls[0].texts.join(""), "本轮完整回复");
  assert.equal(h.turnCalls[0].ended, "completed");
  assert.equal(h.operations().includes("agent/prompt"), false);
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
  assert.deepEqual(h.store.getPendingTurns(), []);
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-1", runId: "desktop-run" });
  assert.equal(h.turnCalls.length, 1);
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
});

test("/use 关联空闲会话只更新绑定，不回放历史或建立忙碌轮次", async t => {
  const h = harness({ card: true }); t.after(() => { h.bridge.dispose(); h.cleanup(); });
  h.store.setBinding("feishu", "oc_1", "sess-temp");
  await h.bridge.handleInbound(inbound("/use sess-1"));
  assert.equal(h.store.getBinding("feishu", "oc_1").sessionId, "sess-1");
  assert.equal(h.turnCalls.length, 0);
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
  assert.deepEqual(h.store.getPendingTurns(), []);
  assert.equal(h.operations().includes("session/get"), false);
});

test("/use 之后读取运行状态期间解绑，不建立失效的观察轮次", async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = harness({ card: true, handlers: {
    "agent/getStatus": ({ args }) => args[0] === "sess-1" ? waiting : { status: { isRunning: false } },
  } }); t.after(() => { h.bridge.dispose(); h.cleanup(); });
  h.store.setBinding("feishu", "oc_1", "sess-temp");
  const switching = h.bridge.handleInbound(inbound("/use sess-1"));
  while (!h.calls.some(call => call.operation === "agent/getStatus" && call.args[0] === "sess-1")) await new Promise(resolve => setImmediate(resolve));
  h.store.unpair("feishu", "oc_1");
  release({ status: { isRunning: true, currentTurnId: "desktop-running" } });
  await switching;
  assert.equal(h.turnCalls.length, 0);
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
  assert.deepEqual(h.store.getPendingTurns(), []);
});

test("文本渠道中宿主完成但补读失败仅提示同步失败，宿主执行错误仍保留", async t => {
  for (const reason of ["completed", "error", "aborted"]) {
    const h = harness({ kind: "telegram", handlers: {
      "agent/prompt": () => ({ accepted: true, turnId: "text-turn" }),
      "session/get": () => { throw new Error("snapshot unavailable"); },
    } }); t.after(() => { h.bridge.dispose(); h.cleanup(); });
    await h.bridge.handleInbound(inbound("执行任务", { channel: "telegram" }));
    await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "text-turn", reason });
    const output = h.sent.at(-1).text;
    assert.match(output, /回复同步失败：无法读取本轮回复：snapshot unavailable/);
    if (reason === "completed") assert.doesNotMatch(output, /执行未完成|未产生最终回复/);
    else assert.match(output, reason === "aborted" ? /执行未完成：任务已中断/ : /执行未完成：任务执行失败/);
    assert.deepEqual(h.bridge.snapshot().busySessions, []);
  }
});

test("失败结果显式重试且不重新派发，授权更换后旧结果失效", async t => {
  const h = harness({ kind: "telegram" }); t.after(h.cleanup);
  h.store.setBinding("telegram", "oc_1", "sess-1");
  const binding = h.store.getBinding("telegram", "oc_1");
  const pairing = h.store.getPairings()["telegram:oc_1"];
  h.store.saveFailedDelivery("telegram", "oc_1", { id: "failed-1", text: "待补发结果", sessionId: "sess-1", boundAt: binding.boundAt, pairedAt: pairing.pairedAt, userId: pairing.userId });
  await h.bridge.handleInbound(inbound("/重试", { channel: "telegram" }));
  assert.equal(h.sent.at(-1).text, "待补发结果");
  assert.equal(h.store.getFailedDelivery("telegram", "oc_1"), null);
  assert.equal(h.operations().includes("agent/prompt"), false);
  h.store.saveFailedDelivery("telegram", "oc_1", { text: "旧授权结果", sessionId: "sess-1", boundAt: binding.boundAt, pairedAt: "old", userId: pairing.userId });
  await h.bridge.handleInbound(inbound("/retry", { channel: "telegram" }));
  assert.match(h.sent.at(-1).text, /授权或关联已变化/);
  assert.ok(!h.sent.some(item => item.text === "旧授权结果"));
});

test("手机问答答案回到当前工具，不新增 prompt，解绑后请求失效", async t => {
  const h = harness({ card: true }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("请提问"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new", runId: "remote-run" });
  const request = await h.bridge.handleAgentEvent({ type: "phone_question", sessionId: "sess-new", runId: "remote-run", questions: [{ question: "选平台", options: ["飞书", "微信"], multiSelect: true }] });
  assert.equal(h.turnCalls[0].sealed, true);
  await h.bridge.handleInbound(inbound("1,2"));
  const result = await h.bridge.handleAgentEvent({ type: "phone_question_poll", sessionId: "sess-new", runId: "remote-run", requestId: request.requestId });
  assert.deepEqual(result.answers, [["飞书", "微信"]]);
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
  const second = await h.bridge.handleAgentEvent({ type: "phone_question", sessionId: "sess-new", runId: "remote-run", questions: [{ question: "确认", options: ["好"] }] });
  h.store.clearBinding("feishu", "oc_1");
  const expired = await h.bridge.handleAgentEvent({ type: "phone_question_poll", sessionId: "sess-new", runId: "remote-run", requestId: second.requestId });
  assert.equal(expired.state, "expired");
});

test("私聊日程保存明确会话映射，按时派发且撤销授权后停止", async t => {
  let clock = 1000;
  const h = harness({ now: () => clock, handlers: { "agent/prompt": () => ({ accepted: true, turnId: "scheduled-turn" }) } }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/定时 每隔 5 简述项目状态"));
  const [task] = h.store.getSchedules();
  assert.equal(task.sessionId, "sess-1");
  assert.equal(task.chatId, "oc_1");
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 0);
  clock += 300000;
  await h.bridge.tickSchedules();
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
  assert.match(h.calls.find(call => call.operation === "agent/prompt").args[0].content, /简述项目状态/);
  assert.equal(h.store.getPendingTurns()[0].scheduleId, task.id);
  h.store.unpair("feishu", "oc_1");
  clock += 300000;
  await h.bridge.tickSchedules();
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 1);
  assert.match(h.store.getSchedules()[0].lastError, /授权或会话关联/);
});

test("同会话多私聊的文件只发送给当前任务发起聊天", async t => {
  const h = harness(); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  h.store.unpair("feishu", "oc_1");
  h.store.pair("feishu", "oc_2", { userId: "ou_2" });
  h.store.setBinding("feishu", "oc_2", "sess-1");
  await h.bridge.handleInbound(inbound("发报告", { chatId: "oc_2", userId: "ou_2" }));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-1", runId: "run-file" });
  const file = path.join(h.dir, "report.txt"); fs.writeFileSync(file, "report", "utf8");
  const result = await h.bridge.handleAgentEvent({ type: "send_file", sessionId: "sess-1", runId: "run-file", filePath: file });
  assert.equal(result.success, true);
  assert.deepEqual(h.sent.filter(item => item.upload).map(item => item.chatId), ["oc_2"]);
});

test("范围校验等待期间撤销授权，不调用 agent/prompt", { timeout: 3000 }, async t => {
  let release; let reached;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  const h = harness({ handlers: { "session/list": async () => { reached(); await gate; return { sessions: [{ id: "sess-1", projectPath: "E:\\A" }] }; } } }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  h.store.setProjectAccess("feishu", { mode: "selected", paths: ["E:\\A"] });
  const dispatch = h.bridge.handleInbound(inbound("不能派发"));
  await waiting; h.store.unpair("feishu", "oc_1"); release(); await dispatch;
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 0);
});

test("结束补读期间解绑会清理忙碌状态，重新关联后可以执行", { timeout: 3000 }, async t => {
  let release; let reached; let h;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  h = harness({ handlers: {
    "agent/prompt": () => ({ accepted: true, turnId: "end-turn" }),
    "session/get": async () => { reached(); await gate; return { session: { messages: [{ id: "answer", role: "assistant", turnId: "end-turn", content: "旧回复" }] } }; },
  } }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("旧任务"));
  const ending = h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "end-turn", reason: "completed" });
  await waiting; h.store.clearBinding("feishu", "oc_1"); release(); await ending;
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
  assert.equal(h.store.getPendingTurns().length, 0);
  h.store.setBinding("feishu", "oc_1", "sess-new");
  await h.bridge.handleInbound(inbound("新任务"));
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 2);
});

test("问题投递失败立即报错且不残留待回答请求", async t => {
  const h = harness(); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("提问"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new", runId: "q-run" });
  const question = { type: "phone_question", sessionId: "sess-new", runId: "q-run", questions: [{ question: "选择", options: ["A"] }] };
  h.channel.sendChoice = async () => ({ delivered: false, reason: "offline" });
  await assert.rejects(h.bridge.handleAgentEvent(question), /问题发送失败/);
  h.channel.sendChoice = async () => ({ delivered: true });
  assert.ok((await h.bridge.handleAgentEvent(question)).requestId);
});

test("等待宿主状态期间暂停定时任务，不继续派发", { timeout: 3000 }, async t => {
  let clock = 1000; let block = false; let release; let reached;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  const h = harness({ now: () => clock, handlers: { "agent/getStatus": async () => { if (block) { reached(); await gate; } return { status: { isRunning: false } }; } } }); t.after(h.cleanup);
  h.store.setBinding("feishu", "oc_1", "sess-1");
  await h.bridge.handleInbound(inbound("/定时 每隔 5 定时任务"));
  const id = h.store.getSchedules()[0].id;
  block = true; clock += 300000;
  const ticking = h.bridge.tickSchedules();
  await waiting; await h.bridge.handleInbound(inbound(`/定时 暂停 ${id}`)); release(); await ticking;
  assert.equal(h.calls.filter(call => call.operation === "agent/prompt").length, 0);
  assert.equal(h.store.getSchedules()[0].enabled, false);
});

test("未保存远程配置开关时默认允许项目切换，显式关闭后阻止", async t => {
  const h = harness(); t.after(h.cleanup);
  h.setSettings({ allowDangerousRemote: undefined });
  await h.bridge.handleInbound(inbound("/项目 D:/work/other"));
  assert.equal(h.calls.filter(call => call.operation === "project/set").length, 1);
  h.setSettings({ allowDangerousRemote: false });
  await h.bridge.handleInbound(inbound("/项目 D:/work/other"));
  assert.equal(h.calls.filter(call => call.operation === "project/set").length, 1);
  assert.match(h.sent.at(-1).text, /机器人设置.*允许远程配置切换/);
});

test("执行中绑定后宿主终态先到，仍接收同一扩展轮次稍后到达的最终正文", async t => {
  let snapshotRead;
  const reading = new Promise(resolve => { snapshotRead = resolve; });
  const h = harness({ card: true, handlers: {
    "agent/getStatus": () => ({ status: { isRunning: true, currentTurnId: "desktop-race" } }),
    "session/get": () => { snapshotRead(); return { session: { messages: [] } }; },
  } }); t.after(() => { h.bridge.dispose(); h.cleanup(); });
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-1", runId: "race-run" });
  await h.bridge.handleInbound(inbound("/use sess-1"));
  const ended = h.bridge.handleHostTurnEnded({ sessionId: "sess-1", turnId: "desktop-race", reason: "completed" });
  await reading;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.turnCalls[0].ended, null);
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-1", runId: "unrelated-run", finalText: "错误轮次" });
  assert.equal(h.turnCalls[0].ended, null);
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-1", runId: "race-run", finalText: "迟到但完整的本轮回复" });
  await ended;
  assert.equal(h.turnCalls[0].texts.join(""), "迟到但完整的本轮回复");
  assert.equal(h.turnCalls[0].ended, "completed");
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
  assert.equal(h.operations().includes("agent/prompt"), false);
});

test("执行中绑定但扩展没有最终回执时等待有上限，不把同步失败说成任务失败", { timeout: 5000 }, async t => {
  const h = harness({ card: true, handlers: {
    "agent/getStatus": () => ({ status: { isRunning: true, currentTurnId: "desktop-timeout" } }),
    "session/get": () => ({ session: { messages: [] } }),
  } }); t.after(() => { h.bridge.dispose(); h.cleanup(); });
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-1", runId: "timeout-run" });
  await h.bridge.handleInbound(inbound("/use sess-1"));
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-1", turnId: "desktop-timeout", reason: "completed" });
  assert.match(h.turnCalls[0].texts.join(""), /回复同步失败/);
  assert.doesNotMatch(h.turnCalls[0].texts.join(""), /执行未完成/);
  assert.equal(h.turnCalls[0].ended, "completed");
  assert.deepEqual(h.bridge.snapshot().busySessions, []);
});

test("已接收的最终答复不被落后的过程快照覆盖，飞书终态携带独立结果", async t => {
  const h = harness({ card: true, handlers: {
    "agent/prompt": () => ({ accepted: true, turnId: "final-turn" }),
    "session/get": () => ({ session: { messages: [{ role: "assistant", turnId: "final-turn", content: "过程说明" }] } }),
  } }); t.after(h.cleanup);
  await h.bridge.handleInbound(inbound("完成任务"));
  await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new", runId: "final-run" });
  await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", runId: "final-run", content: "过程说明\n\n最终答复" });
  await h.bridge.handleAgentEvent({ type: "assistant_message", sessionId: "sess-new", runId: "final-run", content: "最终答复", stopReason: "stop" });
  await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", runId: "final-run", finalText: "最终答复" });
  await h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "final-turn", reason: "completed" });
  assert.equal(h.turnCalls[0].texts.join(""), "过程说明\n\n最终答复");
  assert.equal(h.turnCalls[0].details.finalText, "最终答复");
  assert.equal(h.turnCalls[0].ended, "completed");
});

test("已有过程快照时宿主终态仍等待同轮最终回执，空回执不擦除已收到的最终正文", async t => {
  for (const emptyEnd of [false, true]) {
    let snapshotRead;
    const reading = new Promise(resolve => { snapshotRead = resolve; });
    const h = harness({ card: true, handlers: {
      "agent/prompt": () => ({ accepted: true, turnId: "race-final" }),
      "session/get": () => { snapshotRead(); return { session: { messages: [{ role: "assistant", turnId: "race-final", content: "过程说明" }] } }; },
    } }); t.after(h.cleanup);
    await h.bridge.handleInbound(inbound("完成任务"));
    await h.bridge.handleAgentEvent({ type: "agent_start", sessionId: "sess-new", runId: "race-final-run" });
    await h.bridge.handleAgentEvent({ type: "assistant_chunk", sessionId: "sess-new", runId: "race-final-run", content: "过程说明" });
    if (emptyEnd) await h.bridge.handleAgentEvent({ type: "assistant_message", sessionId: "sess-new", runId: "race-final-run", content: "最终答复", stopReason: "stop" });
    const ending = h.bridge.handleHostTurnEnded({ sessionId: "sess-new", turnId: "race-final", reason: "completed" });
    await reading;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.turnCalls[0].ended, null);
    await h.bridge.handleAgentEvent({ type: "agent_end", sessionId: "sess-new", runId: "race-final-run", finalText: emptyEnd ? "" : "最终答复" });
    await ending;
    assert.equal(h.turnCalls[0].details.finalText, "最终答复");
    assert.equal(h.turnCalls[0].texts.join(""), "过程说明\n\n最终答复");
    assert.equal(h.turnCalls[0].ended, "completed");
  }
});
