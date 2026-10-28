"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  STATE_FILE,
  CREDENTIALS_FILE,
  IPC_FILE,
  AUDIT_FILE,
  AUDIT_MAX_BYTES,
} = require("./constants.cjs");

/**
 * 插件持久化状态：配对、绑定、凭据、审计日志。
 * 所有文件位于宿主分配的插件私有数据目录，敏感文件 0600。
 */

function atomicWriteJson(file, value, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: mode ?? 0o600,
  });
  fs.renameSync(tmp, file);
  if (mode !== undefined) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* Windows 上 chmod 近似无效，忽略 */
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function createStore(dataDir) {
  const stateFile = path.join(dataDir, STATE_FILE);
  const credentialsFile = path.join(dataDir, CREDENTIALS_FILE);
  const ipcFile = path.join(dataDir, IPC_FILE);
  const auditFile = path.join(dataDir, AUDIT_FILE);

  let state = readJson(stateFile, {
    pairings: {},
    bindings: {},
    pairingCode: null,
    pairingCodeAt: 0,
    offsets: {},
  });

  function persist() {
    atomicWriteJson(stateFile, state);
  }

  return {
    dataDir,
    stateFile,
    credentialsFile,
    ipcFile,
    auditFile,

    getPairings() {
      return state.pairings;
    },
    isPaired(channelKind, chatId) {
      return Boolean(state.pairings[`${channelKind}:${chatId}`]);
    },
    pair(channelKind, chatId, meta = {}) {
      state.pairings[`${channelKind}:${chatId}`] = {
        channel: channelKind,
        chatId,
        pairedAt: new Date().toISOString(),
        ...meta,
      };
      persist();
    },
    unpair(channelKind, chatId) {
      delete state.pairings[`${channelKind}:${chatId}`];
      this.saveContextToken(channelKind, chatId, "");
      this.clearFailedDelivery(channelKind, chatId);
      persist();
    },

    getBinding(channelKind, chatId) {
      return state.bindings[`${channelKind}:${chatId}`] ?? null;
    },
    setBinding(channelKind, chatId, sessionId, options = {}) {
      state.bindings[`${channelKind}:${chatId}`] = {
        sessionId,
        boundAt: new Date().toISOString(),
        ...options,
      };
      persist();
    },
    updateBinding(channelKind, chatId, patch) {
      const binding = state.bindings[`${channelKind}:${chatId}`];
      if (!binding) return;
      Object.assign(binding, patch);
      persist();
    },
    clearBinding(channelKind, chatId) {
      delete state.bindings[`${channelKind}:${chatId}`];
      this.clearFailedDelivery(channelKind, chatId);
      persist();
    },
    listBindings() {
      return Object.entries(state.bindings).map(([key, value]) => ({
        key,
        ...value,
      }));
    },

    getPendingTurns(channelKind) {
      return Object.values(state.pendingTurns ?? {}).filter(turn => !channelKind || turn.channel === channelKind);
    },
    savePendingTurn(turn) {
      state.pendingTurns ??= {};
      if (state.pendingTurns[turn.sessionId]?.channel === turn.channel) delete state.pendingTurns[turn.sessionId];
      state.pendingTurns[`${turn.channel}:${turn.sessionId}`] = turn;
      persist();
    },
    removePendingTurn(sessionId, channelKind) {
      for (const [key, turn] of Object.entries(state.pendingTurns ?? {})) {
        if (turn.sessionId === sessionId && (!channelKind || turn.channel === channelKind)) delete state.pendingTurns[key];
      }
      persist();
    },
    getEnabledChannels() { return state.enabledChannels ?? null; },
    setChannelEnabled(channelKind, enabled, initial = []) {
      const channels = new Set(state.enabledChannels ?? initial);
      if (enabled) channels.add(channelKind);
      else channels.delete(channelKind);
      state.enabledChannels = [...channels];
      persist();
    },

    getSchedules() { return state.schedules ?? []; },
    saveSchedules(tasks) { state.schedules = tasks; persist(); },

    getFailedDelivery(channelKind, chatId) {
      return state.failedDeliveries?.[`${channelKind}:${chatId}`] ?? null;
    },
    saveFailedDelivery(channelKind, chatId, delivery) {
      state.failedDeliveries ??= {};
      state.failedDeliveries[`${channelKind}:${chatId}`] = delivery;
      persist();
    },
    clearFailedDelivery(channelKind, chatId) {
      if (!state.failedDeliveries?.[`${channelKind}:${chatId}`]) return;
      delete state.failedDeliveries[`${channelKind}:${chatId}`];
      persist();
    },
    getContextToken(channelKind, chatId) {
      return readJson(credentialsFile, null)?.contextTokens?.[`${channelKind}:${chatId}`] ?? "";
    },
    saveContextToken(channelKind, chatId, token) {
      const credentials = readJson(credentialsFile, null) ?? {};
      credentials.contextTokens ??= {};
      const key = `${channelKind}:${chatId}`;
      if (token) credentials.contextTokens[key] = String(token);
      else delete credentials.contextTokens[key];
      atomicWriteJson(credentialsFile, credentials, 0o600);
    },
    getProjectAccess(channelKind) {
      return state.projectAccess?.[channelKind] ?? { mode: "all", paths: [] };
    },
    setProjectAccess(channelKind, policy) {
      state.projectAccess ??= {};
      state.projectAccess[channelKind] = policy;
      persist();
    },

    setPairingCode(code) {
      state.pairingCode = code;
      state.pairingCodeAt = Date.now();
      persist();
      return code;
    },
    getPairingCode() {
      return state.pairingCode && state.pairingCodeAt ? { code: state.pairingCode, at: state.pairingCodeAt } : null;
    },
    clearPairingCode() {
      state.pairingCode = null;
      state.pairingCodeAt = 0;
      persist();
    },

    /** 长轮询游标（Telegram offset / 微信 get_updates_buf）：重启后不重放旧消息。 */
    getOffset(channelKind) {
      const value = state.offsets?.[channelKind];
      return typeof value === "number" || typeof value === "string" ? value : null;
    },
    setOffset(channelKind, value) {
      if (!state.offsets) state.offsets = {};
      state.offsets[channelKind] = value;
      persist();
    },

    loadCredentials() {
      return readJson(credentialsFile, null);
    },
    saveCredentials(credentials) {
      atomicWriteJson(credentialsFile, credentials, 0o600);
    },
    clearCredentials() {
      try {
        fs.unlinkSync(credentialsFile);
      } catch {
        /* 文件不存在即视为已清除 */
      }
    },

    writeIpcPort(port, pid) {
      atomicWriteJson(ipcFile, { port, pid }, 0o600);
    },
    removeIpcFile() {
      try {
        fs.unlinkSync(ipcFile);
      } catch {
        /* 同上 */
      }
    },

    /** 审计日志：滚动 JSONL，超过 512KB 改名为 .old。 */
    audit(entry) {
      try {
        if (fs.existsSync(auditFile) && fs.statSync(auditFile).size > AUDIT_MAX_BYTES) {
          try {
            fs.unlinkSync(`${auditFile}.old`);
          } catch {
            /* 无旧文件 */
          }
          fs.renameSync(auditFile, `${auditFile}.old`);
        }
        fs.appendFileSync(
          auditFile,
          `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
          "utf8",
        );
      } catch {
        /* 审计失败不阻塞主流程，但绝不静默丢失：由上层 toast 提示 */
      }
    },
    readAudit(limit = 50) {
      try {
        if (!fs.existsSync(auditFile)) return [];
        return fs
          .readFileSync(auditFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-limit)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .reverse();
      } catch {
        return [];
      }
    },
  };
}

module.exports = { createStore, atomicWriteJson, readJson };
