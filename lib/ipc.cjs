"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { IPC_EVENTS } = require("./constants.cjs");

/**
 * Agent 进程扩展 → 插件主进程的单向事件通道。
 * 插件主进程在 127.0.0.1 上开临时端口并把端口号写入数据目录，
 * 扩展进程读取该文件后 POST 事件（与微信 BOT 插件同一模式，已验证可用）。
 */

function startIpcServer({ dataDir, onEvent, onError }) {
  const ipcFile = path.join(dataDir, "ipc.json");
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on("end", async () => {
      try {
        const event = body ? JSON.parse(body) : {};
        const result = await onEvent(event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      try {
        fs.writeFileSync(
          ipcFile,
          `${JSON.stringify({ port, pid: process.pid }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (error) {
        onError?.("ipc file write failed", error);
      }
      resolve({
        port,
        stop: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
            try {
              fs.unlinkSync(ipcFile);
            } catch {
              /* 文件已不存在 */
            }
          }),
      });
    });
  });
}

/** 扩展进程侧：读取端口并投递事件。 */
function createIpcClient({ primaryFile, fallbackFile }) {
  let cachedPort = 0;

  function resolvePort() {
    if (cachedPort > 0) return cachedPort;
    for (const file of [primaryFile, fallbackFile]) {
      try {
        if (!file || !fs.existsSync(file)) continue;
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const port = Number(data.port) || 0;
        if (port > 0) {
          cachedPort = port;
          return port;
        }
      } catch {
        /* 尝试下一个候选路径 */
      }
    }
    return 0;
  }

  return {
    send(payload) {
      const port = resolvePort();
      if (!port) return;
      const data = JSON.stringify(payload);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          timeout: 3000,
        },
        (res) => res.resume(),
      );
      req.on("error", () => {});
      req.end(data);
    },
    reset() {
      cachedPort = 0;
    },
  };
}

const KNOWN_EVENTS = new Set(Object.values(IPC_EVENTS));

module.exports = { startIpcServer, createIpcClient, KNOWN_EVENTS };
