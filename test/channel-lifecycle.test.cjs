"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createStore } = require("../lib/store.cjs");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-lifecycle-"));
  const disk = createStore(dir);
  if (options.credentials) disk.saveCredentials(options.credentials);
  if (options.seed) options.seed(disk);
  const settings = { channel: options.kind ?? "feishu" };
  const channels = [];
  const listeners = new Map();
  let ipcEvent;
  let service;
  const previousPi = globalThis.pi;
  if (options.desktop) {
    globalThis.pi = { desktop: options.desktop };
    t.after(() => { globalThis.pi = previousPi; });
  }
  const filename = require.resolve("../main.js");
  const localRequire = createRequire(filename);
  const sandbox = {
    module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
    pi: {
      desktop: options.desktop,
      plugin: { getDataPath: async () => dir, getSettings: async () => ({ ...settings }), setSettings: async patch => Object.assign(settings, patch) },
      commands: { register: async () => {}, unregister: async () => {} },
      services: { register: async value => { service = value; } },
      events: { on: (name, handler) => listeners.set(name, handler), off: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); } },
    },
    require(name) {
      if (name === "./lib/feishu-registration.cjs") return { createFeishuRegistration: () => options.registration };
      if (name === "./lib/weixin-registration.cjs") return { createWeixinRegistration: () => options.registration };
      if (name === "./lib/ipc.cjs") return { startIpcServer: async callbacks => { ipcEvent = callbacks.onEvent; return { port: 0, stop: async () => {} }; } };
      if (name === "./lib/qr.cjs") return { qrDataUrl: async () => "data:image/png;base64,test", BOTFATHER_URL: "https://t.me/BotFather" };
      if (name === "./lib/channel.cjs") return { createChannel(kind, callbacks) {
        if (options.createChannel) return options.createChannel(kind, callbacks);
        const channel = { kind, callbacks, stopped: false, start: options.start ?? (async () => callbacks.onStatus("connected")), async stop() { this.stopped = true; await options.stop?.(this); callbacks.onStatus("stopped"); } };
        channels.push(channel);
        return channel;
      } };
      return localRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  const api = sandbox.module.exports;
  await api.onLoad();
  t.after(async () => { await api.onUnload(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { invoke: (action, payload) => api.onPanelInvoke(`remote-control.${action}`, payload), disk: () => createStore(dir), channels, settings, listeners, unload: api.onUnload,
    emit: event => ipcEvent(event), service: () => service, dir };
}

for (const kind of ["feishu", "weixin"]) {
  const name = kind === "feishu" ? "App" : "Weixin";
  const session = { deviceCode: "device", qrCode: "qr", qrUrl: "https://example.com/qr", expiresAt: Date.now() + 600000 };
  const success = kind === "feishu" ? { status: "success", appId: "cli_new", appSecret: "new-secret" } : { status: "success", botToken: "new-token", botId: "new-bot" };

  test(`${kind}：取消尚未完成的二维码创建后，不能恢复旧扫码会话`, async t => {
    const begin = deferred();
    const h = await harness(t, { kind, registration: { begin: () => begin.promise, poll: async () => success } });
    const pending = h.invoke(`begin${name}Registration`);
    await h.invoke(`cancel${name}Registration`);
    begin.resolve(session);
    await pending;
    assert.equal((await h.invoke(`poll${name}Registration`)).status, "idle");
    assert.equal(h.disk().loadCredentials(), null);
  });

  test(`${kind}：取消或重建扫码后，迟到的授权成功不能落盘或切换渠道`, async t => {
    const poll = deferred();
    const h = await harness(t, { registration: { begin: async () => session, poll: () => poll.promise } });
    await h.invoke(`begin${name}Registration`);
    const pending = h.invoke(`poll${name}Registration`);
    await h.invoke(`cancel${name}Registration`);
    await h.invoke(`begin${name}Registration`);
    poll.resolve(success);
    assert.equal((await pending).status, "idle");
    assert.equal(h.disk().loadCredentials(), null);
    assert.equal(h.settings.channel, "feishu");
  });
}

test("替换机器人清除该渠道授权、会话和游标，保留其他渠道；相同凭据不清除", async t => {
  const h = await harness(t, {
    kind: "telegram", credentials: { telegramBotToken: "old-token", weixinBotToken: "wx-token" },
    seed(store) {
      for (const kind of ["telegram", "weixin"]) { store.pair(kind, "chat"); store.setBinding(kind, "chat", `session-${kind}`); store.setOffset(kind, kind === "telegram" ? 900 : "wx-buf"); }
      store.setPairingCode("AB2345");
    },
  });
  await h.invoke("saveCredentials", { channel: "telegram", telegramBotToken: "old-token" });
  assert.equal(h.disk().isPaired("telegram", "chat"), true);
  assert.equal(h.disk().getOffset("telegram"), 900);
  await h.invoke("saveCredentials", { channel: "telegram", telegramBotToken: "new-token" });
  assert.equal(h.disk().isPaired("telegram", "chat"), false);
  assert.equal(h.disk().getBinding("telegram", "chat"), null);
  assert.equal(h.disk().getOffset("telegram"), null);
  assert.equal(h.disk().getPairingCode(), null);
  assert.equal(h.disk().isPaired("weixin", "chat"), true);
  assert.equal(h.disk().getOffset("weixin"), "wx-buf");
  await h.invoke("clearCredentials", { channel: "weixin" });
  assert.equal(h.disk().getOffset("weixin"), null);
});

test("已停止的连接回调和游标写入不能污染新渠道", async t => {
  const h = await harness(t, { credentials: { feishuAppId: "cli_test", feishuAppSecret: "secret", telegramBotToken: "token" } });
  await h.invoke("startChannel", { channel: "feishu" });
  const old = h.channels[0];
  await h.invoke("startChannel", { channel: "telegram" });
  await h.invoke("stopChannel", { channel: "feishu" });
  old.callbacks.onStatus("stopped", "late failure");
  await old.callbacks.saveOffset(123);
  const state = await h.invoke("getState");
  assert.equal(state.channel, "telegram");
  assert.equal(state.channelStatus, "connected");
  assert.equal(state.channelError, "");
  assert.equal(h.disk().getOffset("feishu"), null);
});

for (const cancel of [false, true]) {
  test(`旧连接延迟停止时，${cancel ? "停止操作取消所有等待启动" : "仅最新启动生效且保留正确状态"}`, async t => {
    const entered = deferred();
    const closing = deferred();
    const h = await harness(t, {
      credentials: { feishuAppId: "cli_test", feishuAppSecret: "secret" },
      stop: async () => { entered.resolve(); await closing.promise; },
    });
    await h.invoke("startChannel");
    const first = h.invoke("startChannel");
    await entered.promise;
    const second = h.invoke(cancel ? "stopChannel" : "startChannel");
    await new Promise(resolve => setImmediate(resolve));
    closing.resolve();
    await Promise.all([first, second]);
    const state = await h.invoke("getState");
    assert.equal(h.channels.length, cancel ? 1 : 2);
    assert.equal(h.channels.filter(channel => !channel.stopped).length, cancel ? 0 : 1);
    assert.equal(state.channelStatus, cancel ? "stopped" : "connected");
  });
}

test("加载时订阅宿主完成事件，卸载时注销同一处理器", async t => {
  const h = await harness(t);
  assert.equal(typeof h.listeners.get("session:turnEnded"), "function");
  await h.listeners.get("session:turnEnded")({ sessionId: "unrelated", turnId: "old", reason: "completed" });
  await h.unload();
  assert.equal(h.listeners.has("session:turnEnded"), false);
});

test("微信主入口以真实拉取结果更新面板，412 后可恢复且不伪装投递失败", { timeout: 3000 }, async t => {
  const retry = deferred();
  const failed = deferred();
  const connected = deferred();
  let polls = 0;
  const h = await harness(t, {
    kind: "weixin", credentials: { weixinBotToken: "bot-token" },
    createChannel(kind, callbacks) {
      assert.equal(kind, "weixin");
      return require("../lib/weixin.cjs").createWeixinChannel({
        ...callbacks,
        sleep: async () => { failed.resolve(); await retry.promise; },
        requestJson: async options => {
          assert.match(options.url, /\/getupdates$/);
          if (polls++ === 0) return { status: 412, data: null };
          if (polls === 2) return { status: 200, data: { ret: 0, msgs: [], get_updates_buf: "first-buf" } };
          connected.resolve();
          return new Promise((resolve, reject) => {
            const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            if (options.signal.aborted) abort();
            else options.signal.addEventListener("abort", abort, { once: true });
          });
        },
      });
    },
  });
  await h.invoke("startChannel");
  await failed.promise;
  let state = await h.invoke("getState");
  assert.notEqual(state.channelStatus, "connected");
  assert.match(state.channelError, /getupdates.*HTTP 412/);
  assert.equal(state.deliveryError, "");
  retry.resolve();
  await connected.promise;
  state = await h.invoke("getState");
  assert.equal(state.channelStatus, "connected");
  assert.equal(state.channelError, "");
  assert.equal(state.deliveryError, "");
  assert.equal(h.disk().getOffset("weixin"), "first-buf");
});

test("飞书与 Telegram 同绑 A-1 后状态各回原渠道，轮次独立恢复且手机工具只给发起端", { timeout: 10000 }, async t => {
  const channels = new Map();
  const calls = [];
  let currentProject = "E:/B";
  let running = false;
  let prompt;
  const h = await harness(t, {
    credentials: { feishuAppId: "cli", feishuAppSecret: "secret", telegramBotToken: "token" },
    seed(store) {
      for (const kind of ["feishu", "telegram"]) store.pair(kind, "same-chat", { userId: "owner" });
    },
    desktop: { invoke: async payload => {
      calls.push(payload);
      switch (payload.operation) {
        case "project/list": return { projects: [{ path: "E:/A", name: "A" }] };
        case "project/get": return { workspace: { path: currentProject } };
        case "project/set": currentProject = payload.args[0]; return { workspace: { path: currentProject } };
        case "session/list": return { sessions: [{ id: "A-1", title: "A-1", projectPath: "E:/A" }] };
        case "session/get": return { session: { id: "A-1", title: "A-1", projectPath: h.dir, messages: prompt ? [
          { id: prompt.messageId, role: "user", content: "任务" },
          { id: "answer", role: "assistant", content: "本轮结果" },
        ] : [{ id: "history", role: "assistant", content: "旧历史" }] } };
        case "agent/getStatus": return { status: { isRunning: running, ...(running ? { currentTurnId: "turn-A" } : {}) } };
        case "agent/prompt": prompt = payload.args[0]; running = true; return { accepted: true, turnId: "turn-A" };
        case "providers/list": return { providers: [] };
        case "plans/pending": return { plans: [] };
        default: return { ok: true };
      }
    } },
    createChannel(kind, callbacks) {
      const active = { kind, callbacks, sent: [], stopped: false,
        start: async () => callbacks.onStatus("connected"),
        stop: async () => { active.stopped = true; callbacks.onStatus("stopped"); },
        sendText: async (chatId, text) => { active.sent.push({ chatId, text }); return { delivered: true }; },
        sendChoice: async (chatId, request) => { active.sent.push({ chatId, request }); return { delivered: true }; },
        uploadMedia: async (chatId, file) => { active.sent.push({ chatId, file }); return { name: path.basename(file) }; },
      };
      channels.set(kind, active);
      return active;
    },
  });
  await h.invoke("setRemoteConfigEnabled", { enabled: true });
  let seq = 0;
  const inbound = (kind, text) => channels.get(kind).callbacks.onMessage({ chatId: "same-chat", userId: "owner", text, messageId: `${++seq}` });
  for (const kind of ["feishu", "telegram"]) {
    await h.invoke("startChannel", { channel: kind });
    await inbound(kind, "/项目 E:/A");
    await inbound(kind, "/use A-1");
  }
  assert.equal(channels.get("feishu").stopped, false);
  let state = await h.invoke("getState");
  assert.equal(state.channels.feishu.channelStatus, "connected");
  assert.equal(state.channels.telegram.channelStatus, "connected");
  const feishuBefore = channels.get("feishu").sent.length;
  const tgBefore = channels.get("telegram").sent.length;
  await inbound("feishu", "/状态");
  assert.match(channels.get("feishu").sent.at(-1).text, /会话：A-1.*\n状态：空闲/);
  assert.equal(channels.get("telegram").sent.length, tgBefore);
  await inbound("telegram", "/状态");
  assert.equal(channels.get("feishu").sent.length, feishuBefore + 1);
  const sizes = [...channels.values()].map(channel => channel.sent.length);
  await h.listeners.get("session:turnEnded")({ sessionId: "A-1", turnId: "old-turn", reason: "completed" });
  assert.deepEqual([...channels.values()].map(channel => channel.sent.length), sizes);
  await inbound("feishu", "执行一次");
  await inbound("telegram", "不要并发执行");
  assert.match(channels.get("telegram").sent.at(-1).text, /其他渠道执行/);
  assert.equal(calls.filter(call => call.operation === "agent/prompt").length, 1);
  await h.emit({ type: "agent_start", sessionId: "A-1", runId: "run-A" });
  assert.equal(h.disk().getPendingTurns().length, 2);
  const question = await h.emit({ type: "phone_question", sessionId: "A-1", runId: "run-A", questions: [{ question: "确认", options: ["是", "否"] }] });
  assert.ok(question.requestId);
  assert.match(channels.get("feishu").sent.at(-1).request.prompt, /确认/);
  assert.equal(channels.get("telegram").sent.some(item => item.request), false);
  const report = path.join(h.dir, "report.txt");
  fs.writeFileSync(report, "report", "utf8");
  const file = await h.emit({ type: "send_file", sessionId: "A-1", runId: "run-A", filePath: report });
  assert.equal(file.success, true);
  assert.equal(channels.get("feishu").sent.some(item => item.file === report), true);
  assert.equal(channels.get("telegram").sent.some(item => item.file), false);
  await h.service().stop();
  assert.deepEqual(h.disk().getPendingTurns().map(turn => turn.channel).sort(), ["feishu", "telegram"]);
  await h.service().start();
  assert.equal(channels.get("feishu").stopped, false);
  assert.equal(channels.get("telegram").stopped, false);
  assert.deepEqual(h.disk().getPendingTurns().map(turn => turn.messageId), [prompt.messageId, prompt.messageId]);
  assert.equal(calls.filter(call => call.operation === "agent/prompt").length, 1);
  await h.emit({ type: "agent_end", sessionId: "A-1", runId: "run-A", finalText: "本轮结果" });
  running = false;
  await h.listeners.get("session:turnEnded")({ sessionId: "A-1", turnId: "turn-A", reason: "completed" });
  for (const channel of channels.values()) {
    const text = channel.sent.map(item => item.text ?? "").join("\n");
    assert.match(text, /本轮结果/);
    assert.doesNotMatch(text, /快照未包含|执行未完成|旧历史/);
  }
  assert.equal(h.disk().getPendingTurns().length, 0);
  await h.invoke("stopChannel", { channel: "telegram" });
  state = await h.invoke("getState");
  assert.equal(state.channels.feishu.channelStatus, "connected");
  assert.equal(state.channels.telegram.channelStatus, "stopped");
  assert.deepEqual(h.disk().getEnabledChannels(), ["feishu"]);
  await h.service().stop();
  await h.service().start();
  assert.equal(channels.get("feishu").stopped, false);
  assert.equal(channels.get("telegram").stopped, true);
});
