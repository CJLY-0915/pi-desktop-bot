/** 回传 Agent 事件，并为手机发起的任务提供阻塞问答及文件发送工具。 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const {
  PLUGIN_ID,
  REMOTE_TAG_PREFIX,
  IPC_EVENTS,
} = require("../lib/constants.cjs");
const { formatToolSummary } = require("../lib/tool-summary.cjs");
const { captureFile, countLineChanges } = require("../lib/file-changes.cjs");

const PRIMARY_IPC_FILE = path.join(process.env.PI_DESKTOP_DATA_DIR || path.join(os.homedir(), ".pi-desktop"), "plugins", "data", PLUGIN_ID, "ipc.json");
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FALLBACK_IPC_FILE = path.join(PLUGIN_DIR, "data", "ipc.json");

/** 按序投递事件，每次读取端口文件以适应插件热更新。 */
function createIpcClient() {
  let pending = Promise.resolve();

  function resolvePort() {
    for (const file of [PRIMARY_IPC_FILE, FALLBACK_IPC_FILE]) {
      try {
        if (!fs.existsSync(file)) continue;
        const port = Number(JSON.parse(fs.readFileSync(file, "utf8")).port) || 0;
        if (port > 0) {
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
      pending = pending.then(() => new Promise((resolve) => {
        const port = resolvePort();
        if (!port) {
          console.warn("[mobile-remote-control] IPC endpoint unavailable", payload.type);
          return resolve();
        }
        const data = JSON.stringify(payload);
        const req = http.request({
          hostname: "127.0.0.1", port, path: "/", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          timeout: payload.type === "send_file" ? 90000 : payload.type === "phone_question" ? 30000 : 3000,
        }, (res) => {
          let body = "";
          res.on("data", chunk => { body += chunk; });
          res.on("end", () => {
            try {
              const response = JSON.parse(body);
              resolve(res.statusCode === 200 && response.ok ? response.result : { error: response.error || "IPC 请求失败" });
            } catch { resolve({ error: "IPC 响应无效" }); }
          });
        });
        req.on("error", error => {
          console.warn("[mobile-remote-control] IPC delivery failed", payload.type, error.code || error.message);
          resolve();
        });
        req.on("timeout", () => req.destroy(new Error("remote-control IPC timeout")));
        req.end(data);
      }));
      return pending;
    },
  };
}

const ipc = createIpcClient();

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

export default function remoteControlAgentExtension(api) {
  let currentTurnRemote = false;
  let sessionId = "";
  let assistantText = "";
  let hasAssistantText = false;
  let lastAssistant = null;
  const toolInputs = new Map();
  const fileSnapshots = new Map();
  let runId = "";

  function forward(payload) {
    return ipc.send({ ...payload, runId });
  }

  function sessionIdFor(ctx, event) {
    return ctx?.sessionManager?.getSessionId?.() || ctx?.sessionId || event?.sessionId || sessionId;
  }
  function forwardText(message, ctx) {
    if (message?.role !== "assistant") return;
    const text = extractText(message.content);
    const firstChunk = assistantText.length === 0;
    const delta = text.startsWith(assistantText) ? text.slice(assistantText.length) : "";
    assistantText = text;
    if (delta) {
      forward({ type: IPC_EVENTS.assistantChunk, sessionId: sessionIdFor(ctx),
        content: `${firstChunk && hasAssistantText ? "\n\n" : ""}${delta}` });
      hasAssistantText = true;
    }
  }

  function toolProgress(event, phase, ctx) {
    const cached = toolInputs.get(event.toolCallId);
    const toolName = event.toolName ?? cached?.toolName;
    forward({ type: IPC_EVENTS.toolProgress, sessionId: sessionIdFor(ctx),
      toolCallId: event.toolCallId, toolName: String(toolName ?? "工具"), phase,
      summary: formatToolSummary({ toolName, args: event.args ?? cached?.args,
        phase, isError: event.isError }, ctx?.cwd) });
  }

  api.on("agent_start", (event, ctx) => {
    runId = randomUUID();
    sessionId = sessionIdFor(ctx, event);
    assistantText = "";
    hasAssistantText = false;
    lastAssistant = null;
    toolInputs.clear();
    fileSnapshots.clear();
    return forward({ type: IPC_EVENTS.agentStart, sessionId });
  });

  api.on("before_agent_start", (event, ctx) => {
    sessionId = sessionIdFor(ctx, event);
    currentTurnRemote = extractText(event?.prompt).startsWith(REMOTE_TAG_PREFIX);
  });

  // 引导远程轮次使用可等待手机回答的工具。
  api.on("tool_call", (event) => {
    if (!currentTurnRemote) return undefined;
    if (event?.toolName !== "asktool") return undefined;
    forward({ type: IPC_EVENTS.askBlocked, sessionId, toolName: event.toolName });
    return {
      block: true,
      reason:
        "当前任务由手机发起。请改用 ask_phone 工具，按 questions 数组传入问题、字符串选项和 multiSelect，等待手机用户回答后继续；不要调用桌面 asktool。",
    };
  });

  api.on("message_start", (event) => {
    if (event?.message?.role === "assistant") assistantText = "";
  });

  api.on("message_update", (event, ctx) => forwardText(event?.message, ctx));

  api.on("message_end", (event, ctx) => {
    if (event?.message?.role !== "assistant") return;
    forwardText(event.message, ctx);
    lastAssistant = event.message;
    assistantText = "";
    return forward({ type: IPC_EVENTS.assistantMessage, sessionId: sessionIdFor(ctx),
      content: extractText(event.message.content), stopReason: event.message.stopReason ?? "" });
  });

  api.on("tool_execution_start", (event, ctx) => {
    toolInputs.set(event.toolCallId, { toolName: event.toolName, args: event.args ?? {} });
    const name = String(event.toolName ?? "").split(".").at(-1).toLowerCase();
    if (["edit", "write"].includes(name)) {
      const snapshot = captureFile(event.args?.path ?? event.args?.file_path, ctx?.cwd);
      if (snapshot && !fileSnapshots.has(snapshot.path)) fileSnapshots.set(snapshot.path, snapshot);
    }
    toolProgress(event, "start", ctx);
  });
  api.on("tool_execution_update", (event, ctx) => toolProgress(event, "update", ctx));
  api.on("tool_execution_end", (event, ctx) => {
    toolProgress(event, "end", ctx);
    const args = event.args ?? toolInputs.get(event.toolCallId)?.args ?? {};
    toolInputs.delete(event.toolCallId);
    const name = String(event.toolName ?? "").split(".").at(-1).toLowerCase();
    const filePath = args.path ?? args.file_path;
    if (!event.isError && ["edit", "write"].includes(name) && typeof filePath === "string" && filePath) {
      const after = captureFile(filePath, ctx?.cwd);
      const counts = countLineChanges(after ? fileSnapshots.get(after.path) : null, after);
      forward({ type: IPC_EVENTS.fileChange, sessionId: sessionIdFor(ctx),
        path: filePath, operation: name === "write" ? "写入" : "修改",
        ...(counts ?? {}) });
    }
  });

  api.on("agent_end", (event, ctx) => {
    const final = event?.messages?.filter(message => message.role === "assistant").at(-1) ?? lastAssistant;
    const error = ["error", "aborted"].includes(final?.stopReason)
      ? final.errorMessage || (final.stopReason === "aborted" ? "任务已中断" : "任务执行失败") : "";
    currentTurnRemote = false;
    return forward({ type: IPC_EVENTS.agentEnd, sessionId: sessionIdFor(ctx),
      finalText: final?.stopReason === "toolUse" ? "" : extractText(final?.content), error });
  });

  if (typeof api.registerTool === "function") {
    api.registerTool({
      name: "send_file_to_phone",
      description:
        "将本机文件（报告、压缩包、导出数据等）发送到发起当前任务的远程聊天（飞书/钉钉）。仅在任务由远程聊天发起时使用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "本地绝对路径或工作区相对路径" },
          displayName: { type: "string", description: "远程聊天中显示的文件名（可选）" },
        },
        required: ["path"],
      },
      execute: async (_toolCallId, args, signal, _onUpdate, ctx) => {
        if (!currentTurnRemote) throw new Error("仅手机发起的任务可以发送文件");
        if (signal?.aborted) throw new Error("任务已中断");
        const fullPath = path.isAbsolute(args?.path ?? "")
          ? args.path : path.resolve(ctx?.cwd || process.cwd(), String(args?.path ?? ""));
        const result = await forward({ type: IPC_EVENTS.sendFile, sessionId: sessionIdFor(ctx),
          filePath: fullPath, displayName: args?.displayName ?? "" });
        if (!result?.success) throw new Error(result?.error || "文件发送未得到确认，请检查手机端，避免重复发送");
        return { content: [{ type: "text", text: `文件已发送：${result.name || path.basename(fullPath)}` }], details: { success: true } };
      },
    });
    api.registerTool({
      name: "ask_phone",
      description: "向发起当前任务的手机用户提问并等待回答。支持多题、单选、多选和自定义答案。仅远程任务使用，不能用作宿主工具权限批准。",
      parameters: {
        type: "object", additionalProperties: false, required: ["questions"],
        properties: { questions: { type: "array", minItems: 1, maxItems: 10, items: {
          type: "object", additionalProperties: false, required: ["question", "options"],
          properties: { question: { type: "string", maxLength: 300 },
            options: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 300 } },
            multiSelect: { type: "boolean" } },
        } } },
      },
      execute: async (_toolCallId, args, signal, _onUpdate, ctx) => {
        if (!currentTurnRemote) throw new Error("仅手机发起的任务可以使用手机问答");
        if (signal?.aborted) throw new Error("任务已中断");
        const request = await forward({ type: IPC_EVENTS.phoneQuestion, sessionId: sessionIdFor(ctx), questions: args.questions });
        if (!request?.requestId) throw new Error(request?.error || "无法建立手机问答，请重试");
        try {
          const deadline = Date.now() + 10 * 60 * 1000;
          while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error("任务已中断");
            const result = await forward({ type: IPC_EVENTS.phoneQuestionPoll, sessionId: sessionIdFor(ctx), requestId: request.requestId });
            if (result?.state === "answered") return { content: [{ type: "text", text: JSON.stringify(result.answers) }], details: { answers: result.answers } };
            if (result?.state !== "pending") throw new Error(result?.error || "手机问答已取消或失效，请重新提问");
            await new Promise((resolve, reject) => {
              const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
              const timer = setTimeout(finish, 1200);
              const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("任务已中断")); };
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
            });
          }
          throw new Error("手机问答等待超时");
        } finally {
          await forward({ type: IPC_EVENTS.phoneQuestionCancel, sessionId: sessionIdFor(ctx), requestId: request.requestId });
        }
      },
    });
  }
}
