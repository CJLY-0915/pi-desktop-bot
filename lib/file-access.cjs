"use strict";
const fs = require("node:fs");
const path = require("node:path");

function resolveSendFile(input, { projectPath, policy }) {
  if (typeof input !== "string" || !input.trim()) throw new Error("请提供文件路径");
  if (!path.isAbsolute(input) && !projectPath) throw new Error("无法确定文件所属项目，请使用绝对路径");
  const file = fs.realpathSync(path.resolve(projectPath || ".", input));
  if (!fs.statSync(file).isFile()) throw new Error("只能发送普通文件");
  const parts = file.split(/[\\/]/);
  if (parts.some(part => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials\.json|ipc\.json)$/i.test(part)) || /\.(?:pem|key)$/i.test(file)) {
    throw new Error("不能发送凭据或密钥文件");
  }
  if (policy.mode === "selected") {
    const allowed = policy.paths.some(root => {
      let realRoot;
      try { realRoot = fs.realpathSync(root); } catch { return false; }
      const relative = path.relative(realRoot, file);
      return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (!allowed) throw new Error("该文件不在机器人允许的项目范围内");
  }
  return file;
}

module.exports = { resolveSendFile };
