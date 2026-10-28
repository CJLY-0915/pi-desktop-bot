"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { onLoad, onUnload, onPanelInvoke } = require("../main.js");
const { createStore } = require("../lib/store.cjs");

test("面板保存、回复方式、配对与按渠道清除凭据", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-panel-"));
  const seed = createStore(dataDir);
  seed.pair("feishu", "chat:feishu");
  seed.setBinding("feishu", "chat:feishu", "session-feishu");
  seed.pair("telegram", "chat:telegram");
  seed.setBinding("telegram", "chat:telegram", "session-telegram");
  const settings = { channel: "feishu", replyMode: "streaming_card" };
  let service;
  globalThis.pi = {
    plugin: {
      getDataPath: async () => dataDir,
      getSettings: async () => ({ ...settings }),
      setSettings: async (patch) => Object.assign(settings, patch),
    },
    commands: { register: async () => {}, unregister: async () => {} },
    services: { register: async (value) => { service = value; } },
    events: { on() {}, off() {} },
    desktop: { invoke: async ({ operation }) => {
      assert.equal(operation, "project/list");
      return { projects: [{ path: "E:\\Project\\A", name: "项目 A" }, { path: "E:\\Project\\B", name: "项目 B" }] };
    } },
  };

  try {
    await onLoad();
    await service.start();
    const initial = await onPanelInvoke("remote-control.getState");
    assert.equal(initial.channelStatus, "unconfigured");
    assert.equal(initial.channelError, "");
    const botfather = await onPanelInvoke("remote-control.getBotFatherQr");
    assert.equal(initial.settings.allowDangerousRemote, undefined);
    const enabled = await onPanelInvoke("remote-control.setRemoteConfigEnabled", { enabled: true });
    assert.equal(settings.allowDangerousRemote, true);
    assert.equal(enabled.settings.allowDangerousRemote, true);
    const disabled = await onPanelInvoke("remote-control.setRemoteConfigEnabled", { enabled: false });
    assert.equal(disabled.settings.allowDangerousRemote, false);
    await assert.rejects(onPanelInvoke("remote-control.setRemoteConfigEnabled", { enabled: "true" }), /布尔值/);
    assert.equal(settings.allowDangerousRemote, false);
    const saveSettings = pi.plugin.setSettings;
    pi.plugin.setSettings = async () => { throw new Error("settings save failed"); };
    await assert.rejects(onPanelInvoke("remote-control.setRemoteConfigEnabled", { enabled: true }), /settings save failed/);
    assert.equal((await onPanelInvoke("remote-control.getState")).settings.allowDangerousRemote, false);
    pi.plugin.setSettings = saveSettings;
    await onPanelInvoke("remote-control.setRemoteConfigEnabled", { enabled: true });
    assert.equal((await onPanelInvoke("remote-control.getState")).settings.allowDangerousRemote, true);
    assert.equal(botfather.url, "https://t.me/BotFather");
    assert.match(botfather.qrDataUrl, /^data:image\/png;base64,/);
    const scope = await onPanelInvoke("remote-control.getProjectAccess", { channel: "feishu" });
    assert.equal(scope.policy.mode, "all");
    assert.equal(scope.projects.length, 2);
    await assert.rejects(onPanelInvoke("remote-control.setProjectAccess", { channel: "feishu", mode: "selected", paths: [] }), /至少选择/);
    await assert.rejects(onPanelInvoke("remote-control.setProjectAccess", { channel: "feishu", mode: "selected", paths: ["E:\\Unknown"] }), /不存在/);
    const scoped = await onPanelInvoke("remote-control.setProjectAccess", { channel: "feishu", mode: "selected", paths: ["e:/project/a/"] });
    assert.deepEqual(scoped.projectAccess.feishu, { mode: "selected", paths: ["E:\\Project\\A"] });
    assert.equal(scoped.projectAccess.telegram.mode, "all");
    assert.equal(createStore(dataDir).getProjectAccess("feishu").mode, "selected");
    await assert.rejects(onPanelInvoke("remote-control.startChannel", { channel: "unknown" }), /不支持/);
    const inactive = await onPanelInvoke("remote-control.startChannel", { channel: "weixin" });
    assert.equal(settings.channel, "weixin");
    assert.equal(inactive.channel, "weixin");
    assert.equal(inactive.channelStatus, "unconfigured");
    await onPanelInvoke("remote-control.saveCredentials", {
      channel: "telegram", telegramBotToken: "123456789:panel-test-token",
    });
    assert.equal(settings.channel, "telegram");
    await assert.rejects(
      onPanelInvoke("remote-control.saveCredentials", { channel: "feishu", feishuAppId: "cli_only" }),
      /完整/,
    );

    await onPanelInvoke("remote-control.saveCredentials", {
      channel: "feishu", feishuAppId: "cli_test", feishuAppSecret: "test-secret",
    });
    const saved = await onPanelInvoke("remote-control.getState");
    assert.equal(saved.credentials.telegramBotToken, "***");
    assert.equal(saved.credentials.feishuAppSecret, "***");
    assert.equal(saved.channel, "feishu");

    assert.equal(saved.replyModes.feishu, "streaming_card");
    for (const mode of ["standard", "full", "summary"]) {
      const updated = await onPanelInvoke("remote-control.updateSettings", { channel: "telegram", replyMode: mode });
      assert.equal(settings.telegramReplyMode, mode);
      assert.equal(updated.replyModes.telegram, mode);
      assert.equal(updated.replyModes.weixin, "standard");
      assert.equal(updated.replyModes.feishu, "streaming_card");
    }
    await onPanelInvoke("remote-control.updateSettings", { channel: "weixin", replyMode: "full" });
    const reloaded = await onPanelInvoke("remote-control.getState");
    assert.equal(reloaded.replyModes.weixin, "full");
    assert.equal(reloaded.replyModes.telegram, "summary");
    await assert.rejects(onPanelInvoke("remote-control.updateSettings", { channel: "feishu", replyMode: "standard" }), /不支持/);
    await assert.rejects(onPanelInvoke("remote-control.updateSettings", { channel: "telegram", replyMode: "unknown" }), /不支持/);
    await assert.rejects(onPanelInvoke("remote-control.updateSettings", { channel: "weixin", replyMode: "streaming_card" }), /不支持/);

    const code = await onPanelInvoke("remote-control.generatePairingCode");
    assert.ok(code.expiresAt > Date.now());
    const pairingState = await onPanelInvoke("remote-control.getState");
    assert.equal(pairingState.pairingCode, code.code);
    assert.equal(pairingState.pairingExpiresAt, code.expiresAt);
    await onPanelInvoke("remote-control.unbind", { channel: "telegram" });
    const unbound = await onPanelInvoke("remote-control.getState");
    assert.equal(unbound.pairingCode, null);
    assert.deepEqual(unbound.pairings, [], "录入新凭据时已撤销孤立授权");
    assert.deepEqual(unbound.bindings, []);
    assert.equal(unbound.credentials.telegramBotToken, "***");

    await onPanelInvoke("remote-control.clearCredentials", { channel: "feishu" });
    const cleared = await onPanelInvoke("remote-control.getState");
    assert.equal(cleared.credentials.feishuAppId, "");
    assert.equal(cleared.credentials.feishuAppSecret, "");
    assert.equal(cleared.credentials.telegramBotToken, "***");
    assert.equal(settings.channel, "feishu");
    assert.deepEqual(cleared.pairings, []);
    assert.deepEqual(cleared.bindings, []);
  } finally {
    await onUnload();
    delete globalThis.pi;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
