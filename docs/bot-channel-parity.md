# 与 ZCode Bot Channel 的对标说明

参考仓库：[zai-org/ZCode](https://github.com/zai-org/ZCode)，Bot 实现在 `packages/services/src/bots/`（`botsService.ts`、`providers/feishuProvider.ts`、`providers/telegramProvider.ts`、`providers/weixinProvider.ts`、`providers/weixinRegistration.ts`、`feishuAppRegistration.ts`、`channelRuntime.ts`），关键文档 `docs/bots.md`、`docs/bots-feishu-streaming-card-reliability.md`。

本次按固定上游提交逐层核对的流程、缺陷与验收边界见 [ZCode 三渠道源码核对记录](zcode-channel-audit.md)。

## 面板交互与设计

界面参考 `packages/ui/src/BotsDialog.tsx`、`ProviderSettingsCard.tsx`、`BotSummaryCard.tsx` 和 `WorkspaceAccessCard.tsx`。采用白色主区、低对比侧栏、绿色状态及细分隔线；桌面左侧选渠道，窄屏改为顶部分栏。连接卡只呈现当前一步，设置用左标签、右控件的行布局，运行记录默认折叠。

- 飞书：扫码创建应用，自动保存凭据并连接，随后显示 `/bind` 命令。
- 微信：扫码登录后同样显示 `/bind`，用户发送该命令同时建立本插件的聊天授权。ZCode 原实现是扫码后发送首条任意消息激活，见 `docs/bots.md` 的 Provider setup 和 `handleWeixinFirstActivation`；本插件按产品要求统一成显式绑定命令。
- Telegram：本地生成指向 `https://t.me/BotFather` 的固定二维码，保留打开入口和 Bot Token 输入，保存连接后显示绑定命令。
- 绑定命令直接位于连接卡内；发送后读取真实授权状态，再显示“已连通/解绑”。复制反馈明确提醒发送到机器人私聊，依据 `docs/ui/bot-bind-command-guidance.md`。
- 钉钉只显示“即将支持”；不展示群聊绑定列表，不提供飞书 App ID/Secret 表单。
- 解绑撤销当前渠道的聊天授权和会话关联，保留凭据。删除凭据同时撤销授权，避免更换机器人后继承旧授权。停用后的授权显示“已绑定”，只有连接成功才显示“已连通”。

服务侧核对：`botsService.ts` 的 `handleBind` 检查私聊、有效期及 bot 身份，消费一次性 code 并写入 `providerUserId`；`removeBotSecret` 会清除密钥引用、绑定身份和上下文。本插件继续使用已有的按渠道聊天授权存储，不把 ZCode 的单 actor 数据模型整套移植。

项目范围对齐 ZCode 的“所有项目/指定项目”：按渠道保存策略，选择已知项目后显式保存。`lib/project-access.cjs` 统一路径匹配与宿主项目列表解析；`lib/bridge.cjs` 在桌面调用入口过滤会话列表、限制项目切换、会话操作及任务派发，指定项目的新会话带显式 `projectPath`，排队执行前再次校验。项目读取失败或归属不明时拒绝执行。桌面原有权限继续生效；已运行回合不会因缩小范围被强制中断。

初始化核对：ZCode `feishuChannelRuntime.ts` 只为已启用且有凭据的 Bot 启动连接。本插件常驻服务无凭据时返回 `unconfigured`，不把缺凭据写入 `channelError`；前端只对已配置渠道显示连接错误。

扫码核对：`providers/feishuAppRegistration.ts` 使用 accounts issuer 的 init → begin → poll；本插件保持相同参数，并为 HTTP/非 JSON/平台拒绝/超时保留明确原因。`slow_down` 间隔为 10 秒。`BotsDialog.tsx` 用 qrcode 本地生成 data URL，本插件在后台完成相同编码，不访问外部二维码站。

权限核对：本机宿主允许自定义面板 channel 转交 `onPanelInvoke`，外链仍经宿主 `shell.openExternal` 权限检查；manifest 已声明外链与写剪贴板权限，升级后必须重新加载并授予，热更新不会扩大权限。

历史验收记录：曾完成 93 项测试及 Edge 隔离页面检查；本次复核结果以 [源码核对记录](zcode-channel-audit.md) 为准。手机扫码确认、真实机器人收发与真实宿主默认浏览器启动仍未验收。

## 接入方式的选择

ZCode 的移动端远程控制有两条路：

1. **手机扫码连接（自建页面）**：用户访问 ZCode 自建页面扫码绑定，依赖其服务端。本插件用户没有自己的服务器，此路不适用。
2. **Bot Channel**：平台官方机器人 + 长连接或长轮询，不需要公网 URL 与中转服务器。**本插件采用此方式**，一次只启用一个通道（`settings.channel` 四选一，桥接按 `${kind}:${chatId}` 隔离，避免多 bot 并发的复杂度）：

| 通道 | 传输方式 | 插件文件 |
|---|---|---|
| 飞书 | `@larksuiteo-api/node-sdk` WSClient，Stream 帧（protobuf），`connectUrl` 连接时下发 | `lib/feishu.cjs` |
| 钉钉 | `dingtalk-stream` DWClient，Stream 端点由 `connections/open` 动态下发 | `lib/dingtalk.cjs` |
| Telegram | Bot API HTTPS 长轮询 `getUpdates`（timeout 25s，客户端 40s 兜底） | `lib/telegram.cjs` |
| 微信 | 官方 iLink Bot 协议 `getupdates` 长轮询（buf 游标，90s 兜底） | `lib/weixin.cjs` |

Telegram 的 `offset` 与微信的 `get_updates_buf` 经 `lib/store.cjs` 保存；Telegram 每条处理成功后提交，微信在整批处理返回后提交。更换或删除机器人凭据会清除该渠道游标，避免新机器人继承旧位点。

## 逐项对标

| 能力 | ZCode 做法 | 本插件实现 |
|---|---|---|
| 扫码建应用 | `feishuAppRegistration.ts` device-code：init → begin → poll | 同流程，见 `lib/feishu-registration.cjs`；`deviceCode` 只在插件内存，成功后经 `saveCredentials` 落盘（0600） |
| 微信扫码登录 | `weixinRegistration.ts`：`get_bot_qrcode` → `get_qrcode_status` 状态归一化 | 同流程，见 `lib/weixin-registration.cjs`；数字/字符串状态统一归一，DOMException 超时视为 pending 不判失败；面板侧与飞书建应用共用同一扫码轮询组件 |
| 令牌管理 | tenant access token 按过期时间缓存、提前刷新 | `lib/feishu-api.cjs`：`requestedAt + expire * 1000`，提前 60s 刷新；响应缺 `expire` 不缓存 |
| 流式卡片 | Card JSON 2.0 单卡 `PATCH` 就地更新；状态行 + `collapsible_panel` 工具摘要 | 飞书固定流式卡片；真实正文增量来自 `message_update`，工具过程只显示折叠摘要，不提供分段卡片选项 |
| 普通飞书回复 | `feishuProvider.ts` 的 `send()` 将普通回复分段，统一调用 `buildFeishuInteractiveCardPayload`，以 `interactive` 发送 | `lib/feishu.cjs` 的 `sendText()` 默认发送 Card JSON 2.0 Markdown 卡片，帮助、状态、错误、普通结果共用；硬换行保留，代码块不改写 |
| 飞书选择按钮 | `body.elements` 直接放按钮，使用 `behaviors.callback`，业务层生成项目/模型等选项 | 审批、提问和命令菜单共用 2.0 按钮载荷，回传 `choiceId` 和选择序号；已实现项目、供应商/模型、思考、模式、权限、回复、会话菜单，每页 8 个业务选项，支持数字回复与取消 |
| 微信/Telegram 回复颗粒度 | 标准、完整、摘要三档 | 渠道独立保存；标准隐藏工具过程，完整显示工具开始/进度/结束，摘要仅发最后助手结果与文件变更摘要；审批、失败和文件上传结果保留。成功 Edit/Write 按路径去重汇总，Shell/外部改动不自动追踪 |
| 元素预算 | 平台单卡 200 组件上限（超限报 230099/11310） | 本地预算 180（`FEISHU_CARD_ELEMENT_BUDGET`）；`countTaggedElements` 只数带 `tag` 的节点；`splitCardStates` 超预算自动封存分段 |
| 写卡节流 | 1s update 间隔 | `FEISHU_CARD_UPDATE_INTERVAL_MS = 1000`，`lib/feishu.cjs` |
| 写卡可靠性 | 连续失败开路 + 退避 | `createCardCircuit`：连续 3 次失败开路，退避 1s → 2s，成功后清零，无定时半开（`at < nextAttemptAt` 才抑制，恰好到达即放行） |
| Typing 状态 | 给入站消息加 Typing 反应 | 飞书回合开始加、结束移除，无 `message_id` 静默跳过；非卡片通道改为 `channel.sendTyping?.(chatId)`（Telegram `sendChatAction`、微信 `sendtyping`），失败只记 warn |
| 私聊投递目标 | open_id | 入站 p2p 消息学习 `open_id`，发送优先 open_id；`oc_` 前缀用 chat_id，见 `lib/feishu-api.cjs` `receiveIdType`。微信同理 chatId=userId，room 只记录 meta |
| 附件上限 | 单条 ≤4 个、单文件 5MB | 发送前前置校验（`MAX_ATTACHMENTS_PER_MESSAGE` / `MAX_ATTACHMENT_BYTES`），超限明确报错；微信通道 `uploadMedia` 明确抛"不支持" |
| 附件-only 入站 | 固定提示语补全 | `ATTACHMENT_ONLY_PROMPT`，见 `lib/bridge.cjs` |
| 入站附件落地 | 下载到本地，服务层保留类型后交付任务 | 同样缓存到私有数据目录；微信/Telegram 保留 kind、filename、path，桥接以本地路径和通用附件提示交付 PI，不把非图片误称图片 |
| Telegram 分段 | 单条 3900 字上限 | `TELEGRAM_TEXT_LIMIT` 按行边界切分，逐段发送，见 `splitTelegramText` |
| Telegram Markdown | `parse_mode=Markdown`，400 且描述命中 parse/entities 类错误时回落纯文本 | 同策略；429/flood 只等待不重发，避免重复投递 |
| Telegram 选择交互 | inline keyboard + 带请求标识的 callback_query | callback_data 的随机 token 关联原 choiceId 和聊天，answerCallbackQuery 后走 handleChoice；旧按钮不会选择新菜单，数字文本回复继续可用 |
| 微信协议包装 | 所有 body 包 `base_info.channel_version="2.0.0"` + `AuthorizationType: ilink_bot_token` 头 | 同结构，见 `lib/weixin.cjs`；`ret/errcode` 非零即抛错，不静默降级 |
| 微信自环过滤 | `message_type=2` 是 Bot 自己发出的消息 | 入站直接跳过，见 `parseGetUpdates` |
| 微信群路由 | 按发送者 userId 路由，room 只记录 meta | 同策略；不做群协作 |

## 与宿主能力的结合（ZCode 没有对应物）

- **回传回合模型**：派发成功即开回合（携带入站 `messageId` 供 Typing 使用）；`assistant_chunk` 增量并入当前卡；审批/提问前封存当前卡，封存后输出由通道自动另起新卡，不回落文本刷屏。
- **服务生命周期**：长连接由宿主 `background.service` 监督，不引入 ZCode 的跨进程 runtime lock。
- **投递状态可见**：开路状态与最近一次投递错误经 `panelState.deliveryError` 展示在面板（`main.js` → `renderer/index.html`）。
- **启动容错**：`channel.start()` 校验失败（如 token 无效）置 stopped 并带错误上面板，不无提示停滞；飞书是即发即忘的 "connecting"，故 `main.js` 仅在状态仍为 connecting 时回落 "starting"，不覆盖已 connected 的新通道。
- **二维码渲染**：`lib/qr.cjs` 用 qrcode 本地生成 PNG data URL，保留平台给出的 base64/data URI 图片；面板不请求第三方二维码图片站。
- **宿主命令**：常用帮助分为“会话”和“配置”，配置只列 `/项目`、`/模型`、`/思考`；运行模式、权限、回复颗粒度、改动、文件发送和解绑放在 `/帮助 更多`，按渠道隐藏不可用项。帮助只展示中文主命令，英文及原别名继续兼容。`lib/bot-commands.cjs` 通过已核实的 `providers/list`、`session/get`、`session/configure`、`project/list|get|set` 生成菜单；模型先选服务商再选模型，思考档位取会话有效 `supportedThinkingLevels` 并显示中文名称及实际值。运行模式与权限模式分开，配置变更需桌面开启危险操作并传 `confirm:true`，保留当前运行模式。
- **菜单状态**：按渠道/聊天隔离、10 分钟有效、一次性选择；分页产生新菜单 ID，旧菜单不可重放。新命令或任务使旧请求失效，选择前复查授权、关联会话、执行状态及项目范围。`/项目` 切换桌面工作区，已有会话不移动。

## 有意不做（范围控制）

- 群协作/话题（`docs/bots-feishu-group-collaboration.md`）
- Webhook / Lark（国际站）通道：`msg-frontier.feishu.cn` 与飞书 SDK 已覆盖当前需求
- Discord / WeCom：ZCode 亦未实现，无协议可对标
- 多 bot 同时在线（ZCode 的多 bot 并发模型）；钉钉本身已是超出 ZCode 已实现清单的部分

## 为什么插件不声明 `net.*` 权限

SDK 与 Node HTTP 请求直接联网；manifest 的 `net.domains` 不会约束这些原生请求，不能把域名声明当作网络沙箱。插件没有申请宿主的 `net.fetch/net.websocket`，飞书流量由 SDK 处理，Telegram/微信使用原生 HTTPS。动态 WebSocket 端点和平台返回的附件 URL 也必须与这一实现事实区分。
