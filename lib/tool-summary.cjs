"use strict";

const { redactSecrets } = require("./security.cjs");

const DETAIL_LIMIT = 120;

function redactDetail(value) {
  return redactSecrets(String(value)
    .replace(/\b(?:https?|ssh|ftp):\/\/[^\s/@]+:[^\s/@]+@/gi, match => `${match.split("://")[0]}://[REDACTED]@`)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, "[REDACTED]")
    .replace(/(?:--?)?\b(?:[\w-]*(?:token|secret|password|passwd)|api[_-]?key|pwd|authorization)\b["']?\s*(?:[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "[REDACTED]")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|xox[baprs]-[\w-]{10,})\b/g, "[REDACTED]"));
}

function compact(value, limit) {
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  const head = Math.ceil((limit - 1) * 0.6);
  return `${chars.slice(0, head).join("")}…${chars.slice(-(limit - head - 1)).join("")}`;
}

/** 取第一个非空字符串；空串按缺失处理。 */
function firstText(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return undefined;
}
function singleLine(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function relativePath(value, projectPath) {
  const normalized = value.replace(/\\/g, "/");
  const root = String(projectPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = /^[a-z]:\//i.test(normalized) || normalized.startsWith("//");
  const candidate = windows ? normalized.toLowerCase() : normalized;
  const prefix = windows ? root.toLowerCase() : root;
  if (root && candidate.startsWith(`${prefix}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** 仅摘要工具名称和操作目标；不读取结果正文或转发异常详情。 */
function formatToolSummary({ toolName, args, phase, isError, error } = {}, projectPath) {
  let input = args;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = { command: input }; }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const failed = Boolean(isError || error) || /^(error|failed|aborted|cancelled|canceled)$/i.test(String(phase));
  const completed = /^(end|ended|complete|completed|done|success|finished|tool_execution_end)$/i.test(String(phase));
  const label = failed ? "失败" : completed ? "完成" : "执行中";
  const name = compact(singleLine(redactDetail(toolName ?? "工具")), 40)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+.!|~]/g, "\\$&");
  // command / file_path 的空串会掩盖真实目标（宿主规整参数别名时会出现），按缺失处理。
  let target = firstText(input.command, input.cmd) ?? firstText(input.file_path, input.filePath, input.path);
  if (typeof target === "string") target = relativePath(target, projectPath);
  if (typeof target !== "string" || !target.trim()) return `${label} · ${name || "工具"}`;
  const detail = compact(singleLine(redactDetail(target)), DETAIL_LIMIT)
    .replace(/`/g, "｀").replace(/</g, "＜").replace(/>/g, "＞");
  return `${label} · ${name || "工具"} · \`${detail}\``;
}

module.exports = { formatToolSummary };
