"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { resolveSendFile } = require("../lib/file-access.cjs");

test("发送文件按真实路径限制项目范围，拒绝目录、凭据和目录链接越界", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-send-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, "report.txt"), "report", "utf8");
  fs.writeFileSync(path.join(project, ".env.local"), "secret", "utf8");
  fs.writeFileSync(path.join(outside, "external.txt"), "external", "utf8");
  fs.symlinkSync(outside, path.join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
  const options = { projectPath: project, policy: { mode: "selected", paths: [project] } };
  assert.equal(resolveSendFile("report.txt", options), fs.realpathSync(path.join(project, "report.txt")));
  assert.throws(() => resolveSendFile("../outside/external.txt", options), /允许的项目范围/);
  assert.throws(() => resolveSendFile("linked/external.txt", options), /允许的项目范围/);
  assert.throws(() => resolveSendFile(".env.local", options), /凭据或密钥/);
  assert.throws(() => resolveSendFile(project, options), /普通文件/);
  assert.equal(resolveSendFile(path.join(outside, "external.txt"), { policy: { mode: "all", paths: [] } }), fs.realpathSync(path.join(outside, "external.txt")));
});
