"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRemoteSchedule } = require("../lib/remote-schedule.cjs");

function fixture(start = new Date(2025, 0, 1, 10, 0).getTime()) {
  let time = start;
  let stored = [];
  const delivered = [];
  const errors = [];
  const context = { channel: "telegram", chatId: "private-1", userId: "user-1",
    sessionId: "session-1", authorization: { token: "bound" }, boundAt: "2025-01-01T00:00:00Z" };
  const options = {
    load: () => JSON.parse(JSON.stringify(stored)),
    save: tasks => { stored = JSON.parse(JSON.stringify(tasks)); },
    dispatch: task => { delivered.push(task); },
    now: () => time,
    onError: (error, task) => errors.push({ error, task }),
  };
  return { context, options, delivered, errors, get tasks() { return stored; },
    set time(value) { time = value; }, get time() { return time; },
    create: () => createRemoteSchedule(options),
    command: (engine, text, overrides = {}) => engine.command({ ...context, ...overrides, text }),
  };
}

test("interval persists metadata, runs only when due, and advances before dispatch", async () => {
  const f = fixture();
  f.options.dispatch = task => {
    assert.equal(f.tasks[0].nextRunAt, f.time + 5 * 60000);
    f.delivered.push(task);
  };
  const engine = f.create();
  const response = await f.command(engine, "每隔 5 检查状态");
  assert.match(response, /^已创建定时任务 [A-Za-z0-9_-]{8}。$/);
  assert.deepEqual(Object.entries(f.tasks[0]).filter(([key]) => ["channel", "chatId", "userId", "sessionId", "authorization", "boundAt", "prompt", "cadence", "intervalMinutes", "enabled"].includes(key)),
    Object.entries({ ...f.context, prompt: "检查状态", cadence: "interval", intervalMinutes: 5, enabled: true }));
  await engine.tick();
  assert.equal(f.delivered.length, 0);
  f.time += 5 * 60000;
  await engine.tick();
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0].prompt, "检查状态");
  await engine.tick();
  assert.equal(f.delivered.length, 1);
});

test("daily uses local calendar time across midnight and pause/resume skips old occurrences", async () => {
  const f = fixture(new Date(2025, 0, 1, 23, 50).getTime());
  const engine = f.create();
  await f.command(engine, "每天 00:10 日报");
  assert.equal(f.tasks[0].nextRunAt, new Date(2025, 0, 2, 0, 10).getTime());
  f.time = f.tasks[0].nextRunAt;
  await engine.tick();
  assert.equal(f.delivered.length, 1);
  assert.equal(f.tasks[0].nextRunAt, new Date(2025, 0, 3, 0, 10).getTime());
  const id = f.tasks[0].id;
  await f.command(engine, `暂停 ${id}`);
  f.time = new Date(2025, 0, 5, 9, 30).getTime();
  await engine.tick();
  assert.equal(f.delivered.length, 1);
  await f.command(engine, `恢复 ${id}`);
  assert.equal(f.tasks[0].nextRunAt, new Date(2025, 0, 6, 0, 10).getTime());
  await engine.tick();
  assert.equal(f.delivered.length, 1);
});

test("concurrent tick calls share one execution and do not duplicate dispatch", async () => {
  const f = fixture();
  let release;
  f.options.dispatch = task => new Promise(resolve => { f.delivered.push(task); release = resolve; });
  const engine = f.create();
  await f.command(engine, "每隔 5 运行");
  f.time += 5 * 60000;
  const first = engine.tick();
  const second = engine.tick();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delivered.length, 1);
  assert.equal(f.tasks[0].nextRunAt, f.time + 5 * 60000);
  release();
  await Promise.all([first, second]);
  await engine.tick();
  assert.equal(f.delivered.length, 1);
});

test("restart skips missed intervals and does not catch up old executions", async () => {
  const f = fixture();
  const first = f.create();
  await f.command(first, "每隔 5 扫描");
  f.time += 26 * 60000;
  const restarted = f.create();
  await restarted.tick();
  assert.equal(f.delivered.length, 0);
  assert.equal(f.tasks[0].nextRunAt, new Date(2025, 0, 1, 10, 30).getTime());
  f.time = f.tasks[0].nextRunAt;
  await restarted.tick();
  assert.equal(f.delivered.length, 1);
});

test("dispatch errors persist without retry; save failure prevents delivery", async () => {
  const f = fixture();
  const engine = f.create();
  await f.command(engine, "每隔 5 投递");
  f.options.dispatch = () => { throw new Error("denied"); };
  // The first engine captures dispatch at creation; a reloaded engine uses the failing callback.
  const failing = f.create();
  f.time += 5 * 60000;
  await failing.tick();
  assert.equal(f.tasks[0].lastError, "denied");
  assert.equal(f.errors.length, 1);
  await failing.tick();
  assert.equal(f.errors.length, 1);
  const resumed = f.create();
  await resumed.tick();
  assert.equal(f.errors.length, 1);
  const failSave = fixture();
  let saves = 0;
  failSave.options.save = tasks => {
    saves++;
    if (saves === 2) throw new Error("disk full");
  };
  const guarded = failSave.create();
  await failSave.command(guarded, "每隔 5 运行");
  failSave.time += 5 * 60000;
  await assert.rejects(guarded.tick(), /disk full/);
  assert.equal(failSave.errors[0].error.message, "disk full");
  assert.equal(failSave.delivered.length, 0);
});

test("commands isolate by channel/chat/user and enforce limits and input validation", async () => {
  const f = fixture();
  const engine = f.create();
  assert.match(await f.command(engine, ""), /用法/);
  assert.match(await f.command(engine, "每隔 4 运行"), /间隔须为/);
  assert.match(await f.command(engine, "每隔 10081 运行"), /间隔须为/);
  assert.match(await f.command(engine, "每隔 5.5 运行"), /间隔须为/);
  assert.match(await f.command(engine, "每天 24:00 运行"), /时间格式/);
  assert.match(await f.command(engine, `每天 10:00 ${"字".repeat(12001)}`), /12000/);
  assert.match(await f.command(engine, "每天 10:00 运行", { sessionId: null }), /关联会话/);
  await f.command(engine, "每隔 5 私有任务");
  const id = f.tasks[0].id;
  for (const overrides of [{ channel: "feishu" }, { chatId: "other" }, { userId: "other" }]) {
    assert.equal(await f.command(engine, "列表", overrides), "暂无定时任务。");
    assert.equal(await f.command(engine, `删除 ${id}`, overrides), "未找到该定时任务。");
    assert.equal(await f.command(engine, `暂停 ${id}`, overrides), "未找到该定时任务。");
  }
  assert.match(await f.command(engine, "列表"), /私有任务/);
  for (let i = 1; i < 20; i++) await f.command(engine, `每隔 5 任务${i}`);
  assert.equal(f.tasks.length, 20);
  assert.match(await f.command(engine, "每天 10:00 超额"), /最多 20/);
  await f.command(engine, `删除 ${id}`);
  assert.equal(f.tasks.length, 19);
  await f.command(engine, "每隔 5 可再创建");
  assert.equal(f.tasks.length, 20);
});
