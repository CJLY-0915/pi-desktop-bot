"use strict";

/**
 * feishu-card：Card JSON 2.0 报文构建、元素预算分段、写失败断路器。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCardPayload,
  finalizeCardBlocks,
  countTaggedElements,
  countStateElements,
  splitCardStates,
  fitsInCard,
  createCardCircuit,
} = require("../lib/feishu-card.cjs");
const { FEISHU_CARD_ELEMENT_BUDGET, FEISHU_CARD_CIRCUIT_FAILURES } = require("../lib/constants.cjs");

function state(blocks, status = "running") {
  return { blocks, status };
}

test("空 blocks 的卡片包含占位与状态行", () => {
  const payload = buildCardPayload(state([]));
  assert.equal(payload.schema, "2.0");
  const elements = payload.body.elements;
  assert.equal(elements.length, 2);
  assert.equal(elements[0].content, " ");
  assert.equal(elements[1].content, "**⏳ 运行中**");
});

test("消息块渲染 markdown，工具块渲染折叠面板并汇总数量", () => {
  const payload = buildCardPayload(
    state([
      { type: "message", text: "第一段" },
      { type: "tools", summaries: ["读取文件", "执行命令"] },
      { type: "message", text: "第二段" },
    ]),
  );
  const elements = payload.body.elements;
  assert.equal(elements[0].tag, "markdown");
  assert.equal(elements[0].content, "第一段");
  assert.equal(elements[1].tag, "collapsible_panel");
  assert.equal(elements[1].header.title.content, "🛠️ 工具摘要 (2)");
  assert.equal(elements[1].expanded, false);
  assert.equal(elements[2].content, "第二段");
  // running 状态追加状态行
  assert.equal(elements.length, 4);
});

test("sealed 状态不追加状态行", () => {
  const payload = buildCardPayload(state([{ type: "message", text: "已封存" }], "sealed"));
  assert.equal(payload.body.elements.length, 1);
});

test("completed / error 状态行使用对应文案", () => {
  assert.equal(buildCardPayload(state([], "completed")).body.elements.at(-1).content, "**✅ 已完成**");
  assert.equal(buildCardPayload(state([], "error")).body.elements.at(-1).content, "**❌ 已终止**");
});

test("超预算 blocks 被切成多段，前序段封存、末段保持状态", () => {
  // 元素预算按“带 tag 的组件”计数：markdown 块与文本长度无关，需要足够多的块才超限。
  const blocks = [];
  for (let index = 0; index < 500; index += 1) {
    blocks.push({ type: "message", text: `段落${index}` });
  }
  const segments = splitCardStates(state(blocks));
  assert.ok(segments.length > 1, "应产生多段卡片");
  for (let index = 0; index < segments.length - 1; index += 1) {
    assert.equal(segments[index].status, "sealed", "前序段必须封存");
    assert.ok(fitsInCard({ ...state(segments[index].blocks) }), "每段都必须放得下一张卡");
  }
  assert.equal(segments.at(-1).status, "running");
  // 分段不丢内容：各段 blocks 数之和等于原 blocks 数
  const total = segments.reduce((sum, segment) => sum + segment.blocks.length, 0);
  assert.equal(total, blocks.length);
});

test("分段边界不随 running/completed 切换而漂移", () => {
  const blocks = [];
  for (let index = 0; index < 40; index += 1) {
    blocks.push({ type: "message", text: "x".repeat(120) });
  }
  const running = splitCardStates(state(blocks, "running"));
  const completed = splitCardStates(state(blocks, "completed"));
  assert.deepEqual(
    running.map((segment) => segment.blocks.length),
    completed.map((segment) => segment.blocks.length),
  );
});

test("countTaggedElements 递归统计带 tag 的节点", () => {
  assert.equal(countTaggedElements({ tag: "markdown", content: "x" }), 1);
  assert.equal(
    countTaggedElements({ schema: "2.0", body: { elements: [{ tag: "markdown" }, { tag: "div" }] } }),
    2,
  );
  assert.equal(countStateElements(state([{ type: "message", text: "hi" }])) <= FEISHU_CARD_ELEMENT_BUDGET, true);
});

test("断路器：连续失败进入退避，达到阈值开路，成功后清零", () => {
  let clock = 0;
  const circuit = createCardCircuit({ now: () => clock });

  assert.deepEqual(circuit.check(), { allowed: true });
  clock = 100;
  const first = circuit.recordFailure();
  assert.equal(first.failures, 1);
  assert.equal(first.open, false);
  assert.equal(first.nextAttemptAt, 1100, "第一次失败退避 1s");

  // 退避窗口内被抑制；恰好到达 nextAttemptAt 即放行（闭边界）
  clock = 1099;
  assert.equal(circuit.check().allowed, false);
  clock = 1100;
  assert.equal(circuit.check().allowed, true);
  clock = 1101;
  assert.equal(circuit.check().allowed, true);

  clock = 2000;
  const second = circuit.recordFailure();
  assert.equal(second.nextAttemptAt, 4000, "第二次失败退避 2s");

  clock = 5000;
  const third = circuit.recordFailure();
  assert.equal(third.open, true, `连续 ${FEISHU_CARD_CIRCUIT_FAILURES} 次失败必须开路`);

  // 开路后即使时间流逝也不放行（无定时半开）
  clock = 999999;
  const gate = circuit.check();
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "circuit-open");

  circuit.recordSuccess();
  assert.equal(circuit.check().allowed, true, "成功后清零恢复");
});

test("卡片保留多行、代码块和 Markdown 分隔线", () => {
  const { formatCardMarkdown } = require("../lib/feishu-card.cjs");
  assert.equal(formatCardMarkdown("状态：idle\n模型：test\n\n下一段"), "状态：idle  \n模型：test\n\n下一段");
  const code = "```js\nconst a = 1;\n---\nconsole.log(a);\n```";
  assert.equal(formatCardMarkdown(code), code);
  assert.equal(formatCardMarkdown("标题\n---\n正文"), "标题\n\n---\n\n正文");
  const card = buildCardPayload(state([{ type: "message", text: "第一行\n第二行" }], "sealed"));
  assert.equal(card.body.elements[0].content, "第一行  \n第二行");
});

test("仅运行中的最新工具块展开，正文、封存及结束使工具块折叠", () => {
  const blocks = [
    { type: "tools", summaries: ["完成 · Read"], expanded: true },
    { type: "message", text: "分析结果" },
    { type: "tools", summaries: ["执行中 · Bash"], expanded: true },
  ];
  const panels = status => buildCardPayload(state(blocks, status)).body.elements.filter(e => e.tag === "collapsible_panel");
  assert.deepEqual(panels("running").map(p => p.expanded), [false, true]);
  for (const status of ["sealed", "completed", "error"]) {
    assert.deepEqual(panels(status).map(p => p.expanded), [false, false]);
  }
  blocks.push({ type: "message", text: "最终正文" });
  assert.deepEqual(panels("running").map(p => p.expanded), [false, false]);
});

test("状态分隔线转原生 hr，保留不同长度与类型的代码围栏", () => {
  const { buildStatusElements } = require("../lib/feishu-card.cjs");
  for (const fence of ["```", "````", "~~~"]) {
    const code = `${fence}text\n------\n\`\`\`nested\n------\n${fence}`;
    const elements = buildStatusElements(`状态\n------\n${code}\n------\n结束`);
    assert.deepEqual(elements.map(e => e.tag), ["markdown", "hr", "markdown", "hr", "markdown"]);
    assert.equal(elements[2].content, code);
  }
});

test("断路器恢复保留退避与开路，不因重新建句柄重置", () => {
  const circuit = createCardCircuit({ now: () => 10 });
  circuit.recordFailure();
  const restored = createCardCircuit({ initialState: circuit.state, now: () => 11 });
  assert.equal(restored.check().reason, "backoff");
  restored.recordFailure();
  restored.recordFailure();
  assert.equal(createCardCircuit({ initialState: restored.state }).check().reason, "circuit-open");
});

test("终态将过程正文与工具整体折叠，最终答复和文件变更在外且不重复", () => {
  const input = [
    { type: "message", text: "先检查文件" },
    { type: "tools", summaries: ["完成 · Read · app.js"] },
    { type: "message", text: "检查完毕\n\n最终答复\n\n文件变更：1 个文件" },
  ];
  const blocks = finalizeCardBlocks(input, { finalText: "最终答复", footerText: "文件变更：1 个文件" });
  const elements = buildCardPayload(state(blocks, "completed")).body.elements;
  assert.deepEqual(elements.map(e => e.tag), ["collapsible_panel", "markdown", "markdown", "markdown"]);
  assert.equal(elements[0].header.title.content, "执行过程");
  assert.equal(elements[0].expanded, false);
  assert.deepEqual(elements[0].elements.map(e => e.tag), ["markdown", "markdown", "markdown"]);
  assert.match(JSON.stringify(elements[0]), /先检查文件.*Read.*检查完毕/);
  assert.doesNotMatch(JSON.stringify(elements[0]), /最终答复|文件变更/);
  assert.equal(elements[1].content, "最终答复");
  assert.equal(elements[2].content, "文件变更：1 个文件");
  assert.match(input[2].text, /最终答复/);
});

test("只有最终答复不显示空过程，缺少最终答复与错误保持可见，长过程遵守组件预算", () => {
  assert.deepEqual(finalizeCardBlocks([{ type: "message", text: "最终答复" }], { finalText: "最终答复" }), [{ type: "message", text: "最终答复" }]);
  const missing = finalizeCardBlocks([{ type: "message", text: "过程\n\n回复同步失败：没有最终答复" }], { footerText: "回复同步失败：没有最终答复" });
  const errorCard = buildCardPayload(state(missing, "error"));
  assert.equal(errorCard.body.elements[1].content, "回复同步失败：没有最终答复");
  const history = Array.from({ length: 500 }, (_, i) => ({ type: "message", text: `过程${i}` }));
  const blocks = finalizeCardBlocks(history, { finalText: "最终结果" });
  const segments = splitCardStates(state(blocks, "completed"));
  for (const segment of segments) assert.ok(fitsInCard(segment));
  assert.equal(blocks.filter(b => b.type === "process").reduce((n, b) => n + b.blocks.length, 0), 500);
  assert.equal(segments.at(-1).blocks.at(-1).text, "最终结果");
});
