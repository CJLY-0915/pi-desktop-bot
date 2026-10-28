"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../lib/store.cjs");

test("同一会话的渠道恢复记录相互隔离，兼容旧键并保留启用渠道", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ pairings: {}, bindings: {}, pendingTurns: {
    "A-1": { sessionId: "A-1", channel: "feishu", text: "旧飞书" },
  } }));
  const store = createStore(dir);
  store.savePendingTurn({ sessionId: "A-1", channel: "telegram", text: "TG" });
  assert.equal(store.getPendingTurns().length, 2);
  store.savePendingTurn({ sessionId: "A-1", channel: "feishu", text: "新飞书" });
  assert.equal(store.getPendingTurns().length, 2);
  assert.equal(store.getPendingTurns("feishu")[0].text, "新飞书");
  store.removePendingTurn("A-1", "feishu");
  assert.equal(createStore(dir).getPendingTurns()[0].text, "TG");
  store.setChannelEnabled("telegram", true, ["feishu"]);
  assert.deepEqual(createStore(dir).getEnabledChannels(), ["feishu", "telegram"]);
  store.setChannelEnabled("feishu", false);
  assert.deepEqual(createStore(dir).getEnabledChannels(), ["telegram"]);
});
