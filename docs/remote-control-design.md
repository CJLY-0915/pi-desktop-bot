# PI-Desktop 远程控制能力设计方案

> 版本：v1.0（设计稿，未实现）
> 宿主基线：PI-Desktop 0.21.0（`D:\Program Files\PI-Desktop\resources\app.asar`）
> 结论先行：**自建远程控制插件，接入飞书/钉钉官方机器人长连接**。国内直连、不需要公网服务器、不依赖任何第三方中继平台。Telegram 因网络原因排除；自托管 Web 作为二期增强。

---

## 1. 需求定义

"手机端宿主"= 手机发命令 → 桌面宿主执行 Agent → 结果回传手机。功能集：

| # | 功能 | 说明 |
|---|---|---|
| F1 | 派发任务 | 向指定/新建会话发送指令，Agent 立即执行 |
| F2 | 回传结果 | 文本结果分段推送；文件/图片回传 |
| F3 | 中断任务 | 中止运行中的回合 |
| F4 | 远程审批 | 工具权限请求、Agent 提问（asktool）、Plan/Goal 检查点，远程批准或拒绝 |
| F5 | 会话管理 | 列表、切换、新建、状态、diff 查看 |
| F6 | 安全 | 配对绑定、chatId 白名单、审计日志、频率限制 |

## 2. 宿主能力基线（已核验，非推测）

以下均从安装目录 `D:\Program Files\PI-Desktop\resources\app.asar`（v0.21.0）及本机插件实例核实：

### 2.1 桌面控制网关 `pi.desktop.invoke`

插件声明 `desktop.control` 权限后，可调用宿主 **72 个控制操作**（定义于 app.asar 内 `CONTROL_OPERATION_SPECS`），与远程控制直接相关的：

- 派发与中断：`agent/prompt`（向会话注入 prompt）、`agent/abort`、`agent/stop`、`agent/getStatus`
- 会话：`session/list`、`session/create`、`session/get`（含 transcript）、`session/open`、`session/configure`（含 permission mode）、`session/rename`、`session/moveProject`
- 远程审批：`tool/resolvePermission`、`agent/askTool/resolve`、`plans/pending`、`plans/resolve`
- 上下文：`fs/read`、`workspace/diff`、`project/get|list|set`、`agent/instructions/get`
- 已由本机微信 BOT 插件验证的调用形态：
  `pi.desktop.invoke({ operation: "agent/prompt", args: [{ sessionId, content }] })`（见 `io.github.xideadev.pi-wechatbot/main.js`）

### 2.2 会话协作 API（pluginOnly，更结构化的派发）

`session/collaboration/spawn|send|status|result|cancel|list` 仅插件可调（宿主要求 `source === "plugin"` 且带 pluginContext）。精确语义（宿主 Rust 侧 `session_collaboration/mod.rs`）：

- `spawn {task,title?,idempotencyKey,sourceSessionId,pluginId}`：创建**新的** Agent 会话（继承父会话 project/model/permission）并投递首个任务；每父会话活跃 worker < 4、每插件 < 16。
- `send {sessionId,content,kind=task|message,idempotencyKey,notifyOnCompletion?}`：向**已有**会话投递；双方必须是 agent 模式；目标收件箱排队上限 8；content ≤ 65536 字符。
- `status {sessionId}` / `result {sessionId,messageId?}`：读执行状态与**持久化任务结果**。
- `cancel {sessionId,messageId?}`：取消本插件投递的任务，不删会话。

适用场景：派活式长任务（要 durable outcome + 幂等重投）。简单对话式控制用 `agent/prompt` 即可。

### 2.3 Agent 进程内扩展

manifest `contributes.agentExtensions` + `agent.extension` 权限，宿主 Agent 运行时加载扩展并注入 `api`：

- 事件：`agent_start`、`user_message`、`tool_call`、`message_end`、`agent_end`
- `tool_call` 可 `return { block: true, reason }` —— 微信 BOT 用它拦截 `asktool`，避免远程用户等待桌面弹卡（直接改为文本选项交互）
- `api.registerTool` 注册 agent 可主动调用的工具（如"把文件发到手机"）

### 2.4 插件权限与网络面

- `net.fetch` + `manifest.net.domains` 域名白名单（仅放行域名，重定向逐跳复核）
- `net.websocket`（高风险但已实现）——长连接通道的关键
- `background.service` + `contributes.services`：宿主监督的常驻服务（断线重连、心跳）
- 另有 `ui.panel`、`agent.tool.register`、`notify`

### 2.5 内置 MCP 控制服务器（备选路径，默认关闭）

- 地址 `http://127.0.0.1:37123/mcp`，streamable-http，Bearer token（`~/.pi-desktop/mcp-control.token`）
- 仅当启动环境变量 `PI_DESKTOP_MCP_CONTROL=1` 时才启动（`bootstrap/startup.ts`）；本机当前未监听
- 强制 loopback 绑定，且 Origin/Host 头白名单只放行 `127.0.0.1/localhost/::1` —— **经 Tailscale/隧道用域名访问会被 403**，必须前置反代重写 Host

### 2.6 现有插件失败根因（对照）

| 插件 | 根因 |
|---|---|
| `pi.agents-anywhere` v1.0.3 / `adoin.panel.anywhere` v2.2.2 | 两者都是外部 **Agents Anywhere 中继平台**的客户端（市场目录描述明载"基于 Agents Anywhere 平台"）；平台不可达即失效。2.2.2 另需 `net.anyHost` 广域权限、宿主 ≥0.18.0 |
| `io.github.xideadev.pi-wechatbot` v1.3.1 | 架构正确（§2.1–2.3 全部走通），体验差在微信接入层：openclaw 协议扫码登录、`session_expired` 需重扫、消息/媒体适配繁琐 |

## 3. 总体架构

```
手机（飞书 App / 钉钉 App）
   │  官方开放平台长连接（出站 WSS，无需公网 URL、无需服务器）
   ▼
┌─────────────────────────────────────────────┐
│ 桥接层：PI 插件（background.service 常驻）        │
│  ├─ Channel 适配层：FeishuAdapter / DingTalkAdapter │
│  ├─ 路由器：chatId ↔ sessionId 绑定、指令解析      │
│  ├─ 安全网关：配对码、白名单、令牌桶、审计          │
│  └─ 结果整形：分段、卡片、媒体上传                 │
├─────────────────────────────────────────────┤
│ 执行层                                        │
│  ├─ pi.desktop.invoke（agent/prompt、审批、中断）  │
│  └─ agent 扩展（事件回传、asktool 拦截）           │
└─────────────────────────────────────────────┘
```

通道适配层统一接口（实现时可替换通道，微信/Telegram/Slack 只是再加一个 Adapter）：

```ts
interface Channel {
  start(): Promise<void>;                    // 建长连接、注册事件
  stop(): Promise<void>;
  onMessage(cb: (msg: InboundMsg) => void): void;   // text/image/file
  sendText(chatId: string, text: string): Promise<void>;
  sendCard(chatId: string, card: CardSpec): Promise<void>;  // 审批/选项
  onCardAction(cb: (a: CardAction) => void): void;
  uploadMedia(chatId: string, file: string): Promise<void>;
}
```

## 4. 通道详设

### 4.1 飞书（推荐首选）

**建应用**：open.feishu.cn → 创建企业自建应用 → 添加"机器人"能力 → 申请权限 → 发布版本（企业内审批；个人可免费注册一个企业自用）。

**接收事件（两种，选长连接）**：

| 方式 | 公网要求 | 结论 |
|---|---|---|
| 长连接（WS） | 无，SDK 主动出站连接开放平台 | **采用** |
| Webhook 回调 | 需要公网 HTTPS URL + challenge 校验 | 不采用 |

- 事件订阅方式选"使用长连接接收事件"；Node 侧用官方 SDK 的 WSClient（`@larksuiteoapi/node-sdk`）在插件常驻服务里跑。
- 消息事件：`im.message.receive_v1`（单聊或群内 @机器人）；支持 text / post（富文本）/ image / file。
- 按钮回调：`card.action.trigger`（互动卡片 interactive JSON）。

**发送消息**：`POST /open-apis/im/v1/messages?receive_id_type=chat_id`，body 按 msg_type=text/post/interactive。鉴权用 `tenant_access_token`：`POST /open-apis/auth/v3/tenant_access_token/internal`（App ID + Secret），有效期约 2h，客户端缓存并提前刷新，401 时重取重试。

**媒体回传**：先调上传接口拿 image_key/file_key，再随消息发送；收图同理用 `im/v1/files/{file_key}` 拉取（需 `im:resource` 类权限）。

**必要权限（设计基线，以实现时文档为准）**：`im:message`、`im:message:send_as_bot`、`im:resource`、（按需）`im:chat:readonly`。

**限流与坑**：

- 应用级限流（量级约百次/分钟），发送侧必须做队列 + 指数退避；
- 应用未发布时收不到事件；机器人需被加好友或拉进群；
- 长连接断线 SDK 自动重连，但要监听连接状态做宿主侧心跳/降级提示；
- 卡片回调要求快速响应（先回 toast 更新，再异步落库执行），否则用户看到失败。

### 4.2 钉钉（备选，同样免公网）

**建应用**：open-dev.dingtalk.com → 企业内部应用 → 添加机器人能力 → 申请权限 → 发布（需企业管理员）。

**接收事件**：

| 方式 | 公网要求 | 结论 |
|---|---|---|
| Stream 模式 | 无，SDK 出站 WSS（dingtalk-stream） | **采用** |
| HTTP 回调 | 需公网 URL | 不采用 |
| 群自定义机器人 Webhook | — | **只能发不能收**，仅可作通知出口，不能做控制入口（常见误区） |

- 消息事件：机器人收消息（text/picture/file），单聊或群 @；
- 互动卡片：创建/更新卡片实例，按钮走卡片回调；**AI 卡片支持流式更新**，适合长任务进度条；
- 鉴权：AppKey + AppSecret → `POST /v1.0/oauth2/accessToken`（约 2h）。

**与飞书的差异**：钉钉对文件消息支持更弱（图片需经 rdsc 接口换临时 URL）；卡片模版管理更繁琐；消息频率限制更紧。飞书在消息类型丰富度和卡片灵活性上更优，**优先飞书，钉钉作为第二通道**。

### 4.3 自托管 Web 是否需要服务器（直接回答）

需要"公网入口"，三选一：

1. **自有 VPS + 域名 + 反代（或 frp 内网穿透）**：完全可控，月费几十元起，安全与可用性自担；
2. **Cloudflare Tunnel（cloudflared）**：零服务器免费，但国内访问质量差、quick tunnel 域名随机不稳定；
3. **Tailscale**：不需要任何服务器，手机与 PC 装 App 组成私网；但这是私有网络而非公网 Web，且宿主内置 MCP 控制面的 Host 头白名单会拦域名访问（插件自建网关不受此限，可绑定 Tailscale 网卡）。

结论：一期用 IM 通道（零服务器）；若二期要完整移动端 UI（会话列表、diff 查看、文件浏览），再上"插件 Web 网关 + Tailscale"，不必一期投入。

## 5. 插件结构设计

```
<plugin-id>/
├─ manifest.json          # 权限：desktop.control / agent.extension / agent.tool.register /
│                         #      background.service / net.websocket / ui.panel
│                         # net.domains 精确放行 open.feishu.cn、open-api.dingtalk.com 等
│                         # contributes.services + agentExtensions + commands
├─ main.js                # 常驻服务、通道生命周期、路由器、安全网关
├─ extensions/agent.js    # agent 进程内：事件回传、asktool 拦截、注册 send_file_to_phone 工具
├─ lib/
│  ├─ channel.ts          # Channel 接口 + 工厂
│  ├─ feishu.ts / dingtalk.ts
│  ├─ router.ts           # 指令解析与 chatId↔sessionId 绑定
│  ├─ security.ts         # 配对码、白名单、令牌桶
│  ├─ store.ts            # 插件 data 目录持久化（凭据 600 权限）
│  └─ render.ts           # 结果分段、卡片构造、媒体上传
└─ renderer/index.html    # 面板：配对、通道状态、会话绑定、审计日志
```

manifest 权限刻意**不申请 `net.anyHost`**（anywhere 插件的广域权限正是审核与信任痛点），只放行平台域名。

## 6. 核心流程

### 6.1 指令派发

```
手机发文本 → Adapter → router 鉴权（白名单/频率）
  → 绑定会话？否 → /new（session/create）并记录绑定
  → agent/prompt { sessionId, content }   // content 前缀 [远程/飞书] 标记来源
  → agent 扩展 message_end 增量 → render 分段 → sendText/sendCard
  → agent_end → 结算消息（token 用量、耗时）
```

超长结果按平台限制分段（飞书 post 富文本 / 钉钉卡片）；文件走 `send_file_to_phone` 工具（agent 主动推送）或指令 `/send <path>`。

### 6.2 远程审批（F4）

- 工具权限：宿主 `tool/resolvePermission` 待决 → 推"允许/拒绝"卡片 → 回调调 resolve；
- asktool：扩展拦截后转编号文本选项 → 用户回复序号 → `agent/askTool/resolve`；
- Plan/Goal：`plans/pending` 轮询 + 卡片 → `plans/resolve`；
- 策略：dangerous 级默认必须远程显式批准；可配置 autoApprove 白名单（只读类工具）。

### 6.3 中断（F3）

`/cancel` → `agent/abort`（立即）或 `agent/stop`（优雅）；协作任务用 `session/collaboration/cancel`。

### 6.4 会话管理（F5）

`/sessions`（session/list）、`/use <id>`、`/new [title]`、`/status`（agent/getStatus + session/get 摘要）、`/diff`（workspace/diff）、`/project <path>`（project/set，危险级，需二次确认）。

## 7. 安全设计

| 项 | 措施 |
|---|---|
| 配对 | 面板生成绑定码；手机 `/bind <码>` 后把该 chatId 写入白名单；未绑定聊天拒绝执行并提示绑定 |
| 凭据 | AppSecret 等存 `~/.pi-desktop/plugins/data/<id>/`，文件 0600；日志过滤 secret 字段 |
| 网络最小化 | net.domains 只放行平台域名；无 anyHost |
| 命令面收敛 | 远程仅暴露白名单指令；`project/set`、`agent/instructions/save`、settings 类操作禁远程或二次确认 |
| 审计 | 全量指令日志（chatId、指令、sessionId、结果状态、耗时），滚动 512KB |
| 滥用防护 | 单 chat 并发任务上限、令牌桶限速、content ≤ 64KB（与宿主协作 API 上限一致） |
| 威胁模型 | IM 账号被盗 → 白名单+配对码+危险操作确认；断线/掉线 → 长连接重连 + 宿主侧服务监督 |

## 8. 验收标准（实现阶段）

1. 真实飞书应用 + 真实手机：发消息 → 桌面会话出现 prompt → Agent 执行 → 结果分段回推（含一次文件回传）；
2. asktool 远程应答闭环；工具权限远程批准/拒绝闭环；
3. `/cancel` 中断闭环；宿主重启后桥接服务自动恢复；
4. 未配对 chatId 发送指令被忽略；错误配对码被拒绝；
5. `PluginCheck` 通过；全程无工作区外文件写入。

## 9. 风险与未决项

- 飞书/钉钉端点路径与限流数值以实现时开放平台文档为准（本文为设计基线）；
- 长连接在宿主休眠/网络切换后的恢复策略（SDK 重连 + 心跳 + 状态面板可见）；
- 卡片回调超时（飞书要求快速响应）的异步落库方案；
- `net.websocket` 属高风险权限，上架市场需准备说明材料；
- 二期 Web UI 若走 Tailscale，需处理 Host 头/绑定网卡细节。
