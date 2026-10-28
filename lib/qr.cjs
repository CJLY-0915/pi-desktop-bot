"use strict";

const QRCode = require("../vendor/qrcode.cjs");
const BOTFATHER_URL = "https://t.me/BotFather";

async function qrDataUrl(value) {
  if (typeof value !== "string" || !value) throw new Error("平台未返回二维码内容");
  if (/^data:image\//.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return QRCode.toDataURL(value, { margin: 2, width: 280 });
  return `data:image/png;base64,${value}`;
}

module.exports = { qrDataUrl, BOTFATHER_URL };
