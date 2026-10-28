"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (!Module.isBuiltin(name) && !name.startsWith(".") && !path.isAbsolute(name)) {
    throw Object.assign(new Error(`Package must be bundled: ${name}`), { code: "MODULE_NOT_FOUND" });
  }
  return originalLoad.call(this, name, ...args);
};

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-install-smoke-"));
  let plugin;
  let registeredCommand;
  let registeredService;
  globalThis.pi = {
    plugin: { getDataPath: async () => dataDir, getSettings: async () => ({}) },
    commands: { register: async value => { registeredCommand = value; }, unregister: async () => {} },
    services: { register: async value => { registeredService = value; } },
    events: { on() {}, off() {} },
  };
  try {
    plugin = require(path.join(root, "main.js"));
    const qr = require(path.join(root, "lib/qr.cjs"));
    const png = await qr.qrDataUrl(qr.BOTFATHER_URL);
    assert.match(png, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(png.split(",")[1], "base64").subarray(1, 4).toString(), "PNG");
    const feishu = require(path.join(root, "vendor/feishu.cjs"));
    const dingtalk = require(path.join(root, "vendor/dingtalk.cjs"));
    assert.equal(typeof feishu.WSClient, "function");
    assert.equal(typeof feishu.EventDispatcher, "function");
    assert.equal(typeof dingtalk.DWClient, "function");
    assert.equal(typeof dingtalk.TOPIC_ROBOT, "string");
    require(path.join(root, "lib/feishu.cjs"));
    require(path.join(root, "lib/dingtalk.cjs"));
    await plugin.onLoad();
    assert.equal(registeredCommand.id, "mobile-remote.openPanel");
    assert.equal(typeof registeredService.start, "function");
    const state = await plugin.onPanelInvoke("remote-control.getState");
    assert.ok(state.channels);
    console.log("Isolated install smoke passed: entry, SDKs, PNG QR, onLoad and panel state; no external npm modules or platform requests.");
  } finally {
    if (plugin) await plugin.onUnload();
    delete globalThis.pi;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
