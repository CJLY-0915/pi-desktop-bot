"use strict";

const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");

/**
 * 最小 HTTPS JSON / multipart 客户端。
 * 只用平台官方端点；调用方负责超时与错误呈现，不静默吞错。
 */

const DEFAULT_TIMEOUT_MS = 15000;

function request({ method = "GET", url, headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(new Error(`invalid url: ${url}`));
      return;
    }
    const transport = target.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`request timeout after ${timeoutMs}ms: ${url}`)));
    req.on("error", reject);
    req.end(body);
  });
}

async function requestJson(options) {
  const response = await request({
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let parsed = null;
  try {
    parsed = JSON.parse(response.buffer.toString("utf8"));
  } catch {
    parsed = null;
  }
  return { status: response.status, data: parsed, buffer: response.buffer };
}

/** 构造 multipart/form-data 报文体（文本字段 + 单个二进制文件字段）。 */
function buildMultipart(fields, file) {
  const boundary = `----pi-remote-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  if (file) {
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      "utf8",
    );
    parts.push(header, file.data, Buffer.from("\r\n", "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

module.exports = { request, requestJson, buildMultipart, DEFAULT_TIMEOUT_MS };
