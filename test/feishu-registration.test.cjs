"use strict";

/**
 * feishu-registration：device code 扫码建应用的 init→begin→poll 协议。
 * 用注入的假 fetch 验证调用序列、成功解析与各失败态，不触网。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFeishuRegistration } = require("../lib/feishu-registration.cjs");

function harness(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = new URLSearchParams(options.body);
    const action = body.get("action");
    calls.push({ url, action, deviceCode: body.get("device_code") });
    const payload = handler(action, body);
    if (payload instanceof Error) throw payload;
    return {
      status: 200,
      json: async () => payload,
    };
  };
  return { registration: createFeishuRegistration({ fetchImpl, now: () => 1000 }), calls };
}

test("begin 走 init→begin 并返回扫码信息", async () => {
  const h = harness((action) => {
    if (action === "init") return { supported_auth_methods: ["client_secret"] };
    return {
      device_code: "dc-1",
      verification_uri_complete: "https://accounts.feishu.cn/oauth/authorize?foo=1",
      user_code: "ABCD",
      interval: 3,
      expire_in: 600,
    };
  });
  const session = await h.registration.begin();
  assert.deepEqual(
    h.calls.map((call) => call.action),
    ["init", "begin"],
  );
  assert.equal(session.deviceCode, "dc-1");
  assert.equal(session.userCode, "ABCD");
  assert.equal(session.interval, 3);
  assert.equal(session.expiresAt, 1000 + 600 * 1000);
  // 二维码链接带来源参数，便于平台侧排查
  assert.match(session.qrUrl, /from=sdk/);
  assert.match(session.qrUrl, /tp=sdk/);
  assert.ok(session.qrUrl.startsWith("https://accounts.feishu.cn/"));
});

test("init 不支持 client_secret 时拒绝，不发 begin", async () => {
  const h = harness(() => ({ supported_auth_methods: ["other"] }));
  await assert.rejects(() => h.registration.begin(), /不支持 client_secret/);
  assert.deepEqual(
    h.calls.map((call) => call.action),
    ["init"],
  );
});

test("begin 缺 device_code 时报错", async () => {
  const h = harness((action) =>
    action === "init" ? { supported_auth_methods: ["client_secret"] } : {},
  );
  await assert.rejects(() => h.registration.begin(), /device code/);
});

test("poll 成功返回 AppID/AppSecret 与应用名", async () => {
  const h = harness((action) => {
    if (action === "init") return { supported_auth_methods: ["client_secret"] };
    if (action === "begin") {
      return { device_code: "dc-1", verification_uri_complete: "https://accounts.feishu.cn/x", expire_in: 600 };
    }
    return { client_id: "cli_abc", client_secret: "sec_1", app_name: "遥控台" };
  });
  await h.registration.begin();
  const result = await h.registration.poll({ deviceCode: "dc-1" });
  assert.deepEqual(result, {
    status: "success",
    appId: "cli_abc",
    appSecret: "sec_1",
    appName: "遥控台",
    openId: undefined,
  });
  assert.equal(h.calls.at(-1).deviceCode, "dc-1");
});

test("poll 的 pending / slow_down / 拒绝 / 过期语义", async () => {
  const cases = [
    [{ error: "authorization_pending" }, "pending"],
    [{}, "pending"],
    [{ error: "slow_down" }, "pending"],
    [{ error: "access_denied" }, "access_denied"],
    [{ error: "expired_token" }, "expired"],
    [{ error: "weird", error_description: "boom" }, "error"],
  ];
  for (const [payload, expected] of cases) {
    const h = harness((action) =>
      action === "init" ? { supported_auth_methods: ["client_secret"] } : action === "begin"
        ? { device_code: "dc", verification_uri_complete: "https://accounts.feishu.cn/x" }
        : payload,
    );
    await h.registration.begin();
    const result = await h.registration.poll({ deviceCode: "dc" });
    assert.equal(result.status, expected, JSON.stringify(payload));
  }
});

test("注册错误保留 HTTP、响应格式、平台原因与网络原因", async () => {
  for (const [fetchImpl, expected] of [
    [async () => ({ status: 503, json: async () => ({ error_description: "service unavailable" }) }), /HTTP 503.*service unavailable/],
    [async () => ({ status: 200, json: async () => { throw new Error("bad json"); } }), /响应不是 JSON/],
    [async () => ({ status: 200, json: async () => ({ error: "access_denied", error_description: "not eligible" }) }), /not eligible/],
    [async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }); }, /init.*ECONNRESET/],
  ]) {
    await assert.rejects(createFeishuRegistration({ fetchImpl }).begin(), expected);
  }
});

test("slow_down 延长到十秒轮询", async () => {
  const h = harness(() => ({ error: "slow_down" }));
  assert.equal((await h.registration.poll({ deviceCode: "dc" })).interval, 10);
});

test("HTTP 400 的 OAuth 轮询状态正常解析，等待后仍可继续到成功", async () => {
  const responses = [
    [400, { error: "authorization_pending" }],
    [400, { error: "slow_down" }],
    [200, { client_id: "cli_test", client_secret: "test-secret" }],
    [400, { error: "access_denied" }],
    [400, { error: "expired_token" }],
  ];
  const registration = createFeishuRegistration({ fetchImpl: async () => {
    const [status, payload] = responses.shift();
    return { status, json: async () => payload };
  } });
  assert.deepEqual(await registration.poll({ deviceCode: "dc" }), { status: "pending", interval: 5 });
  assert.deepEqual(await registration.poll({ deviceCode: "dc" }), { status: "pending", interval: 10 });
  assert.equal((await registration.poll({ deviceCode: "dc" })).status, "success");
  assert.equal((await registration.poll({ deviceCode: "dc" })).status, "access_denied");
  assert.equal((await registration.poll({ deviceCode: "dc" })).status, "expired");
});

test("未知 HTTP 400、服务端失败和 init 错误不能伪装成等待", async () => {
  for (const [status, error] of [[400, "invalid_request"], [503, "authorization_pending"]]) {
    const registration = createFeishuRegistration({ fetchImpl: async () => ({ status, json: async () => ({ error }) }) });
    await assert.rejects(registration.poll({ deviceCode: "dc" }), new RegExp(`HTTP ${status}.*${error}`));
  }
  const registration = createFeishuRegistration({ fetchImpl: async () => ({ status: 400, json: async () => ({ error: "authorization_pending" }) }) });
  await assert.rejects(registration.begin(), /init.*HTTP 400/);
});
