"use strict";

const { randomUUID } = require("node:crypto");
const { listProjects, isProjectAllowed, pathKey } = require("./project-access.cjs");
const { replyModeFor, TEXT_REPLY_MODES } = require("./reply-mode.cjs");
const { readSessionStatus } = require("./render.cjs");

const ALIASES = {
  "/项目": "/project", "/workspace": "/project", "/模型": "/model",
  "/思考": "/think", "/thoughtlevel": "/think", "/thought_level": "/think", "/thought-level": "/think", "/模式": "/mode", "/权限": "/permission",
  "/回复": "/reply", "/会话": "/task", "/切换": "/use", "/停止": "/cancel", "/stop": "/cancel",
  "/改动": "/diff", "/发送": "/send", "/解绑": "/unbind", "/取消": "/cancel",
};
const canonicalCommand = command => ALIASES[command.toLowerCase()] ?? command.toLowerCase();
const REPLY_LABELS = { standard: "标准回复", full: "完整回复", summary: "摘要回复", streaming_card: "流式卡片" };
const MODES = ["agent", "plan", "goal"];
const PERMISSIONS = ["inherit", "ask", "accept-edits", "auto"];
const PAGE_SIZE = 8;
const THINKING_LABELS = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const thinkingLabel = value => THINKING_LABELS[value] ? `${THINKING_LABELS[value]}（${value}）` : value || "未设置";

function createBotCommands({ store, getSettings, invoke, send, sendChoice, setReplyMode, showStatus, isBusy, hasApproval, onSessionBound, now = Date.now, audit }) {
  const menus = new Map();
  const requests = new Map();
  function clear(channel, chatId) {
    if (channel) { const key = keyFor(channel, chatId); menus.delete(key); requests.delete(key); }
    else { menus.clear(); requests.clear(); }
  }
  const keyFor = (channel, chatId) => `${channel}:${chatId}`;
  const call = (channel, operation, args = [], confirm = false) => invoke(operation, args, { channel, confirm });
  const bindingId = (channel, chatId) => store.getBinding(channel, chatId)?.sessionId;
  const requireAuthorized = (channel, chatId) => {
    if (getSettings().requirePairing !== false && !store.isPaired(channel, chatId)) throw new Error("聊天授权已失效，请重新 /bind");
    if (hasApproval(chatId)) throw new Error("请先处理当前审批");
  };

  async function sessionFor(channel, chatId) {
    const id = bindingId(channel, chatId);
    if (!id) throw new Error("尚未关联会话，请先 /新建 或 /会话 选择会话");
    const result = await call(channel, "session/get", [id]);
    if (!result?.session) throw new Error("宿主未返回会话信息");
    return result.session;
  }

  async function requireIdle(channel, chatId) {
    const id = bindingId(channel, chatId);
    if (!id) return;
    if (isBusy(id)) throw new Error("当前会话仍在执行，请先 /停止 或等待结束");
    const result = await call(channel, "agent/getStatus", [id]);
    const status = readSessionStatus(result);
    if (status.state === "unknown") throw new Error("无法确认会话状态，请稍后重试");
    if (!["idle", "completed", "stopped", "cancelled", "canceled", "interrupted", "error", "failed"].includes(status.state)) {
      throw new Error("当前会话仍在执行，请先 /停止 或等待结束");
    }
  }

  function requireDangerous() {
    if (getSettings().allowDangerousRemote === false) throw new Error("该切换操作未开放，请在桌面「Pi-Desktop 机器人」面板的「机器人设置」中开启「允许远程配置切换」");
  }

  async function providers(channel) {
    const result = await call(channel, "providers/list");
    if (!Array.isArray(result?.providers)) throw new Error("宿主未返回服务商列表");
    return result.providers.filter(provider => provider.enabled !== false);
  }

  async function models(channel, providerId) {
    const provider = (await providers(channel)).find(item => item.id === providerId);
    if (!provider) throw new Error("该服务商已不可用，请重新 /模型");
    if (!Array.isArray(provider.models)) throw new Error("宿主未返回已配置模型");
    return provider.models.map(model => ({ ...model, providerId, label: model.alias || model.name || model.id }));
  }

  async function showMenu(channel, chatId, title, items, apply, anchor = bindingId(channel, chatId) ?? null, page = 0, isCurrent = () => true) {
    if (!isCurrent()) return;
    requireAuthorized(channel, chatId);
    if (!items.length) { await send(chatId, "当前没有可用选项。"); return; }
    if (hasApproval(chatId)) throw new Error("当前正在等待审批，请先处理确认请求");
    const visible = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const entries = visible.map(item => ({ ...item, action: "select" }));
    if (page > 0) entries.push({ label: "上一页", action: "page", page: page - 1 });
    if ((page + 1) * PAGE_SIZE < items.length) entries.push({ label: "下一页", action: "page", page: page + 1 });
    entries.push({ label: "取消", action: "cancel" });
    const id = `menu:${randomUUID()}`;
    const menu = { id, channel, chatId, title, items, entries, apply, anchor, isCurrent, expiresAt: now() + 600000 };
    menus.set(keyFor(channel, chatId), menu);
    const result = await sendChoice(chatId, { choiceId: id, title, prompt: items.length > PAGE_SIZE ? `第 ${page + 1}/${Math.ceil(items.length / PAGE_SIZE)} 页` : "", options: entries.map(item => item.label) });
    if (result?.delivered === false && menus.get(keyFor(channel, chatId)) === menu) menus.delete(keyFor(channel, chatId));
  }

  async function select(channel, chatId, choiceId, selection) {
    if (!String(choiceId).startsWith("menu:")) return false;
    const key = keyFor(channel, chatId);
    const menu = menus.get(key);
    if (!menu || menu.id !== choiceId || !menu.isCurrent() || menu.expiresAt <= now()) {
      if (menu?.expiresAt <= now()) menus.delete(key);
      await send(chatId, "该菜单已过期，请重新发送命令。");
      return true;
    }
    if (getSettings().requirePairing !== false && !store.isPaired(channel, chatId)) {
      menus.delete(key);
      await send(chatId, "聊天授权已失效，请重新 /bind。");
      return true;
    }
    if (hasApproval(chatId)) { await send(chatId, "请先处理当前审批。"); return true; }
    const index = /^\d+$/.test(String(selection)) ? Number(selection) - 1 : -1;
    const entry = menu.entries[index];
    if (!entry) { await send(chatId, "无效序号，请重新选择。"); return true; }
    menus.delete(key);
    try {
      if (entry.action === "cancel") await send(chatId, "已取消选择。");
      else if (entry.action === "page") await showMenu(channel, chatId, menu.title, menu.items, menu.apply, menu.anchor, entry.page, menu.isCurrent);
      else {
        if ((bindingId(channel, chatId) ?? null) !== menu.anchor) throw new Error("关联会话已变化，请重新发送命令");
        await menu.apply(entry.value);
      }
    } catch (error) { await send(chatId, `操作失败：${error.message}`); }
    return true;
  }

  async function consumeText(channel, chatId, text) {
    const key = keyFor(channel, chatId);
    const menu = menus.get(key);
    if (!menu) { clear(channel, chatId); return false; }
    if (["/取消", "/cancel"].includes(text.trim().toLowerCase()) || text.trim() === "0") {
      clear(channel, chatId);
      await send(chatId, "已取消选择。");
      return true;
    }
    if (/^\s*\d+\s*$/.test(text)) return select(channel, chatId, menu.id, text.trim());
    clear(channel, chatId);
    return false;
  }

  async function configure(channel, chatId, session, config, label, requireActive) {
    requireDangerous();
    await requireIdle(channel, chatId);
    if (bindingId(channel, chatId) !== session.id) throw new Error("关联会话已变化，请重新发送命令");
    requireAuthorized(channel, chatId);
    const current = await sessionFor(channel, chatId);
    requireActive();
    requireDangerous();
    const result = await call(channel, "session/configure", [session.id, { mode: current.mode, ...config }], true);
    if (!result?.session) throw new Error("宿主未确认会话配置结果");
    if (showStatus) await showStatus(channel, chatId, result.session, label);
    else await send(chatId, `已切换${label}，下一轮任务生效。`);
    audit({ event: "remote-session-configured", channel, chatId, sessionId: session.id, fields: Object.keys(config) });
  }

  async function handle(channel, chatId, command, argument) {
    if (!["/project", "/model", "/think", "/mode", "/permission", "/reply", "/task", "/use"].includes(command)) return false;
    const key = keyFor(channel, chatId), request = {};
    const initialBinding = bindingId(channel, chatId) ?? null;
    menus.delete(key);
    requests.set(key, request);
    const isCurrent = () => requests.get(key) === request;
    const requireActive = () => {
      requireAuthorized(channel, chatId);
      if (!isCurrent()) throw new Error("操作已失效，请重新发送命令");
      if ((bindingId(channel, chatId) ?? null) !== initialBinding) throw new Error("关联会话已变化，请重新发送命令");
    };
    const show = (channel, chatId, title, items, apply, anchor) => showMenu(channel, chatId, title, items, apply, anchor, 0, isCurrent);
    try {
      requireAuthorized(channel, chatId);
      if (command === "/reply") {
        const current = replyModeFor(getSettings(), channel);
        if (channel === "feishu") { await send(chatId, "当前回复颗粒度：流式卡片\n飞书固定使用 Card JSON 2.0，工具调用仅显示折叠摘要。"); return true; }
        if (!["weixin", "telegram"].includes(channel)) throw new Error("当前渠道不支持回复颗粒度选择");
        const apply = async value => {
          const aliases = { "标准": "standard", "完整": "full", "摘要": "summary", "标准回复": "standard", "完整回复": "full", "摘要回复": "summary" };
          const mode = aliases[value] ?? value;
          if (!TEXT_REPLY_MODES.includes(mode)) throw new Error("用法：/回复 standard|full|summary");
          requireActive();
          await setReplyMode(channel, mode);
          await send(chatId, `回复颗粒度已切换为${REPLY_LABELS[mode]}，下一轮任务生效。`);
        };
        if (argument) await apply(argument.toLowerCase());
        else await show(channel, chatId, `当前回复颗粒度：${REPLY_LABELS[current]}`, TEXT_REPLY_MODES.map(value => ({ value, label: `${REPLY_LABELS[value]}${value === current ? " · 当前" : ""}` })), apply);
      } else if (command === "/task" || command === "/use") {
        const result = await call(channel, "session/list");
        const sessions = Array.isArray(result) ? result : result?.sessions;
        if (!Array.isArray(sessions)) throw new Error("宿主未返回会话列表");
        const apply = async id => {
          await requireIdle(channel, chatId);
          const fresh = await call(channel, "session/list");
          const target = (Array.isArray(fresh) ? fresh : fresh.sessions)?.find(item => item.id === id);
          if (!target) throw new Error("会话已删除或不在可访问范围，请重新 /会话");
          requireActive();
          store.setBinding(channel, chatId, id);
          await send(chatId, `已关联会话：${target.title || id}\n${id}`);
          await onSessionBound?.(id);
        };
        if (argument) {
          const target = sessions.find(item => item.id === argument) ?? sessions[Number(argument) - 1];
          if (!target) throw new Error("未找到该会话，请先 /会话");
          await apply(target.id);
        } else await show(channel, chatId, "选择桌面会话", sessions.map(item => ({ value: item.id, label: `${item.title || item.id}${item.id === bindingId(channel, chatId) ? " · 当前" : ""}` })), apply);
      } else if (command === "/project") {
        const allowed = async () => (await listProjects((op, args) => call(channel, op, args))).filter(item => isProjectAllowed(store.getProjectAccess(channel), item.path));
        const apply = async value => {
          requireDangerous();
          await requireIdle(channel, chatId);
          if (!(await allowed()).some(item => pathKey(item.path) === pathKey(value))) throw new Error("项目已删除或不在允许范围，请重新 /项目");
          requireActive();
          requireDangerous();
          const result = await call(channel, "project/set", [value], true);
          if (!result?.workspace?.path) throw new Error("宿主未确认项目切换结果");
          await send(chatId, `已切换桌面项目：${result.workspace.path}\n已有会话未移动，发送 /新建 可关联该项目的新会话。`);
        };
        if (argument) await apply(argument);
        else {
          const current = await call(channel, "project/get");
          await show(channel, chatId, "选择桌面项目（已有会话不会移动）", (await allowed()).map(item => ({ value: item.path, label: `${item.name}${pathKey(item.path) === pathKey(current?.workspace?.path) ? " · 当前" : ""}` })), apply);
        }
      } else {
        const session = await sessionFor(channel, chatId);
        const applyMode = async value => {
          if (command === "/permission" || (command === "/mode" && PERMISSIONS.includes(value))) {
            if (!PERMISSIONS.includes(value)) throw new Error("不支持的权限模式");
            await configure(channel, chatId, session, { permissionMode: value }, `权限模式：${value}`, requireActive);
          } else {
            if (!MODES.includes(value)) throw new Error("用法：/模式 agent|plan|goal；权限请用 /权限");
            await configure(channel, chatId, session, { mode: value }, `运行模式：${value}`, requireActive);
          }
        };
        if (command === "/mode" || command === "/permission") {
          if (argument) await applyMode(argument.toLowerCase());
          else {
            const values = command === "/mode" ? MODES : PERMISSIONS;
            const current = command === "/mode" ? session.mode : session.permissionMode;
            await show(channel, chatId, `当前${command === "/mode" ? "运行" : "权限"}模式：${current || "继承桌面设置"}`, values.map(value => ({ value, label: `${value}${value === current ? " · 当前" : ""}` })), applyMode, session.id);
          }
        } else if (command === "/model") {
          const apply = async value => {
            const slash = value.indexOf("/");
            if (slash < 1) throw new Error("用法：/模型 <服务商ID/模型ID>，或直接 /模型 选择");
            const providerId = value.slice(0, slash), modelId = value.slice(slash + 1);
            const model = (await models(channel, providerId)).find(item => item.id === modelId);
            if (!model) throw new Error("模型已不可用，请重新 /模型");
            const levels = model.thinkingLevels ?? [];
            const thinkingLevel = levels.includes(model.defaultThinkingLevel) ? model.defaultThinkingLevel : levels[0] ?? "off";
            const current = await sessionFor(channel, chatId);
            await configure(channel, chatId, session, { providerId, modelId, ...(levels.includes(current.thinkingLevel) ? {} : { thinkingLevel }) }, `模型：${model.label}`, requireActive);
          };
          if (argument) await apply(argument);
          else {
            const available = await providers(channel);
            const currentProvider = available.find(provider => provider.id === session.providerId);
            const currentModel = currentProvider?.models?.find(model => model.id === session.modelId);
            const label = currentModel?.alias || currentModel?.name || session.modelId || "继承桌面设置";
            await show(channel, chatId, `选择服务商\n当前模型：${currentProvider?.name ? `${currentProvider.name} / ` : ""}${label}`, available.filter(provider => provider.models?.length).map(provider => ({ value: provider.id, label: provider.name || provider.id })), async providerId => {
              const provider = available.find(item => item.id === providerId);
              await show(channel, chatId, `${provider.name || providerId} · 选择模型`, (await models(channel, providerId)).map(model => ({ value: `${providerId}/${model.id}`, label: `${model.label}${providerId === session.providerId && model.id === session.modelId ? " · 当前" : ""}` })), apply, session.id);
            }, session.id);
          }
        } else {
          const levels = session.supportedThinkingLevels;
          if (!Array.isArray(levels) || !levels.length) throw new Error("当前模型未声明可用思考档位，请在桌面配置后重试");
          const apply = async value => {
            const current = await sessionFor(channel, chatId);
            if (!current.supportedThinkingLevels?.includes(value)) throw new Error("当前模型不支持该思考档位");
            if (current.providerId !== session.providerId || current.modelId !== session.modelId) throw new Error("模型已变化，请重新 /思考");
            await configure(channel, chatId, session, { thinkingLevel: value }, `思考等级：${thinkingLabel(value)}`, requireActive);
          };
          if (argument) await apply(argument.toLowerCase());
          else await show(channel, chatId, `选择思考等级\n当前：${thinkingLabel(session.thinkingLevel)}`, levels.map(value => ({ value, label: `${thinkingLabel(value)}${value === session.thinkingLevel ? " · 当前" : ""}` })), apply, session.id);
        }
      }
    } catch (error) { await send(chatId, `${command} 操作失败：${error.message}`); }
    return true;
  }

  return { handle, select, consumeText, clear };
}

module.exports = { createBotCommands, canonicalCommand };
