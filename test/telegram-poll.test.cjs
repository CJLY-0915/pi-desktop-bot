"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTelegramChannel } = require("../lib/telegram.cjs");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const ok = result => ({ status: 200, data: { ok: true, result } });
const message = id => ({ update_id: id, message: { message_id: id, text: `msg-${id}`, chat: { id: 42, type: "private" }, from: { id: 42 } } });
function abortWait(signal) {
  return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
}

test("Telegram 每条处理成功后提交游标，批次中途失败从失败消息重试", { timeout: 3000 }, async t => {
  const done = deferred();
  const saved = [];
  const handled = [];
  let polls = 0;
  let failed = false;
  const channel = createTelegramChannel({
    botToken: "test", loadOffset: async () => 10,
    saveOffset: async value => { saved.push(value); if (value === 12) done.resolve(); },
    sleep: async () => {},
    onMessage: async msg => {
      handled.push(msg.messageId);
      if (msg.messageId === "11" && !failed) { failed = true; throw new Error("business failure"); }
    },
    requestJson: async options => {
      if (options.url.endsWith("getMe")) return ok({ username: "test" });
      polls += 1;
      if (polls === 1) return ok([message(10), message(11)]);
      if (polls === 2) {
        assert.equal(options.body.offset, 11);
        assert.deepEqual(saved, [11]);
        return ok([message(11)]);
      }
      return abortWait(options.signal);
    },
  });
  t.after(() => channel.stop());
  await channel.start();
  await done.promise;
  assert.deepEqual(saved, [11, 12]);
  assert.deepEqual(handled, ["10", "11", "11"]);
});

test("Telegram 文件通过官方 file/bot URL 下载，并保留文件类型和名称", { timeout: 3000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-file-"));
  const done = deferred();
  let polls = 0;
  let downloadUrl;
  const channel = createTelegramChannel({
    botToken: "test", dataDir: dir,
    onMessage: async msg => { done.resolve(msg); },
    request: async options => { downloadUrl = options.url; return { status: 200, buffer: Buffer.from("document bytes") }; },
    requestJson: async options => {
      if (options.url.endsWith("getMe")) return ok({});
      if (options.url.endsWith("getFile")) return ok({ file_path: "documents/file_1.pdf" });
      if (polls++ === 0) return ok([{ update_id: 10, message: { message_id: 10, chat: { id: 42, type: "private" }, from: { id: 42 }, document: { file_id: "file_1", file_name: "report.pdf", mime_type: "application/pdf" } } }]);
      return abortWait(options.signal);
    },
  });
  t.after(async () => { await channel.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await channel.start();
  const inbound = await done.promise;
  assert.equal(downloadUrl, "https://api.telegram.org/file/bottest/documents/file_1.pdf");
  assert.equal(inbound.attachments[0].kind, "file");
  assert.equal(inbound.attachments[0].filename, "report.pdf");
  assert.equal(inbound.attachments[0].mimeType, "application/pdf");
  assert.equal(inbound.attachments[0].sizeBytes, 14);
  assert.deepEqual(inbound.images, [inbound.attachments[0].path]);
  assert.match(inbound.attachments[0].path, /\.pdf$/u);
  assert.equal(fs.readFileSync(inbound.attachments[0].path, "utf8"), "document bytes");
});

test("Telegram 旧按钮携带原 choiceId，裸序号和跨聊天按钮不能回灌新请求", { timeout: 3000 }, async t => {
  const done = deferred();
  const buttons = [];
  const selected = [];
  let ordinary = 0;
  let polls = 0;
  const channel = createTelegramChannel({
    botToken: "test", onMessage: async () => { ordinary += 1; },
    onChoice: async choice => { selected.push(choice); },
    saveOffset: async value => { if (value === 4) done.resolve(); },
    requestJson: async options => {
      if (options.url.endsWith("sendMessage")) { if (options.body.reply_markup) buttons.push(options.body.reply_markup.inline_keyboard[0][0].callback_data); return ok({}); }
      if (options.url.endsWith("getMe") || options.url.endsWith("answerCallbackQuery")) return ok({});
      if (polls++ === 0) return ok([
        { update_id: 1, callback_query: { id: "cb1", data: buttons[0], from: { id: 42 }, message: { chat: { id: 42, type: "private" } } } },
        { update_id: 2, callback_query: { id: "cb2", data: "1", from: { id: 42 }, message: { chat: { id: 42, type: "private" } } } },
        { update_id: 3, callback_query: { id: "cb3", data: buttons[1], from: { id: 99 }, message: { chat: { id: 99, type: "private" } } } },
      ]);
      return abortWait(options.signal);
    },
  });
  t.after(() => channel.stop());
  await channel.sendChoice("42", { choiceId: "menu:old", options: ["old"], title: "old" });
  await channel.sendChoice("42", { choiceId: "menu:new", options: ["new"], title: "new" });
  await channel.start();
  await done.promise;
  assert.equal(ordinary, 0);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].choiceId, "menu:old");
  assert.equal(selected[0].selection, "1");
});

test("Telegram 附件下载临时失败不提交游标，重试成功后只投递一次", { timeout: 3000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-retry-"));
  const done = deferred();
  const saved = [];
  let downloads = 0;
  let delivered = 0;
  let polls = 0;
  const update = { update_id: 10, message: { message_id: 10, caption: "不能丢掉文件执行该文本", chat: { id: 42, type: "private" }, from: { id: 42 }, document: { file_id: "file_1", file_name: "report.pdf" } } };
  const channel = createTelegramChannel({
    botToken: "test", dataDir: dir, loadOffset: async () => 10, sleep: async () => {},
    onMessage: async () => { delivered += 1; },
    saveOffset: async value => { saved.push(value); done.resolve(); },
    request: async () => { if (downloads++ === 0) throw new Error("temporary network failure"); return { status: 200, buffer: Buffer.from("bytes") }; },
    requestJson: async options => {
      if (options.url.endsWith("getMe")) return ok({});
      if (options.url.endsWith("getFile")) return ok({ file_path: "documents/file_1.pdf" });
      if (polls++ < 2) { assert.equal(options.body.offset, 10); assert.deepEqual(saved, []); return ok([update]); }
      return abortWait(options.signal);
    },
  });
  t.after(async () => { await channel.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await channel.start();
  await done.promise;
  assert.equal(delivered, 1);
  assert.equal(downloads, 2);
  assert.deepEqual(saved, [11]);
});

test("Telegram 超限附件明确告知并确认该条，不发起无用下载", { timeout: 3000 }, async t => {
  const done = deferred();
  let notice = "";
  let polls = 0;
  const channel = createTelegramChannel({
    botToken: "test", onMessage: async () => assert.fail("超限附件不能派发"),
    saveOffset: async value => { assert.equal(value, 11); done.resolve(); },
    requestJson: async options => {
      if (options.url.endsWith("getMe")) return ok({});
      if (options.url.endsWith("sendMessage")) { notice = options.body.text; return ok({}); }
      assert.ok(!options.url.endsWith("getFile"));
      if (polls++ === 0) return ok([{ update_id: 10, message: { message_id: 10, caption: "不能执行", chat: { id: 42, type: "private" }, from: { id: 42 }, document: { file_id: "large", file_size: 6 * 1024 * 1024 } } }]);
      return abortWait(options.signal);
    },
  });
  t.after(() => channel.stop());
  await channel.start();
  await done.promise;
  assert.match(notice, /附件无法接收.*上限/);
});

test("Telegram 超过4个附件整体拒绝并确认，不截取下载或执行 caption", { timeout: 3000 }, async t => {
  const done = deferred();
  let notice = "";
  let polls = 0;
  const channel = createTelegramChannel({
    botToken: "test", onMessage: async () => assert.fail("条数超限不能派发"),
    saveOffset: async value => { assert.equal(value, 11); done.resolve(); },
    requestJson: async options => {
      if (options.url.endsWith("getMe")) return ok({});
      if (options.url.endsWith("sendMessage")) { notice = options.body.text; return ok({}); }
      assert.ok(!options.url.endsWith("getFile"));
      if (polls++ === 0) return ok([{ update_id: 10, message: {
        message_id: 10, caption: "不能执行", chat: { id: 42, type: "private" }, from: { id: 42 },
        photo: [{ file_id: "photo" }], document: { file_id: "document" },
        video: { file_id: "video" }, audio: { file_id: "audio" }, voice: { file_id: "voice" },
      } }]);
      return abortWait(options.signal);
    },
  });
  t.after(() => channel.stop());
  await channel.start();
  await done.promise;
  assert.match(notice, /附件无法接收.*数量.*4.*上限/);
});

test("Telegram 下载后才发现超限也拒绝整条消息，避免附件丢失后执行文本", { timeout: 3000 }, async t => {
  const done = deferred();
  let polls = 0;
  let notices = 0;
  const channel = createTelegramChannel({
    botToken: "test", onMessage: async () => assert.fail("实际字节超限不能派发 caption"),
    saveOffset: async value => { assert.equal(value, 11); done.resolve(); },
    request: async () => ({ status: 200, buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }),
    requestJson: async options => {
      if (options.url.endsWith("getMe")) return ok({});
      if (options.url.endsWith("sendMessage")) { notices += 1; return ok({}); }
      if (options.url.endsWith("getFile")) return ok({ file_path: "documents/large.bin" });
      if (polls++ === 0) return ok([{ update_id: 10, message: {
        message_id: 10, caption: "不能执行", chat: { id: 42, type: "private" }, from: { id: 42 },
        document: { file_id: "large", file_name: "large.bin" },
      } }]);
      return abortWait(options.signal);
    },
  });
  t.after(() => channel.stop());
  await channel.start();
  await done.promise;
  assert.equal(notices, 1);
});

test("Telegram 图片、音频、语音和视频保留各自名称、MIME和实际大小", { timeout: 3000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-types-"));
  const done = deferred();
  let polls = 0;
  const channel = createTelegramChannel({
    botToken: "test", dataDir: dir, onMessage: async msg => done.resolve(msg),
    request: async () => ({ status: 200, buffer: Buffer.from("bytes") }),
    requestJson: async options => {
      if (options.url.endsWith("getMe")) return ok({});
      if (options.url.endsWith("getFile")) return ok({ file_path: "files/resource" });
      if (polls++ === 0) return ok([{ update_id: 10, message: {
        message_id: 10, chat: { id: 42, type: "private" }, from: { id: 42 },
        photo: [{ file_id: "photo-small" }, { file_id: "photo-large", file_size: 200 }],
        video: { file_id: "video", file_name: "../clip.mp4", mime_type: "video/mp4" },
        audio: { file_id: "audio", file_name: "C:\\private\\song.mp3", mime_type: "audio/mpeg" },
        voice: { file_id: "voice", mime_type: "audio/ogg" },
      } }]);
      return abortWait(options.signal);
    },
  });
  t.after(async () => { await channel.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await channel.start();
  const inbound = await done.promise;
  assert.deepEqual(inbound.attachments.map(({ kind, filename, mimeType, sizeBytes }) => ({ kind, filename, mimeType, sizeBytes })), [
    { kind: "image", filename: "telegram-photo.jpg", mimeType: "image/jpeg", sizeBytes: 5 },
    { kind: "video", filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 5 },
    { kind: "audio", filename: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 5 },
    { kind: "audio", filename: "telegram-voice.ogg", mimeType: "audio/ogg", sizeBytes: 5 },
  ]);
  for (const attachment of inbound.attachments) assert.equal(path.dirname(attachment.path), path.join(dir, "attachments"));
  assert.deepEqual(inbound.images, inbound.attachments.map(attachment => attachment.path));
});

test("Telegram 网络错误不能暴露含 botToken 的 API URL", async () => {
  const channel = createTelegramChannel({
    botToken: "raw-bot-secret",
    requestJson: async options => { throw new Error(`timeout ${options.url} raw-bot-secret`); },
  });
  await assert.rejects(channel.sendText("42", "text"), error => {
    assert.match(error.message, /timeout/);
    assert.doesNotMatch(error.message, /raw-bot-secret|https:\/\//u);
    return true;
  });
});
