"use strict";

const crypto = require("node:crypto");

/**
 * 远程控制安全面：配对码、聊天白名单、限速、出站脱敏。
 * 纯函数集合，不依赖宿主 API，便于单测。
 */

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const RATE_LIMIT_PER_MINUTE = 12;

/** 覆盖 `key: value`、`"key": "value"`、`key=value` 与 JWT。 */
const SECRET_PATTERNS = [
  /["']?(?:secret|token|password|passwd|api[_-]?key)["']?\s*[:=]\s*["']?[^\s"',;}]{6,}/gi,
  /\b[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{10,}\b/g,
];

function generatePairingCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += PAIRING_CODE_ALPHABET[crypto.randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return { code, at: Date.now() };
}

function pairingCodeValid(stored, now = Date.now(), ttlMs = PAIRING_CODE_TTL_MS) {
  if (!stored || !stored.code || !stored.at) return false;
  return now - stored.at <= ttlMs;
}

function verifyPairingCode(stored, candidate) {
  if (!pairingCodeValid(stored)) {
    return { ok: false, reason: "配对码不存在或已过期，请在桌面面板重新生成" };
  }
  const expected = Buffer.from(String(stored.code).toUpperCase());
  const actual = Buffer.from(String(candidate ?? "").trim().toUpperCase());
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "配对码不正确" };
  }
  return { ok: true };
}

/** 每聊天令牌桶：默认 12 条/分钟，突发 4 条。 */
function createRateLimiter(perMinute = RATE_LIMIT_PER_MINUTE) {
  const buckets = new Map();
  const capacity = 4;
  const refillPerMs = perMinute / 60000;

  return {
    check(key, now = Date.now()) {
      const bucket = buckets.get(key) ?? { tokens: capacity, at: now };
      const refilled = Math.min(capacity, bucket.tokens + (now - bucket.at) * refillPerMs);
      if (refilled < 1) {
        buckets.set(key, { tokens: refilled, at: now });
        return false;
      }
      buckets.set(key, { tokens: refilled - 1, at: now });
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}

/** 出站文本脱敏：防止宿主日志/异常里的凭据被推到手机。 */
function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

function truncate(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…（已截断，完整内容共 ${value.length} 字）`;
}

module.exports = {
  PAIRING_CODE_TTL_MS,
  RATE_LIMIT_PER_MINUTE,
  generatePairingCode,
  pairingCodeValid,
  verifyPairingCode,
  createRateLimiter,
  redactSecrets,
  truncate,
};
