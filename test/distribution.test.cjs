"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("安装文件脱离 node_modules 后可加载、生成二维码并初始化插件", { timeout: 20000 }, t => {
  const root = path.resolve(__dirname, "..");
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "bot-distribution-"));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  for (const item of ["main.js", "manifest.json", "lib", "vendor"]) fs.cpSync(path.join(root, item), path.join(isolated, item), { recursive: true });
  assert.equal(fs.existsSync(path.join(isolated, "node_modules")), false);
  const result = spawnSync(process.execPath, [path.join(root, "scripts/smoke-plugin.cjs"), isolated], {
    cwd: isolated, encoding: "utf8", timeout: 15000, env: { ...process.env, NODE_PATH: "" },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.match(result.stdout, /Isolated install smoke passed/);
});
