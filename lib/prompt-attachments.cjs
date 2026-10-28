"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateAttachments, safeAttachmentFilename, normalizeMimeType, mimeTypeFromFilename, isImageAttachment } = require("./attachment.cjs");

async function stagePromptAttachments(files, sessionId, invoke) {
  validateAttachments(files);
  if (!files.length) return [];
  const scratch = await invoke("session/getScratchPath", [{ sessionId }]);
  if (typeof scratch?.path !== "string" || !path.isAbsolute(scratch.path)) throw new Error("宿主未返回有效的会话附件目录");
  const directory = path.join(scratch.path, "remote-attachments");
  fs.mkdirSync(directory, { recursive: true });
  const staged = [];
  try {
    for (const file of files) {
      const stat = fs.statSync(file.path);
      if (!stat.isFile()) throw new Error("附件必须是普通文件");
      validateAttachments([{ sizeBytes: stat.size }]);
      const mimeType = normalizeMimeType(file.mimeType) || mimeTypeFromFilename(file.filename ?? file.path) || "application/octet-stream";
      const name = safeAttachmentFilename(file.filename ?? path.basename(file.path), "attachment", mimeType);
      const destination = path.join(directory, `${randomUUID()}-${name}`);
      fs.copyFileSync(file.path, destination, fs.constants.COPYFILE_EXCL);
      staged.push({ path: destination, name, kind: isImageAttachment({ mimeType }) && mimeType !== "image/svg+xml" ? "image" : "file", mimeType, size: stat.size });
    }
    return staged;
  } catch (error) {
    for (const file of staged) fs.rmSync(file.path, { force: true });
    throw error;
  }
}
module.exports = { stagePromptAttachments };
