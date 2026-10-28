"use strict";

/**
 * 飞书 Card JSON 2.0 流式回传卡片：状态构建、元素预算分段、写失败断路器。
 * 纯逻辑、不依赖宿主与网络，便于单测；Provider 调用由 feishu.cjs 负责。
 *
 * 设计依据（ZCode Bot Channel 实测契约）：
 * - 官方单卡上限 200 组件，超限报 230099/11310；本地按 180 预算分段，状态行常驻预留。
 * - 卡片写失败不阻塞任务生命周期；同一回合连续 3 次失败开路，无定时半开，
 *   迟到事件不能重启写卡；新入站消息开新回合。
 * - 退避事件驱动（1s、2s），不建重试定时器。
 */

const {
  FEISHU_CARD_ELEMENT_BUDGET,
  FEISHU_CARD_CIRCUIT_FAILURES,
  FEISHU_CARD_BACKOFF_MS,
} = require("./constants.cjs");

const STATUS_LABELS = {
  running: "⏳ 运行中",
  completed: "✅ 已完成",
  error: "❌ 已终止",
  sealed: "",
};

function nextCodeFence(fence, line) {
  const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!marker) return fence;
  if (!fence) return marker[1];
  return marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim() ? null : fence;
}

// Card JSON 2.0 会合并单换行；保留正文换行，同时保持代码块和分隔线语义。
function formatCardMarkdown(text) {
  const lines = [];
  let fence = null;
  for (const line of String(text).split("\n")) {
    const previousFence = fence;
    fence = nextCodeFence(fence, line);
    if (!fence && /^-{3,}$/.test(line.trim())) {
      if (lines.length && lines.at(-1).text !== "") lines.push({ text: "", hardBreak: false });
      lines.push({ text: "---", hardBreak: false }, { text: "", hardBreak: false });
      continue;
    }
    lines.push({ text: line, hardBreak: !fence && !previousFence });
  }
  return lines.map((line, index) =>
    line.text && line.hardBreak && lines[index + 1]?.text ? `${line.text}  ` : line.text,
  ).join("\n");
}

/** 状态正文中的独立分隔线使用原生 hr，围栏代码里的分隔线保持原文。 */
function buildStatusElements(text) {
  const elements = [];
  let lines = [];
  let fence = null;
  function flush() {
    const content = lines.join("\n").trim();
    if (content) elements.push({ tag: "markdown", content: formatCardMarkdown(content) });
    lines = [];
  }
  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    fence = nextCodeFence(fence, line);
    if (!fence && /^-{3,}$/.test(line.trim())) {
      flush();
      elements.push({ tag: "hr" });
    } else {
      lines.push(line);
    }
  }
  flush();
  return elements;
}

function countTaggedElements(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countTaggedElements(item), 0);
  }
  if (!value || typeof value !== "object") return 0;
  const record = value;
  return (
    (typeof record.tag === "string" ? 1 : 0) +
    Object.values(record).reduce((total, item) => total + countTaggedElements(item), 0)
  );
}

/** 消息块渲染为 markdown；工具块渲染为可折叠摘要面板。 */
function buildBlockElements(block) {
  if (block.type === "message") {
    const text = String(block.text ?? "").trim();
    if (!text) return [];
    return [{ tag: "markdown", content: formatCardMarkdown(text) }];
  }
  if (block.type === "process") {
    return [{
      tag: "collapsible_panel", expanded: false,
      header: { title: { tag: "plain_text", content: "执行过程" },
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", color: "grey", size: "16px 16px" },
        icon_position: "right", icon_expanded_angle: -180 },
      elements: block.blocks.flatMap(item => item.type === "tools"
        ? [{ tag: "markdown", content: formatCardMarkdown(item.summaries.join("\n")) }]
        : buildBlockElements(item)),
    }];
  }
  const summaries = (block.summaries ?? []).map((item) => String(item).trim()).filter(Boolean);
  if (summaries.length === 0) return [];
  return [
    {
      tag: "collapsible_panel",
      expanded: block.expanded ?? true,
      background_color: "grey-50",
      border: { color: "grey", corner_radius: "8px" },
      padding: "8px 8px 8px 8px",
      header: {
        title: { tag: "plain_text", content: `🛠️ 工具摘要 (${summaries.length})` },
        vertical_align: "center",
        padding: "8px 8px 8px 8px",
        icon: {
          tag: "standard_icon",
          token: "down-small-ccm_outlined",
          color: "grey",
          size: "16px 16px",
        },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      elements: [{ tag: "markdown", content: formatCardMarkdown(summaries.join("\n")) }],
    },
  ];
}

/** 只移除流式正文尾部已确认的最终答复与尾注，保留其余过程。 */
function finalizeCardBlocks(blocks, { finalText = "", footerText = "" }) {
  const history = structuredClone(blocks);
  for (const suffix of [footerText, finalText]) {
    const last = history.at(-1);
    if (!suffix || last?.type !== "message") continue;
    const text = last.text.trimEnd();
    if (text.endsWith(suffix.trimEnd())) {
      last.text = text.slice(0, text.length - suffix.trimEnd().length).trimEnd();
      if (!last.text.trim()) history.pop();
    }
  }
  const result = [];
  // 每组预留面板、标题和状态组件，避免把全部历史套入单个超预算组件。
  const maxProcessBlocks = FEISHU_CARD_ELEMENT_BUDGET - 6;
  for (let index = 0; index < history.length; index += maxProcessBlocks) {
    result.push({ type: "process", blocks: history.slice(index, index + maxProcessBlocks) });
  }
  if (finalText.trim()) result.push({ type: "message", text: finalText });
  if (footerText.trim()) result.push({ type: "message", text: footerText });
  return result;
}

/**
 * blocks → Card JSON 2.0 报文。
 * sealed 状态不追加状态行，使“已封存”与“已结束”在视觉上可区分。
 */
function buildCardPayload(state) {
  const elements = [];
  const blocks = state.blocks ?? [];
  for (const [index, block] of blocks.entries()) {
    const visible = block.type === "tools"
      ? { ...block, expanded: state.status === "running" && index === blocks.length - 1 && block.expanded !== false }
      : block;
    elements.push(...buildBlockElements(visible));
  }
  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: " " });
  }
  if (state.status !== "sealed") {
    const label = STATUS_LABELS[state.status] ?? STATUS_LABELS.running;
    if (label) {
      elements.push({ tag: "markdown", content: `**${label}**` });
    }
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function countStateElements(state) {
  // 状态行常驻预算：分段边界不随 running/completed 切换而漂移。
  return countTaggedElements(buildCardPayload({ ...state, status: "running" }));
}

/**
 * 按元素预算把 blocks 切成多段卡片状态：前序段封存保留，末段继承原状态。
 * 返回段数 ≥1；单块即超预算时也保证该块独占一段（由 Provider 侧兜底截断）。
 */
function splitCardStates(state) {
  const groups = [];
  let current = [];
  for (const block of state.blocks ?? []) {
    const candidate = [...current, block];
    if (current.length > 0 && countStateElements({ ...state, blocks: candidate }) > FEISHU_CARD_ELEMENT_BUDGET) {
      groups.push(current);
      current = [block];
    } else {
      current = candidate;
    }
  }
  groups.push(current);
  return groups.map((blocks, index) => ({
    ...state,
    blocks,
    status: index === groups.length - 1 ? state.status : "sealed",
  }));
}

/** 同一卡片内 blocks 是否仍放得下（含状态行预留）。 */
function fitsInCard(state) {
  return countStateElements(state) <= FEISHU_CARD_ELEMENT_BUDGET;
}

/**
 * 回合级写卡断路器：check→允许后才发请求；成功清零，失败累计退避。
 * 开路后本回合所有写卡被抑制，直到新回合创建新断路器。
 */
function createCardCircuit({ maxFailures = FEISHU_CARD_CIRCUIT_FAILURES, now = Date.now, initialState } = {}) {
  let failures = initialState?.failures ?? 0;
  let nextAttemptAt = initialState?.nextAttemptAt ?? 0;
  let open = Boolean(initialState?.open) || failures >= maxFailures;

  return {
    check(at = now()) {
      if (open) return { allowed: false, reason: "circuit-open" };
      if (at < nextAttemptAt) return { allowed: false, reason: "backoff", retryAt: nextAttemptAt };
      return { allowed: true };
    },
    recordSuccess() {
      failures = 0;
      nextAttemptAt = 0;
      open = false;
    },
    recordFailure(at = now()) {
      failures += 1;
      const delay = FEISHU_CARD_BACKOFF_MS[Math.min(failures - 1, FEISHU_CARD_BACKOFF_MS.length - 1)];
      nextAttemptAt = at + delay;
      if (failures >= maxFailures) {
        open = true;
      }
      return { failures, open, nextAttemptAt };
    },
    get state() {
      return { failures, open, nextAttemptAt };
    },
  };
}

module.exports = {
  formatCardMarkdown,
  buildStatusElements,
  buildCardPayload,
  finalizeCardBlocks,
  countTaggedElements,
  countStateElements,
  splitCardStates,
  fitsInCard,
  createCardCircuit,
};
