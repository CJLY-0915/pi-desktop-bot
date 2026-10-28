"use strict";

/**
 * weixin-registration：iLink 扫码登录的 begin/poll 流程。
 * 用注入的 fetch 假造服务端响应，不触网。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWeixinRegistration } = require("../lib/weixin-registration.cjs");

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

function createRegistration(responses, now = () => 1000) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const key = Object.keys(responses).find((pattern) => url.includes(pattern));
    const handler = responses[key];
    if (!handler) throw new Error(`unexpected url: ${url}`);
    return typeof handler === "function" ? handler(url) : handler;
  };
  const registration = createWeixinRegistration({ fetchImpl, now });
  return { registration, calls };
}

test("begin：返回二维码、间隔与过期时间", async () => {
  const { registration, calls } = createRegistration({
    get_bot_qrcode: jsonResponse({
      ret: 0,
      qrcode: "qr-1",
      qrcode_img_content: "https://example.com/qr.png",
      expires_in: 90,
    }),
  });
  const session = await registration.begin();
  assert.equal(session.qrCode, "qr-1");
  assert.equal(session.qrUrl, "https://example.com/qr.png");
  assert.equal(session.userCode, "qr-1");
  assert.equal(session.interval, 3);
  assert.equal(session.expiresAt, 1000 + 90 * 1000);
  assert.match(calls[0], /get_bot_qrcode\?bot_type=3$/);
});

test("begin：qrcode_url 回退与缺二维码报错", async () => {
  const ok = createRegistration({
    get_bot_qrcode: jsonResponse({ ret: 0, qrcode: "qr-2", qrcode_url: "weixin://login/qr-2" }),
  });
  const session = await ok.registration.begin();
  assert.equal(session.qrUrl, "weixin://login/qr-2");

  const missing = createRegistration({ get_bot_qrcode: jsonResponse({ ret: 0 }) });
  await assert.rejects(missing.registration.begin(), /未返回登录二维码/);
});

test("begin：ret 非零抛错", async () => {
  const { registration } = createRegistration({
    get_bot_qrcode: jsonResponse({ ret: 500, errmsg: "服务繁忙" }),
  });
  await assert.rejects(registration.begin(), /服务繁忙/);
});

test("poll：数字状态 0/1 为等待与已扫描", async () => {
  const { registration } = createRegistration({
    get_qrcode_status: jsonResponse({ ret: 0, status: 0 }),
  });
  assert.deepEqual(await registration.poll({ qrCode: "qr-1" }), { status: "pending", interval: 3 });

  const scanned = createRegistration({
    get_qrcode_status: jsonResponse({ ret: 0, status: 1 }),
  });
  assert.deepEqual(await scanned.registration.poll({ qrCode: "qr-1" }), {
    status: "scanned",
    interval: 3,
  });
});

test("poll：成功返回 botToken 与 botId", async () => {
  const { registration, calls } = createRegistration({
    get_qrcode_status: jsonResponse({ ret: 0, status: 2, bot_token: "tk-9", ilink_bot_id: "bot-9" }),
  });
  const result = await registration.poll({ qrCode: "qr-1" });
  assert.deepEqual(result, { status: "success", botToken: "tk-9", botId: "bot-9" });
  assert.match(calls[0], /get_qrcode_status\?qrcode=qr-1$/);
});

test("poll：字符串状态与过期/错误归一化", async () => {
  const confirmed = createRegistration({
    get_qrcode_status: jsonResponse({ ret: 0, status: "confirmed", bot_token: "tk" }),
  });
  assert.equal((await confirmed.registration.poll({ qrCode: "q" })).status, "success");

  const expired = createRegistration({ get_qrcode_status: jsonResponse({ ret: 0, status: 3 }) });
  const expiredResult = await expired.registration.poll({ qrCode: "q" });
  assert.equal(expiredResult.status, "expired");
  assert.match(expiredResult.message, /过期/);

  const errored = createRegistration({
    get_qrcode_status: jsonResponse({ ret: 0, status: "error", errmsg: "登录失败" }),
  });
  const erroredResult = await errored.registration.poll({ qrCode: "q" });
  assert.equal(erroredResult.status, "error");
  assert.match(erroredResult.message, /登录失败/);
});

test("poll：成功但缺 bot_token 报错", async () => {
  const { registration } = createRegistration({
    get_qrcode_status: jsonResponse({ ret: 0, status: 2 }),
  });
  const result = await registration.poll({ qrCode: "qr-1" });
  assert.equal(result.status, "error");
  assert.match(result.message, /bot_token/);
});

test("poll：请求超时不代表失败，返回 pending 续轮询", async () => {
  const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const { registration } = createRegistration({
    get_qrcode_status: () => {
      throw timeoutError;
    },
  });
  assert.deepEqual(await registration.poll({ qrCode: "qr-1" }), { status: "pending", interval: 3 });
});

test("poll：HTTP 失败抛出", async () => {
  const { registration } = createRegistration({
    get_qrcode_status: jsonResponse({}, false, 502),
  });
  await assert.rejects(registration.poll({ qrCode: "qr-1" }), /HTTP 502/);
});

test("扫码开始和状态查询使用同一组 iLink 应用标识及编码版本头", async () => {
  const headers = [];
  const registration = createWeixinRegistration({
    fetchImpl: async (url, options) => {
      headers.push(options.headers);
      return jsonResponse(url.includes("get_bot_qrcode")
        ? { ret: 0, qrcode: "code", qrcode_img_content: "https://example.com/qr" }
        : { ret: 0, status: "wait" });
    },
  });
  await registration.begin();
  await registration.poll({ qrCode: "code" });
  assert.deepEqual(headers, [
    { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "131072" },
    { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "131072" },
  ]);
});
