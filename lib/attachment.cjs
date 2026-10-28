"use strict";

const { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } = require("./constants.cjs");

const MIME_EXTENSIONS = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
  "image/webp": ".webp", "image/svg+xml": ".svg", "image/bmp": ".bmp",
  "image/heic": ".heic", "image/heif": ".heif", "image/avif": ".avif",
  "application/pdf": ".pdf", "text/plain": ".txt", "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3", "video/mp4": ".mp4",
};

function normalizeMimeType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function mimeTypeFromFilename(filename) {
  const extension = /\.[a-z0-9]+$/iu.exec(String(filename ?? ""))?.[0].toLowerCase();
  if (extension === ".jpeg") return "image/jpeg";
  return Object.keys(MIME_EXTENSIONS).find(mime => MIME_EXTENSIONS[mime] === extension) || "";
}

/** Keep a display filename usable on both Windows and POSIX, never a caller-supplied path. */
function safeAttachmentFilename(value, fallback = "attachment", mimeType = "") {
  const clean = text => String(text ?? "").split(/[\\/]/u).at(-1)
    .replace(/[<>:"|?*\x00-\x1f\x7f]/gu, "_").replace(/[. ]+$/u, "").trim();
  let filename = clean(value) || clean(fallback) || "attachment";
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(filename)) filename = `_${filename}`;
  const extension = /\.[a-z0-9]{1,12}$/iu.exec(filename)?.[0] || MIME_EXTENSIONS[normalizeMimeType(mimeType)] || "";
  const stem = extension && filename.toLowerCase().endsWith(extension.toLowerCase())
    ? filename.slice(0, -extension.length) : filename;
  return `${stem.slice(0, 160 - extension.length)}${extension}`;
}

function attachmentLimitError(message) {
  return Object.assign(new Error(message), { code: "ATTACHMENT_LIMIT" });
}

/** Reject the entire message, so text can never execute with a truncated attachment set. */
function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) throw new TypeError("attachments must be an array");
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw attachmentLimitError(`附件数量超过 ${MAX_ATTACHMENTS_PER_MESSAGE} 个上限`);
  }
  for (const attachment of attachments) {
    if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== null &&
        (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0)) {
      throw attachmentLimitError("附件大小无效");
    }
    if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw attachmentLimitError(`附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`);
    }
  }
}

/** Downloaded size is authoritative; callers supply provider metadata and a local path. */
function attachmentMetadata(filePath, source, sizeBytes) {
  const mimeType = normalizeMimeType(source.mimeType) || mimeTypeFromFilename(source.filename) || "application/octet-stream";
  const kind = ["image", "audio", "video", "file"].includes(source.kind) ? source.kind : "file";
  const attachment = {
    path: filePath,
    kind,
    filename: safeAttachmentFilename(source.filename, "attachment", mimeType),
    mimeType,
    sizeBytes,
  };
  validateAttachments([attachment]);
  return attachment;
}

/** Only MIME identifies an image; a provider kind or a misleading extension is insufficient. */
function isImageAttachment(attachment) {
  return /^image\/[a-z0-9.+-]+$/u.test(normalizeMimeType(attachment?.mimeType));
}

module.exports = {
  normalizeMimeType, mimeTypeFromFilename, safeAttachmentFilename,
  validateAttachments, attachmentMetadata, isImageAttachment,
};
