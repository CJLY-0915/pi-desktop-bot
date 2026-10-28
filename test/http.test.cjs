"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { request, requestJson, buildMultipart } = require("../lib/http.cjs");

test("requestJson posts JSON and parses the response", async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, contentType: req.headers["content-type"], body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { ok: true } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const result = await requestJson({
    method: "POST",
    url: `http://127.0.0.1:${port}/open-apis/x`,
    body: { app_id: "a", app_secret: "b" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { code: 0, data: { ok: true } });
  assert.equal(received[0].method, "POST");
  assert.equal(received[0].contentType, "application/json");
  assert.deepEqual(JSON.parse(received[0].body), { app_id: "a", app_secret: "b" });

  await new Promise((resolve) => server.close(resolve));
});

test("requestJson rejects an unreachable endpoint instead of hanging", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve)); // 监听后立刻关闭

  await assert.rejects(() => requestJson({ url: `http://127.0.0.1:${port}/x` }), /ECONNREFUSED|connect/);
});

test("buildMultipart encodes text fields and the file bytes with a closing boundary", () => {
  const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
  const multipart = buildMultipart(
    { file_type: "stream", file_name: "probe.bin" },
    { field: "file", filename: "probe.bin", contentType: "application/octet-stream", data: payload },
  );

  const boundary = `--${multipart.contentType.split("boundary=")[1]}`;
  const text = multipart.body.toString("latin1");
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=----pi-remote-[0-9a-f]+-[0-9a-f]+$/);
  assert.ok(text.includes(`${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\nstream\r\n`));
  assert.ok(text.includes(`name="file_name"\r\n\r\nprobe.bin\r\n`));
  assert.ok(text.includes(`name="file"; filename="probe.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  assert.ok(multipart.body.includes(payload), "文件字节必须原样进入报文");
  assert.ok(text.endsWith(`${boundary}--\r\n`));
});


test("JSON 与二进制请求发送确定的字节长度，兼容拒绝分块报文的网关", { timeout: 5000 }, async t => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({ headers: req.headers, body });
      const accepted = req.headers["content-length"] === String(body.length) && !req.headers["transfer-encoding"];
      res.writeHead(accepted ? 200 : 412, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ret: accepted ? 0 : -1 }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/ilink/bot/getupdates`;
  const body = { base_info: { channel_version: "2.0.0" }, get_updates_buf: "游标🙂" };
  const result = await requestJson({ method: "POST", url, body });
  assert.equal(result.status, 200);
  assert.equal(received[0].headers["content-length"], String(Buffer.byteLength(JSON.stringify(body))));
  assert.equal(received[0].headers["transfer-encoding"], undefined);
  assert.deepEqual(JSON.parse(received[0].body.toString("utf8")), body);
  const file = Buffer.from([0, 255, 127, 128, 1]);
  const binary = await request({ method: "POST", url, body: file });
  assert.equal(binary.status, 200);
  assert.deepEqual(received[1].body, file);
  const empty = await request({ method: "POST", url, body: "" });
  assert.equal(empty.status, 200);
  assert.equal(received[2].headers["content-length"], "0");
});
