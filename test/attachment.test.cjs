"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  safeAttachmentFilename, mimeTypeFromFilename, normalizeMimeType,
  validateAttachments, attachmentMetadata, isImageAttachment,
} = require("../lib/attachment.cjs");
const { MAX_ATTACHMENT_BYTES } = require("../lib/constants.cjs");

test("附件文件名移除跨平台目录、设备名和非法字符并保留安全扩展名", () => {
  assert.equal(safeAttachmentFilename("../../report.pdf"), "report.pdf");
  assert.equal(safeAttachmentFilename("C:\\private\\..\\CON.txt"), "_CON.txt");
  assert.equal(safeAttachmentFilename("../a:b?.png"), "a_b_.png");
  assert.equal(safeAttachmentFilename("..", "photo", "image/png"), "photo.png");
  assert.equal(safeAttachmentFilename("x".repeat(300) + ".pdf").length, 160);
  assert.match(safeAttachmentFilename("x".repeat(300) + ".pdf"), /\.pdf$/u);
  assert.equal(safeAttachmentFilename("NUL. "), "_NUL");
});

test("图片识别基于标准化 MIME，不能把 kind 或扩展名当作图片内容", () => {
  assert.equal(normalizeMimeType("IMAGE/PNG; charset=binary"), "image/png");
  assert.equal(mimeTypeFromFilename("photo.JPEG"), "image/jpeg");
  assert.equal(isImageAttachment({ kind: "file", mimeType: "IMAGE/PNG; charset=binary" }), true);
  assert.equal(isImageAttachment({ kind: "image", filename: "x.png", mimeType: "application/pdf" }), false);
  assert.equal(isImageAttachment({ mimeType: "image/" }), false);
  assert.equal(isImageAttachment(null), false);
});

test("共享限制整体拒绝超过4个、超过5MB和非法大小，允许边界值和未知提供方大小", () => {
  assert.doesNotThrow(() => validateAttachments([{ sizeBytes: MAX_ATTACHMENT_BYTES }, {}]));
  for (const attachments of [Array(5).fill({}), [{ sizeBytes: MAX_ATTACHMENT_BYTES + 1 }], [{ sizeBytes: -1 }], [{ sizeBytes: NaN }]]) {
    assert.throws(() => validateAttachments(attachments), { code: "ATTACHMENT_LIMIT" });
  }
});

test("下载元数据只暴露统一字段、真实落盘大小以及安全文件名", () => {
  assert.deepEqual(attachmentMetadata("local", {
    kind: "audio", filename: "../voice.ogg", mimeType: "Audio/OGG", sizeBytes: 999,
    aesKey: "secret", downloadUrl: "https://secret",
  }, 3), { path: "local", kind: "audio", filename: "voice.ogg", mimeType: "audio/ogg", sizeBytes: 3 });
});
