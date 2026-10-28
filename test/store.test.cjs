"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../lib/store.cjs");

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-remote-${name}-`));
  return dir;
}

test("pairings and bindings persist across store instances", () => {
  const dir = tempDir("state");
  const first = createStore(dir);
  first.pair("feishu", "oc_chat_1", { userId: "ou_1" });
  first.setBinding("feishu", "oc_chat_1", "session-abc");
  first.setPairingCode("ABC234");

  const second = createStore(dir);
  assert.equal(second.isPaired("feishu", "oc_chat_1"), true);
  assert.equal(second.isPaired("feishu", "oc_other"), false);
  assert.equal(second.getBinding("feishu", "oc_chat_1").sessionId, "session-abc");
  assert.equal(second.getPairingCode().code, "ABC234");

  second.unpair("feishu", "oc_chat_1");
  const third = createStore(dir);
  assert.equal(third.isPaired("feishu", "oc_chat_1"), false);
  assert.equal(third.getBinding("feishu", "oc_chat_1").sessionId, "session-abc");

  third.clearBinding("feishu", "oc_chat_1");
  assert.equal(createStore(dir).getBinding("feishu", "oc_chat_1"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("credentials round-trip and clear", () => {
  const dir = tempDir("creds");
  const store = createStore(dir);
  assert.equal(store.loadCredentials(), null);
  store.saveCredentials({ feishuAppId: "cli_x", feishuAppSecret: "secret" });
  const reloaded = createStore(dir).loadCredentials();
  assert.equal(reloaded.feishuAppId, "cli_x");
  assert.equal(reloaded.feishuAppSecret, "secret");
  store.clearCredentials();
  assert.equal(createStore(dir).loadCredentials(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("audit log appends, reads newest first and rotates at 512KB", () => {
  const dir = tempDir("audit");
  const store = createStore(dir);
  store.audit({ event: "one" });
  store.audit({ event: "two" });
  const entries = store.readAudit(10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, "two", "最新在前");

  // 制造超过 512KB 的日志触发滚动
  const big = "x".repeat(600 * 1024);
  store.audit({ event: "big", payload: big });
  store.audit({ event: "after-rotation" });
  assert.ok(fs.existsSync(`${store.auditFile}.old`), "旧日志应被保留为 .old");
  const after = store.readAudit(10);
  assert.ok(after.some((entry) => entry.event === "after-rotation"));
  assert.ok(!after.some((entry) => entry.event === "big"), "滚动后旧大日志不再出现在尾部窗口");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("草稿、日程和失败结果持久化，微信上下文只在凭据文件且撤销授权时清除", t => {
  const dir = tempDir("recovery"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  store.pair("weixin", "chat", { userId: "owner" });
  store.setBinding("weixin", "chat", "session", { draft: true });
  store.saveContextToken("weixin", "chat", "private-context");
  store.saveFailedDelivery("weixin", "chat", { id: "failed", text: "回复" });
  store.saveSchedules([{ id: "task", chatId: "chat", sessionId: "session" }]);
  let reloaded = createStore(dir);
  assert.equal(reloaded.getBinding("weixin", "chat").draft, true);
  assert.equal(reloaded.getContextToken("weixin", "chat"), "private-context");
  assert.ok(!fs.readFileSync(reloaded.stateFile, "utf8").includes("private-context"));
  assert.equal(reloaded.getFailedDelivery("weixin", "chat").text, "回复");
  assert.equal(reloaded.getSchedules()[0].id, "task");
  reloaded.updateBinding("weixin", "chat", { draft: false });
  reloaded.unpair("weixin", "chat");
  reloaded = createStore(dir);
  assert.equal(reloaded.getBinding("weixin", "chat").draft, false);
  assert.equal(reloaded.getContextToken("weixin", "chat"), "");
  assert.equal(reloaded.getFailedDelivery("weixin", "chat"), null);
});
