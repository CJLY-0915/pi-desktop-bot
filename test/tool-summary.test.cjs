"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatToolSummary } = require("../lib/tool-summary.cjs");

test("工具名称、阶段和操作目标生成稳定摘要，不包含输出或异常正文", () => {
  assert.equal(formatToolSummary({ toolName: "Bash", args: { command: "npm test", output: "private output" }, phase: "end" }), "完成 · Bash · `npm test`");
  assert.equal(formatToolSummary({ toolName: "Read", args: { file_path: "/repo/src/app.js" }, phase: "start" }, "/repo"), "执行中 · Read · `src/app.js`");
  assert.equal(formatToolSummary({ toolName: "Bash", args: '{"command":"git status"}', phase: "completed" }), "完成 · Bash · `git status`");
  assert.equal(formatToolSummary({ toolName: "Bash", args: "git status", phase: "update" }), "执行中 · Bash · `git status`");
  const failed = formatToolSummary({ toolName: "Read", args: { path: "a.js" }, phase: "end", error: new Error("raw private error"), output: "private output" });
  assert.equal(failed, "失败 · Read · `a.js`");
  assert.equal(formatToolSummary({ toolName: "Read", phase: "end", isError: true }), "失败 · Read");
  assert.equal(formatToolSummary(), "执行中 · 工具");
});

test("项目路径只在目录边界内缩短，兼容 Windows 大小写与外部路径", () => {
  assert.equal(formatToolSummary({ toolName: "Read", args: { path: "C:\\Repo\\src\\main.ts" } }, "c:\\repo\\"), "执行中 · Read · `src/main.ts`");
  assert.equal(formatToolSummary({ toolName: "Read", args: { path: "/repository/a.js" } }, "/repo"), "执行中 · Read · `/repository/a.js`");
  assert.equal(formatToolSummary({ toolName: "Read", args: { filePath: "/other/a.js" } }, "/repo"), "执行中 · Read · `/other/a.js`");
});

test("命令和路径从中间截断，保留命令前缀与目标文件后缀", () => {
  const command = `node scripts/build.js --project ${"nested/".repeat(40)}src/target.test.cjs`;
  const summary = formatToolSummary({ toolName: "Bash", args: { command }, phase: "end" });
  assert.match(summary, /^完成 · Bash · `node scripts\/build.js --project /);
  assert.match(summary, /….*src\/target\.test\.cjs`$/);
  assert.ok(summary.length < 150);
  const path = formatToolSummary({ toolName: "Read", args: { path: `/workspace/${"子目录/".repeat(70)}目标.js` } });
  assert.match(path, /`\/workspace\/.*….*目标\.js`$/);
  assert.ok(path.length < 150);
});

test("凭据先脱敏再截断，覆盖短值、引号、环境变量、CLI、鉴权和 URL", () => {
  const secrets = [
    ['curl --token abcdefgh https://example.test', "abcdefgh"],
    ['TOKEN="abc def ghi" npm test', "abc def ghi"],
    ["curl --password=x https://example.test", "password=x"],
    ["curl -H 'Authorization: Bearer very-private-token' https://example.test", "very-private-token"],
    ["curl https://alice:privatepass@example.test/path", "privatepass"],
    ["API_KEY=short npm test", "short"],
    ["echo ghp_1234567890abcdefgh", "ghp_1234567890abcdefgh"],
  ];
  for (const [command, secret] of secrets) {
    const summary = formatToolSummary({ toolName: "Bash", args: { command } });
    assert.ok(!summary.includes(secret), summary);
    assert.match(summary, /REDACTED/);
  }
  const summary = formatToolSummary({ toolName: "Read", args: { path: `/tmp/token=very-private/${"a".repeat(200)}/file.txt` } });
  assert.ok(!summary.includes("very-private"));
});

test("摘要不允许用户输入关闭代码跨度或插入标签、换行和 Markdown 标题", () => {
  const summary = formatToolSummary({ toolName: "**Bash**<at id=all>", args: { command: "echo `x`\n# heading <at id=all> [link](https://evil.test)" } });
  assert.equal((summary.match(/`/g) ?? []).length, 2);
  assert.ok(!summary.includes("<at"));
  assert.ok(!summary.includes("\n"));
  assert.ok(summary.includes("\\*\\*Bash\\*\\*"));
  assert.ok(summary.includes("｀x｀"));
});

test("command 或 file_path 为空串时仍回退到真实路径，不丢操作目标", () => {
  // 宿主把模型发的 file_path 规整为规范名 path，别名位置可能留下空串。
  assert.equal(formatToolSummary({ toolName: "Edit", args: { command: "", path: "src/a.ts" }, phase: "end" }, "/repo"), "完成 · Edit · `src/a.ts`");
  assert.equal(formatToolSummary({ toolName: "Edit", args: { file_path: "", path: "src/a.ts" }, phase: "end" }, "/repo"), "完成 · Edit · `src/a.ts`");
  assert.equal(formatToolSummary({ toolName: "Read", args: { command: "   ", path: "src/a.ts" }, phase: "end" }, "/repo"), "完成 · Read · `src/a.ts`");
  assert.equal(formatToolSummary({ toolName: "Write", args: { cmd: "", filePath: "", path: "C:/repo/src/b.ts" }, phase: "end" }, "C:/repo"), "完成 · Write · `src/b.ts`");
  // 两者都为空时仍然不显示目标，不伪造内容。
  assert.equal(formatToolSummary({ toolName: "Bash", args: { command: "" }, phase: "end" }), "完成 · Bash");
  assert.equal(formatToolSummary({ toolName: "Read", args: {}, phase: "end" }), "完成 · Read");
});
