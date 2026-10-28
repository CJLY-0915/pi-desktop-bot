"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function panelHarness(status = "starting") {
  const nodes = new Map();
  const calls = [];
  const snapshot = { channel: "feishu", channelStatus: status, channelError: "", credentials: { feishuAppId: "cli_test", feishuAppSecret: "***" }, pairings: [] };
  const context = vm.createContext({
    document: { getElementById(id) {
      if (!nodes.has(id)) {
        const classes = new Set();
        nodes.set(id, { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, add(name) { classes.add(name); }, contains(name) { return classes.has(name); } }, style: {}, setAttribute() {}, removeAttribute() {} });
      }
      return nodes.get(id);
    } },
    window: { pluginBridge: { async invoke(channel) {
      calls.push(channel);
      if (channel === "remote-control.startChannel") return snapshot;
      if (channel === "remote-control.generatePairingCode") return { code: "AB2345", expiresAt: Date.now() + 600000 };
      throw new Error(`Unexpected call: ${channel}`);
    } } },
    setTimeout: () => 0, clearTimeout() {},
  });
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('$("toggleBtn").addEventListener')), context);
  vm.runInContext("render = () => {};", context);
  return { nodes, calls, snapshot, run: expression => vm.runInContext(expression, context) };
}

test("飞书启动中自动生成并显示绑定命令，刷新复用，重新生成不重启渠道", async () => {
  const h = panelHarness();
  await h.run("startChannel()");
  assert.equal(h.nodes.get("bindCmdText").textContent, "/bind AB2345");
  assert.equal(h.nodes.get("bindPanel").classList.contains("hidden"), false);
  assert.equal(h.run("isOnline()"), false, "生成命令不能伪造已连接状态");
  await h.run("showBindCommand()");
  assert.equal(h.calls.filter(call => call.endsWith("generatePairingCode")).length, 1);
  h.run("state.bind.expiresAt = Date.now() - 1; renderBindCode();");
  await h.run("generateBindCode()");
  assert.equal(h.calls.filter(call => call.endsWith("startChannel")).length, 1);
  assert.equal(h.calls.filter(call => call.endsWith("generatePairingCode")).length, 2);
  h.snapshot.channelStatus = "connecting";
  h.run("renderBindCode()");
  assert.equal(h.nodes.get("bindPanel").classList.contains("hidden"), false);
  h.snapshot.pairings = [{ channel: "feishu", chatId: "chat" }];
  h.run("renderBindCode()");
  assert.equal(h.nodes.get("bindPanel").classList.contains("hidden"), true);
});

test("飞书明确连接失败时不生成绑定命令", async () => {
  const h = panelHarness("stopped");
  h.snapshot.channelError = "凭据无效";
  await h.run("startChannel()");
  assert.equal(h.calls.includes("remote-control.generatePairingCode"), false);
});
