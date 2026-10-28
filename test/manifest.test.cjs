"use strict";

/**
 * 按宿主 manifest 规范（docs/spec/07-plugins/02-plugin-manifest-schema.md）做的
 * 等价静态校验：字段形状、id 规则、权限与 contributes 的一致性、
 * 入口文件存在性。宿主侧 PluginCheck 需要打开项目工作区，本地开发用此脚本兜底。
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}
function warn(message) {
  warnings.push(message);
}

// 根字段
if (manifest.schemaVersion !== 1) fail("schemaVersion 必须为 1");
if (!/^[a-z0-9]+(\.[a-z0-9_-]+)+$/.test(manifest.id ?? "")) fail(`id 不符合规则: ${manifest.id}`);
if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? "")) fail(`version 不是 semver: ${manifest.version}`);
if (!manifest.name) fail("缺少 name");
if (!manifest.main) fail("缺少 main 入口");

// i18n 契约语言与三字段
for (const locale of ["en", "zh-CN"]) {
  const entry = manifest.i18n?.[locale];
  if (!entry) {
    fail(`i18n 缺少契约语言 ${locale}`);
    continue;
  }
  for (const field of ["name", "description", "safetyNotes"]) {
    if (!entry[field] || !String(entry[field]).trim()) fail(`i18n.${locale}.${field} 为空`);
  }
}

// ui.title 对象双语言
if (manifest.ui?.title && typeof manifest.ui.title === "object") {
  for (const locale of ["en", "zh-CN"]) {
    if (!manifest.ui.title[locale]) fail(`ui.title 缺少 ${locale}`);
  }
}

// 入口文件存在
for (const [label, rel] of [
  ["main", manifest.main],
  ["ui.panel", manifest.ui?.panel],
]) {
  if (rel && !fs.existsSync(path.join(root, rel))) fail(`${label} 入口不存在: ${rel}`);
}

// contributes 引用存在
for (const rel of manifest.contributes?.agentExtensions ?? []) {
  if (!fs.existsSync(path.join(root, rel))) fail(`agentExtensions 文件不存在: ${rel}`);
}

// 权限与 contributes 的一致性
const permissions = new Set(manifest.permissions ?? []);
const KNOWN = new Set([
  "ui.panel", "ui.view", "ui.theme", "ui.microphone", "desktop.control", "agent.tool.register",
  "agent.prompt.inject", "agent.extension", "renderer.extension", "background.service", "bus.publish",
  "bus.subscribe", "net.fetch", "net.websocket", "net.anyHost", "fs.read", "fs.write", "fs.delete",
  "clipboard.read", "clipboard.write", "shell.openExternal", "notify", "models.list", "provider.register",
  "provider.oauth", "mcp.server.local", "mcp.server.remote", "browser.cdp", "keyboard.globalShortcut",
  "audio.playback.background", "audio.capture.background", "composer.suggest", "composer.transform",
]);
for (const permission of permissions) {
  if (!KNOWN.has(permission)) fail(`未知权限: ${permission}`);
}
if (manifest.ui?.panel && !permissions.has("ui.panel")) fail("声明了 ui.panel 入口但缺少 ui.panel 权限");
if ((manifest.contributes?.agentExtensions?.length ?? 0) > 0 && !permissions.has("agent.extension")) {
  fail("声明了 agentExtensions 但缺少 agent.extension 权限");
}
if ((manifest.contributes?.agentTools?.length ?? 0) > 0 && !permissions.has("agent.tool.register")) {
  fail("声明了 agentTools 但缺少 agent.tool.register 权限");
}
if ((manifest.contributes?.services?.length ?? 0) > 0 && !permissions.has("background.service")) {
  fail("声明了 services 但缺少 background.service 权限");
}
for (const permission of ["shell.openExternal", "clipboard.write"]) {
  if (!permissions.has(permission)) fail(`面板操作缺少权限: ${permission}`);
}

// net.domains 与网络权限
const domains = manifest.net?.domains ?? [];
if (permissions.has("net.websocket") && domains.length === 0) {
  warn("声明了 net.websocket 但 net.domains 为空");
}
for (const domain of domains) {
  if (/[^a-z0-9.*\-]/.test(domain)) fail(`net.domains 含非法字符: ${domain}`);
}
if (permissions.has("net.anyHost")) warn("使用了 net.anyHost 广域权限");

// activationEvents
const commandIds = new Set((manifest.contributes?.commands ?? []).map((command) => command.id));
for (const event of manifest.activationEvents ?? []) {
  if (event.startsWith("onCommand:") && !commandIds.has(event.slice("onCommand:".length))) {
    fail(`activationEvents 引用了未声明的命令: ${event}`);
  }
}

// settings 类型
const SETTING_TYPES = new Set(["string", "number", "boolean", "select", "json", "shortcut"]);
for (const setting of manifest.settings ?? []) {
  if (!setting.key) fail("settings 缺少 key");
  if (!SETTING_TYPES.has(setting.type)) fail(`settings.${setting.key} 类型非法: ${setting.type}`);
  if (setting.type === "select" && !Array.isArray(setting.enum)) fail(`settings.${setting.key} select 缺少 enum`);
}

// 四通道枚举与对应域名必须同时声明
const channelSetting = (manifest.settings ?? []).find((setting) => setting.key === "channel");
const channelValues = (channelSetting?.enum ?? []).map((entry) => entry.value);
for (const kind of ["feishu", "dingtalk", "telegram", "weixin"]) {
  if (!channelValues.includes(kind)) fail(`channel 枚举缺少 ${kind}`);
}
for (const domain of ["api.telegram.org", "ilinkai.weixin.qq.com"]) {
  if (!(manifest.net?.domains ?? []).includes(domain)) fail(`net.domains 缺少 ${domain}`);
}

console.log(`manifest: ${manifest.id}@${manifest.version}`);
console.log(`permissions: ${[...permissions].join(", ")}`);
console.log(`net.domains: ${domains.join(", ") || "(none)"}`);
if (warnings.length) {
  console.log("\nwarnings:");
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
if (errors.length) {
  console.log("\nerrors:");
  for (const error of errors) console.log(`  x ${error}`);
  process.exit(1);
}
console.log("\nmanifest OK");
