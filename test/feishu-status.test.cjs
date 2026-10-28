"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function harness(readyOnStart = false, options = {}) {
  const filename = require.resolve("../lib/feishu.cjs");
  const localRequire = createRequire(filename);
  let callbacks;
  const statuses = [];
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === "../vendor/feishu.cjs" ? {
      WSClient: class {
        constructor(options) { callbacks = options; }
        start() { if (readyOnStart) callbacks.onReady(); return options.start?.(); }
        close() {}
      },
      EventDispatcher: class { register() {} },
    } : localRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  const channel = sandbox.module.exports.createFeishuChannel({
    appId: options.appId ?? "cli_0123456789abcdef", appSecret: "test-secret",
    onStatus: (...args) => statuses.push(args),
  });
  return { channel, statuses, callbacks: () => callbacks };
}

test("飞书状态跟随 SDK 首次连接、断线重连和重连成功", async () => {
  const h = harness();
  await h.channel.start();
  assert.deepEqual(h.statuses, [["connecting"]]);
  h.callbacks().onReady();
  h.callbacks().onReconnecting();
  h.callbacks().onReconnected();
  assert.deepEqual(h.statuses, [["connecting"], ["connected"], ["connecting"], ["connected"]]);
});

test("start 内同步成功回调不会被 connecting 覆盖", async () => {
  const h = harness(true);
  await h.channel.start();
  assert.deepEqual(h.statuses, [["connecting"], ["connected"]]);
});

test("连接终止上报错误，停止后忽略迟到回调", async () => {
  const h = harness();
  await h.channel.start();
  h.callbacks().onError(new Error("invalid app credentials"));
  assert.deepEqual(h.statuses.at(-1), ["stopped", "invalid app credentials"]);
  await h.channel.stop();
  const count = h.statuses.length;
  h.callbacks().onReady();
  h.callbacks().onReconnecting();
  h.callbacks().onReconnected();
  h.callbacks().onError(new Error("late failure"));
  assert.equal(h.statuses.length, count);
  assert.deepEqual(h.statuses.at(-1), ["stopped"]);
});

test("非法 App ID 在 SDK 静默返回前明确拒绝", async () => {
  const h = harness(false, { appId: "invalid" });
  await assert.rejects(h.channel.start(), /App ID/);
  assert.equal(h.callbacks(), undefined);
});

test("SDK start Promise 拒绝被处理并上报，不产生未处理异常", async () => {
  const h = harness(false, { start: () => Promise.reject(new Error("startup rejected")) });
  await h.channel.start();
  assert.deepEqual(h.statuses.at(-1), ["stopped", "startup rejected"]);
  await h.channel.stop();
});
