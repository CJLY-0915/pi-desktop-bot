"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");

function harness(handler) {
  const filename = require.resolve("../lib/feishu-api.cjs");
  const localRequire = createRequire(filename);
  const calls = [];
  let now = 1000000;
  const sandbox = {
    module: { exports: {} },
    URLSearchParams,
    Date: { now: () => now },
    require: (name) => name === "./http.cjs" ? {
      requestJson: async (options) => {
        calls.push(options);
        return handler(options, calls.length);
      },
      request: async (options) => {
        calls.push(options);
        return handler(options, calls.length);
      },
    } : localRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  return {
    api: sandbox.module.exports.createFeishuApi({ appId: "test-app", appSecret: "test-secret" }),
    calls,
    advance: (ms) => { now += ms; },
  };
}

const tokenResponse = (expire = 7200) => ({
  status: 200,
  data: { code: 0, tenant_access_token: "test-token", expire },
});

test("首次发送绑定回复使用返回的令牌，后续发送复用缓存", async () => {
  const h = harness((options) => {
    if (options.url.includes("tenant_access_token")) return tokenResponse();
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.body.receive_id, "oc_test");
    return { status: 200, data: { code: 0, data: { message_id: "om_test" } } };
  });
  const result = await h.api.sendMessage("oc_test", "text", JSON.stringify({ text: "绑定成功" }));
  assert.equal(result.message_id, "om_test");
  await h.api.sendMessage("oc_test", "text", JSON.stringify({ text: "帮助" }));
  assert.equal(h.calls.filter((call) => call.url.includes("tenant_access_token")).length, 1);
});

test("并发首次获取共享同一令牌请求并都返回令牌", async () => {
  let finish;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }));
  const first = h.api.getToken();
  const second = h.api.getToken();
  assert.equal(h.calls.length, 1);
  finish(tokenResponse());
  assert.deepEqual(await Promise.all([first, second]), ["test-token", "test-token"]);
});

test("缓存期限从请求开始计算，并提前一分钟刷新", async () => {
  const h = harness(() => {
    h.advance(10000);
    return tokenResponse(120);
  });
  assert.equal(await h.api.getToken(), "test-token");
  h.advance(49999);
  assert.equal(await h.api.getToken(), "test-token");
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.equal(await h.api.getToken(), "test-token");
  assert.equal(h.calls.length, 2);
});

test("缺少有效期的令牌返回给本次调用但不缓存", async () => {
  const h = harness(() => tokenResponse(null));
  assert.equal(await h.api.getToken(), "test-token");
  assert.equal(await h.api.getToken(), "test-token");
  assert.equal(h.calls.length, 2);
});

test("获取失败保留平台错误，并允许下一次调用重试", async () => {
  const h = harness((options, count) => count === 1
    ? { status: 200, data: { code: 10003, msg: "invalid credentials" } }
    : tokenResponse());
  await assert.rejects(h.api.getToken(), /invalid credentials/);
  assert.equal(await h.api.getToken(), "test-token");
  assert.equal(h.calls.length, 2);
});

test("卡片就地更新使用 PATCH，普通消息编辑保留 PUT", async () => {
  const h = harness((options) => options.url.includes("tenant_access_token")
    ? tokenResponse() : { status: 200, data: { code: 0, data: {} } });
  await h.api.updateMessage("om/card", "interactive", '{"schema":"2.0"}');
  assert.equal(h.calls[1].method, "PATCH");
  assert.match(h.calls[1].url, /om%2Fcard$/);
  assert.equal(h.calls[1].headers.Authorization, "Bearer test-token");
  assert.equal(h.calls[1].body.content, '{"schema":"2.0"}');
  await h.api.updateMessage("om_text", "text", '{"text":"updated"}');
  assert.equal(h.calls[2].method, "PUT");
});

test("飞书 downloadAttachment 返回完整元数据，旧下载方法继续返回路径字符串", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-resource-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(options => options.url.includes("tenant_access_token") ? tokenResponse() : {
    status: 200, buffer: Buffer.from("pdf bytes"),
    headers: { "Content-Type": "application/pdf; charset=binary", "content-disposition": "attachment; filename*=UTF-8''..%2F%E6%8A%A5%E5%91%8A.pdf" },
  });
  const attachment = await h.api.downloadAttachment("om/id", "../../key", "file", dir);
  assert.equal(attachment.kind, "file");
  assert.equal(attachment.filename, "报告.pdf");
  assert.equal(attachment.mimeType, "application/pdf");
  assert.equal(attachment.sizeBytes, 9);
  assert.equal(path.dirname(attachment.path), path.join(dir, "attachments"));
  assert.match(attachment.path, /\.pdf$/u);
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "pdf bytes");
  assert.match(h.calls[1].url, /om%2Fid\/resources\/\.\.%2F\.\.%2Fkey\?type=file$/u);
  const legacy = await h.api.downloadMessageResource("om/id", "../../key", "file", dir);
  assert.equal(typeof legacy, "string");
  assert.equal(fs.readFileSync(legacy, "utf8"), "pdf bytes");
});

test("飞书显式文件名和 MIME 优先于响应头，安全处理 Windows 路径和保留媒体类型", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-options-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(options => options.url.includes("tenant_access_token") ? tokenResponse() : {
    status: 200, buffer: Buffer.from("audio"),
    headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="other.bin"' },
  });
  const attachment = await h.api.downloadAttachment("om", "file-key", "audio", dir, {
    filename: "C:\\private\\CON.ogg", mimeType: "audio/ogg", sizeBytes: 999,
  });
  assert.equal(attachment.filename, "_CON.ogg");
  assert.equal(attachment.kind, "audio");
  assert.equal(attachment.mimeType, "audio/ogg");
  assert.equal(attachment.sizeBytes, 5);
  assert.match(h.calls[1].url, /\?type=file$/u);
  const image = await h.api.downloadAttachment("om", "image-key", "image", dir, { filename: "photo", mimeType: "image/png" });
  assert.equal(image.filename, "photo.png");
  assert.match(h.calls[2].url, /\?type=image$/u);
});

test("飞书超过5MB在下载前或落盘前拒绝，不遗留超限文件", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-limit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(options => options.url.includes("tenant_access_token") ? tokenResponse() : {
    status: 200, buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await assert.rejects(h.api.downloadAttachment("om", "key", "file", dir, { sizeBytes: 6 * 1024 * 1024 }), { code: "ATTACHMENT_LIMIT" });
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.api.downloadMessageResource("om", "key", "file", dir), { code: "ATTACHMENT_LIMIT" });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("飞书资源错误隐藏原始凭据和下载地址", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-error-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(options => {
    if (options.url.includes("tenant_access_token")) return tokenResponse();
    throw new Error(`timeout ${options.url} test-token test-secret`);
  });
  await assert.rejects(h.api.downloadAttachment("om", "key", "file", dir), error => {
    assert.match(error.message, /timeout/);
    assert.doesNotMatch(error.message, /test-token|test-secret|https:\/\//u);
    return true;
  });
});
