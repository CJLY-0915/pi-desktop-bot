"use strict";

const { randomBytes } = require("node:crypto");

const HELP = "用法：列表；每隔 <分钟> <任务>；每天 HH:mm <任务>；删除/暂停/恢复 <id>";
const MAX_PER_CHAT = 20;
const MAX_PROMPT_LENGTH = 12000;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 10080;

function nextDaily(time, after) {
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(after);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
  if (next.getTime() <= after) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, hour, minute).getTime();
  }
  return next.getTime();
}

function nextRun(task, after) {
  if (task.cadence === "daily") return nextDaily(task.time, after);
  const period = task.intervalMinutes * 60000;
  return task.nextRunAt + (Math.floor((after - task.nextRunAt) / period) + 1) * period;
}

function createRemoteSchedule({ load, save, dispatch, now = Date.now, onError } = {}) {
  if (typeof load !== "function" || typeof save !== "function" || typeof dispatch !== "function" || typeof now !== "function") {
    throw new TypeError("load, save, dispatch and now must be functions");
  }

  let tasks;
  let queue = Promise.resolve();
  let ticking;

  function report(error, task) {
    if (typeof onError === "function") {
      try { onError(error, task); } catch { /* The original failure remains authoritative. */ }
    }
  }

  function exclusive(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function ensureLoaded() {
    if (tasks) return;
    const loaded = await load();
    if (!Array.isArray(loaded)) throw new TypeError("load() must return an array of tasks");
    const current = now();
    const adjusted = loaded.map(task => ({ ...task }));
    let changed = false;
    for (const task of adjusted) {
      if (task.enabled && task.nextRunAt < current) {
        task.nextRunAt = nextRun(task, current);
        changed = true;
      }
    }
    if (changed) await save(adjusted);
    tasks = adjusted;
  }

  async function persist(updated) {
    await save(updated);
    tasks = updated;
  }

  async function command({ channel, chatId, userId, sessionId, authorization, boundAt, text } = {}) {
    if (!channel || !chatId || !userId) throw new TypeError("channel, chatId and userId are required");
    return exclusive(async () => {
      await ensureLoaded();
      const argument = typeof text === "string" ? text.trim() : "";
      if (!argument) return HELP;
      const owned = task => task.channel === channel && task.chatId === chatId && task.userId === userId;
      const visible = tasks.filter(owned);
      if (argument === "列表") {
        if (!visible.length) return "暂无定时任务。";
        return visible.map(task => {
          const cadence = task.cadence === "daily" ? `每天 ${task.time}` : `每隔 ${task.intervalMinutes} 分钟`;
          const prompt = task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}...` : task.prompt;
          return `${task.id} ${task.enabled ? "运行" : "暂停"} ${cadence} ${prompt}${task.lastError ? "（上次执行失败）" : ""}`;
        }).join("\n");
      }

      const action = /^(删除|暂停|恢复)\s+(\S+)$/.exec(argument);
      if (action) {
        const target = visible.find(task => task.id === action[2]);
        if (!target) return "未找到该定时任务。";
        if (action[1] === "删除") {
          await persist(tasks.filter(task => task !== target));
        } else {
          const updated = tasks.map(task => task === target ? {
            ...task,
            enabled: action[1] === "恢复",
            ...(action[1] === "恢复" ? { nextRunAt: task.cadence === "daily"
              ? nextDaily(task.time, now()) : now() + task.intervalMinutes * 60000 } : {}),
          } : task);
          await persist(updated);
        }
        return `已${action[1]}定时任务 ${target.id}。`;
      }

      const interval = /^每隔\s+(\S+)\s+([\s\S]+)$/.exec(argument);
      const daily = /^每天\s+(\S+)\s+([\s\S]+)$/.exec(argument);
      if (!interval && !daily) return HELP;
      const prompt = (interval || daily)[2].trim();
      if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return `任务内容需为 1-${MAX_PROMPT_LENGTH} 字。`;
      if (!sessionId) return "请先关联会话。";
      if (tasks.filter(task => task.channel === channel && task.chatId === chatId).length >= MAX_PER_CHAT) {
        return `每个聊天最多 ${MAX_PER_CHAT} 个定时任务。`;
      }
      let schedule;
      if (interval) {
        const minutes = interval[1];
        if (!/^\d+$/.test(minutes) || Number(minutes) < MIN_INTERVAL || Number(minutes) > MAX_INTERVAL) {
          return `间隔须为 ${MIN_INTERVAL}-${MAX_INTERVAL} 的整数分钟。`;
        }
        schedule = { cadence: "interval", intervalMinutes: Number(minutes), nextRunAt: now() + Number(minutes) * 60000 };
      } else {
        const time = daily[1];
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return "时间格式须为 HH:mm（00:00-23:59）。";
        schedule = { cadence: "daily", time, nextRunAt: nextDaily(time, now()) };
      }
      let id;
      do { id = randomBytes(6).toString("base64url"); } while (tasks.some(task => task.id === id));
      await persist([...tasks, { id, channel, chatId, userId, sessionId, authorization, boundAt, prompt,
        ...schedule, enabled: true }]);
      return `已创建定时任务 ${id}。`;
    });
  }

  function tick() {
    if (ticking) return ticking;
    const run = (async () => {
      while (true) {
        const due = await exclusive(async () => {
          await ensureLoaded();
          const current = now();
          const task = tasks.find(item => item.enabled && item.nextRunAt <= current);
          if (!task) return null;
          const advanced = { ...task, nextRunAt: nextRun(task, current), lastError: null };
          await persist(tasks.map(item => item === task ? advanced : item));
          return { ...task };
        }).catch(error => {
          report(error);
          throw error;
        });
        if (!due) return;
        try {
          await dispatch(due);
        } catch (error) {
          report(error, due);
          try {
            await exclusive(async () => {
              const current = tasks.find(task => task.id === due.id);
              if (current) await persist(tasks.map(task => task === current ? { ...task, lastError: String(error?.message ?? error) } : task));
            });
          } catch (saveError) {
            report(saveError, due);
            throw saveError;
          }
        }
      }
    })();
    ticking = run;
    void run.finally(() => { if (ticking === run) ticking = undefined; }).catch(() => {});
    return run;
  }

  return { command, tick };
}

module.exports = { createRemoteSchedule };
