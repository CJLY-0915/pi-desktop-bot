"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generatePairingCode,
  pairingCodeValid,
  verifyPairingCode,
  createRateLimiter,
  redactSecrets,
  truncate,
} = require("../lib/security.cjs");

test("generatePairingCode produces a 6-char code from the safe alphabet", () => {
  for (let i = 0; i < 50; i += 1) {
    const { code } = generatePairingCode();
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  }
});

test("verifyPairingCode accepts the right code and rejects a wrong one", () => {
  const generated = generatePairingCode();
  assert.equal(verifyPairingCode(generated, generated.code).ok, true);
  assert.equal(verifyPairingCode(generated, "WRONG1").ok, false);
  assert.equal(verifyPairingCode(generated, generated.code.toLowerCase()).ok, true, "大小写不敏感");
});

test("verifyPairingCode rejects missing and expired codes", () => {
  assert.equal(verifyPairingCode(null, "ABC123").ok, false);
  const expired = { code: "ABC234", at: Date.now() - 11 * 60 * 1000 };
  assert.equal(verifyPairingCode(expired, "ABC234").ok, false);
  assert.equal(pairingCodeValid({ code: "ABC234", at: Date.now() }), true);
});

test("rate limiter allows a burst then throttles", () => {
  const limiter = createRateLimiter(12);
  const now = 1_000_000;
  for (let i = 0; i < 4; i += 1) {
    assert.equal(limiter.check("chat", now), true, `burst ${i} should pass`);
  }
  assert.equal(limiter.check("chat", now), false, "burst exhausted");
  assert.equal(limiter.check("chat", now + 60_000), true, "refills after a minute");
  assert.equal(limiter.check("other", now), true, "buckets are per key");
});

test("redactSecrets masks credentials and JWTs", () => {
  assert.match(redactSecrets("api_key: sk-1234567890abcdef"), /REDACTED/);
  assert.match(redactSecrets('{"password": "hunter2secret"}'), /REDACTED/);
  assert.match(
    redactSecrets("token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcabcabcabc"),
    /REDACTED/,
  );
  assert.equal(redactSecrets("普通文本没有秘密"), "普通文本没有秘密");
  assert.equal(redactSecrets(undefined), undefined);
});

test("truncate appends a marker when over the limit", () => {
  const out = truncate("a".repeat(50), 10);
  assert.match(out, /^a{10}/);
  assert.match(out, /已截断/);
  assert.equal(truncate("short", 10), "short");
});
