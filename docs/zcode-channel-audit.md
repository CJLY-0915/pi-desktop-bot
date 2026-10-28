# ZCode 三渠道源码核对记录

本次参考固定为 ZCode 提交 [`3c5b227649371507ddc4eb46ac5133afe6db1cab`](https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab)，避免把不同 SDK、UI 或服务版本的行为混为一谈。

## 阅读范围与流程

| 阶段 | 官方实现与结论 | 插件对应入口 |
|---|---|---|
| UI 初始化 | `BotsDialog.tsx` 的 refresh/saveBot、ProviderSettingsCard 的凭据/绑定/运行错误状态；无凭据的飞书和微信自动开始一次扫码，Telegram 展示固定 BotFather 二维码与 Token 表单 | `renderer/app.js` 的 refresh、renderCredential、renderBindCode；插件保留显式点击扫码 |
| 飞书扫码建应用 | `feishuAppRegistration.ts`：accounts issuer 的 `init → begin → poll`，`PersonalAgent`、`client_secret`、`request_user_info=open_id`；本地二维码，pending/slow_down/拒绝/过期分开 | `lib/feishu-registration.cjs`、`lib/qr.cjs`、`main.js` 的 AppRegistration RPC |
| 微信扫码登录 | `weixinRegistration.ts`：`get_bot_qrcode?bot_type=3 → get_qrcode_status`；pending/scanned/success/expired；长等待超时继续轮询 | `lib/weixin-registration.cjs`、`main.js` 的 WeixinRegistration RPC |
| 浏览器打开 | Telegram 按钮由 `BotsDialog.tsx:917` 调用 `platform.openExternal(TELEGRAM_BOTFATHER_URL)`；当前官方扫码详情只显示二维码、状态和用户码，不额外自动打开浏览器 | 面板 BotFather 按钮和扫码 URL 按钮显式调用 `pluginBridge.invoke("shell.openExternal", {url})` |
| 凭据与连接 | `saveBot` 经 CredentialService 保存密钥引用；三个 channel runtime 按启用状态、凭据及连接身份启动/替换实例 | `saveChannelCredentials` 保存插件私有凭据，`startChannel/stopChannel` 管理单活动实例 |
| 飞书长连接 | `feishuProvider.ts:1816` 验证凭据后加载 SDK，观察真实 socket；`feishuChannelRuntime.ts` 处理启动、重连耗尽、取消与恢复 | `lib/feishu.cjs` 使用实际安装的 SDK 1.76.0 的 onReady/onReconnecting/onReconnected/onError，处理 start Promise 的拒绝 |
| 微信连接 | 官方 provider `test()` 使用无用户参数的 `/getconfig` 校验；runtime 的 `/getupdates` 批次成功后保存 buf；typing 单独用用户 ID/context_token 请求 ticket | `lib/weixin.cjs` 同样校验、轮询、保存 buf、请求 typing_ticket |
| Telegram 连接 | getUpdates 长轮询；官方 runtime 在每条业务回调成功后提交 offset；getFile 后从 `/file/bot<TOKEN>/<file_path>` 下载 | `lib/telegram.cjs` 的 start、pollLoop、downloadInbound |
| 绑定与首条消息 | `botsService.ts:6456` 的 /bind 限私聊、检查 code 的 bot 身份/有效期并一次消费；微信 `handleWeixinFirstActivation` 用首条普通私聊激活，欢迎后不把它派发为任务 | 插件三渠道统一显式 /bind；绑定成功发送帮助，不把绑定命令派发为任务 |
| 任务与回复 | BotsService 处理授权、项目范围、创建/复用任务、提问/审批；channel 层负责文本/卡片、typing、附件；飞书阻塞交互前封存卡片，Telegram 键盘绑定请求，微信使用编号文本 | `lib/bridge.cjs`、`lib/bot-commands.cjs` 与三个 adapter；沿用 PI 的 desktop.control 与 Agent 扩展 |

已阅读相关文档：`docs/bots.md`、`docs/ui/bot-bind-command-guidance.md`、`docs/bot-channel-runtime-split.md`、`docs/bots-feishu-streaming-card-reliability.md`。服务端沿注册、绑定、首条激活、连接 runtime、provider 收发与附件处理阅读；没有宣称通读 ZCode 全仓或全部 docs。

## 已确认并修复的问题

1. **取消扫码只影响前端，迟到结果仍能保存凭据。** 原 `main.js` 在 begin 返回后才记录扫码会话，poll await 后也不检查是否已取消/替换。飞书和微信均已用会话对象身份检查保护 begin、poll 和落盘入口，过期结果不会提交；清凭据和卸载同时使扫码失效。前端在二维码生成中取消也会通知后台。
2. **更换机器人继承旧身份状态。** 原保存入口只替换密钥，旧配对、会话和轮询游标继续存在。现在三个保存入口共用 `saveChannelCredentials`，凭据变化时停止旧实例并清除该渠道授权、会话、游标和当前绑定码；相同凭据及其他渠道状态保留。删除凭据同时清游标。
3. **连接生命周期缺少请求归属。** 原旧实例可覆盖新实例状态、写回旧游标；多个 start/stop 交错也可能创建未跟踪实例。现在回调/写游标检查实例身份，启动请求按序号取最新者，创建替代实例前等待旧 stop 完成；停止操作取消尚在等待的启动。
4. **飞书启动失败可能无反馈。** SDK 对非法 App ID 只记录日志并返回，原插件会一直处于启动态；异步 start 拒绝也未处理。现在先校验 App ID/Secret，并把启动 Promise 的拒绝上报为连接错误。
5. **Telegram 游标确认过早。** 原代码先推进内存 offset 再处理 update，且整批结束才保存，处理中途失败可跳过该条。现在每条成功处理后先持久化，再推进内存 offset；附件临时下载失败也不确认消息。超限附件明确通知用户，避免永久阻塞接收队列。
6. **Telegram 附件地址错误。** 原使用 `/bot<TOKEN>/file/<path>`，已改为官方的 `/file/bot<TOKEN>/<path>`。
7. **Telegram 旧按钮可能选择新请求。** 原 callback_data 只有裸序号，旧按钮会被当成当前菜单/审批的数字回复。现在用不超过 64 字节的随机 token 关联原 choiceId 和聊天，交给现有一次性菜单/审批校验；旧格式按钮明确提示过期，数字文本回复继续可用。
8. **跨聊天去重与交互授权边界不完整。** 消息去重键加入聊天 ID；群聊不接受绑定和任务，已绑定聊天复查 actor；审批重新检查授权、渠道、当前关联会话及允许的选择值。断开渠道清除运行时待发箱，防止旧机器人的待发内容带入新实例。
9. **非图片附件语义错误。** 微信、Telegram 的本地附件保留 kind、filename、path；桥接用通用附件提示，不再把 PDF、音频等一律描述为图片。PI 入口仍以文本中的本地路径交付附件，没有声称移植了 ZCode 的多模态协议。

## 排除的猜测与保留差异

- **不能把官方“SDK 不支持 onReady”的注释直接当作本插件根因。** 本地依赖锁定到 1.76.0，实际源码和类型定义均支持这些回调。官方在 `feishuProvider.ts:1889` 观察 socket 的做法适用于其依赖环境；本插件保留新版 SDK 的公开回调。
- **微信空参数 getconfig 不是本次已确认缺陷。** 官方 `weixinProvider.ts:596` 的 test() 使用相同请求。是否被具体账号/服务端拒绝，仍需真实响应证明。
- **浏览器调用参数正确。** 已只读核对本机 `app.asar`：面板接收 `{url}`，转调 `api.shell.openExternal(url)`，检查权限、允许的 URL 协议并向面板返回异常。manifest 已声明权限；没有用 window.open、弹窗拦截或二维码图片猜测“浏览器打不开”的原因。
- 插件保留单活动渠道、微信显式 /bind、中文命令和 PI 会话模型；未移植多 bot、多窗口文件锁、Lark、群协作、Webhook、计划任务等功能。
- 飞书/微信入站附件下载失败目前沿用记录警告的策略；此次 Telegram 已改为保留 update 重试。未将此差异描述为所有渠道均有可靠附件重试。

## 验证与限制

- 最终执行 `node --test test/*.test.cjs`：157 项通过，0 失败、0 跳过；修改的六个 JavaScript 源文件均通过 `node --check`。测试使用 SDK 回调替身，实际 1.76.0 回调契约另由已安装 SDK 的源码和类型定义核实。
- 六个新增生命周期测试先在原实现上复现失败，再验证修复；回归覆盖注册状态、OAuth HTTP 400、SDK 回调适配、生命周期交错、游标提交/重试、附件 URL/类型、旧按钮、绑定/审批边界和现有任务/回复行为。
- 页面验收通过：飞书/微信扫码成功后收起二维码并显示绑定命令；生成中取消不恢复扫码或保存凭据；Telegram 本地 BotFather 二维码、Token 保存连接、外链错误反馈；扫码页打开按钮传入该次授权 URL。通过同源 iframe 检查 360/680/1024px 布局均无横向溢出，复制按钮可见，并检查了窄屏截图。
- `PluginCheck` 通过，无错误；保留四条权限/静态入口扫描警告。未打包、安装或发布。
- 浏览器隔离验收加载真实面板、main.js、存储和本地二维码生成，外部平台及宿主连接使用可控响应；不读取或覆盖已安装插件的数据。浏览器外链失败为注入故障，用于检查反馈，不等于验证操作系统默认浏览器已真实启动。
- 实际飞书/微信手机扫码确认、真实机器人收发、真实代理网络以及系统默认浏览器启动尚未验收。没有真实授权凭据时，单元测试和页面隔离检查不能证明这些外部端到端流程已经成功。

源码入口：

- [BotsDialog](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/BotsDialog.tsx)
- [ProviderSettingsCard](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/BotsDialog/ProviderSettingsCard.tsx)
- [bot 服务目录](https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/bots)
- [官方 bots 文档](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/bots.md)

## 执行结束后机器人仍忙：宿主回传契约修正

- 已确认的一处契约缺陷由本机 `agent-runtime/chunks/runner-X4ZX2DU4.js` 的 `TrustedExtensionRunner.createContext()` 证明：桌面会话 ID 通过 `ctx.sessionManager.getSessionId()` 提供，没有 `ctx.sessionId`。原扩展把正文和结束事件发到空 ID，桥接无法匹配会话；旧测试自己提供 `ctx.sessionId`，遗漏了真实契约。用户完整重启后复测仍未回传，因此这项修正不足以证明真实问题已完全解决。
- 桌面支持 `before_agent_start`，不支持 `user_message`。扩展改用前者识别远程 prompt，并使启动顺序不影响远程轮次标记。IPC 读取宿主数据根，Windows 路径使用 `fileURLToPath`；逐次重读端口文件，投递错误输出明确诊断。
- 桥接先准备回传卡片再派发 prompt，覆盖短任务抢先结束的情况；只有最终快照时也回传正文，结束后清理执行状态并推进队列。派发失败收束卡片；不跟踪无关桌面会话的 busy。`/状态` 不再以本地 busy 覆盖宿主明确的空闲。
- 验证：171 项测试通过，PluginCheck 通过。本机实际 `TrustedExtensionRunner` 加载完整扩展，经真实 HTTP 回环 IPC 收到携带正确会话 ID 的开始、增量、最终消息、结束事件；替身飞书卡片得到“你好”回复并变为 completed，busy 清空，下一条任务成功启动。
- 此验收主动注入宿主事件，使用替身平台通道，没有发起真实模型请求或向飞书发送测试消息；真实手机收发尚未验收。实际加载器另报告原有 `send_file_to_phone` 使用 handler 而非 execute 的注册问题，保留为独立未修复项，不影响本次消息回传验收。

## 再次核对 Bot 服务：权威完成事件与轮次归属

本轮重新沿 `botsService.ts` 的输入、订阅、事件队列与完成分支阅读，参考版本仍为上面的固定提交。

| ZCode 源码 | 已确认行为 | 本插件调整 |
|---|---|---|
| `botsService.ts:7816`、`:7829` | 先 `watchTaskStream`，再后台派发 prompt | 主进程加载时订阅宿主 `session:turnEnded`，先建立缓冲和卡片，再调用 `agent/prompt` |
| `taskStreamHub.ts:15`、`botsService.ts:5974` | 同任务共享权威 upstream；优先 workspace/task 的 continuous 事件，避免只监听局部 relay 漏回传 | 正文和工具进度保留扩展 IPC；完成采用宿主轮次事件，避免只靠扩展结束事件 |
| `botsService.ts:5948` | 单目标事件串行消费，防止完成抢在正文 flush 前面 | IPC 仍串行；宿主完成只收束匹配的 turnId，收束期间阻止迟到事件与重复完成 |
| `botsService.ts:5835`、`:5854` | 完成读取权威快照并封卡；文本渠道保留空结果反馈 | 完成补读本轮助手正文；按 turnId 或本次提交的 messageId 边界过滤，排除历史回复和子任务内容；空结果与读取错误有明确反馈 |

宿主契约由本机 `app.asar` 核对：`announceTurnEnded` 在 `session.endTurn` 处理后广播 `{sessionId, turnId, reason}`；SDK `pi.events.on/off` 接收该载荷。`agent/prompt` 返回 sidecar 的 turnId；`session/get` 接受 `{id, messageLimit, contentLimit}`。没有把宿主内部 Live Voice 订阅函数当作插件公开正文接口，也没有新增权限。

扩展为每轮生成 runId，桥接拒绝已结束或不属于当前扩展轮次的事件；宿主结束可早于派发返回，先暂存再按返回的 turnId 匹配。完成回传后才释放 busy、推进队列；中断请求提前标记，避免中断返回前的完成广播启动已取消的排队任务。审计新增 `extension-turn-started`、`host-turn-ended`，记录轮次及是否收到扩展事件，不记录正文或凭据。

验证范围：新增桥接场景先复现五项失败，再修复通过；另覆盖主进程订阅/注销和中断竞态。最终完整测试 178/178 通过，三个修改的源文件通过语法检查；PluginCheck 通过，仍为四条既有权限/静态扫描警告。安装目录的真实 `TrustedExtensionRunner` + HTTP 回环 IPC 验证了扩展增量；第二轮完全不发扩展事件，仅注入已核实契约的宿主结束事件并提供快照，两轮替身飞书卡片均 completed，busy 清空，无历史正文泄露。此检查没有调用真实模型或真实飞书发送接口。

当时尚未闭合的现场问题：用户后续已确认真实飞书最终回复、工具调用和正文流式显示成功；但后来再次漏回复，日志显示派发后约 270ms 开发插件卸载重载，导致本轮缓冲丢失。早先短时只读实验没有捕获到事件，不能据此排除文件元数据通知；下一节记录了后续的直接复现证据。

开发实例的主进程热加载已从宿主日志确认成功；此结论不等同于所有现有会话内扩展工厂缓存都已更新。原有 `send_file_to_phone` 注册签名问题仍独立保留。

## 开发插件重载导致再次漏回复：访问时间通知与恢复记录

- 现场复现：对项目根开启 `fs.watch(root, {recursive:true})`，仅用 Read 查看 `test/feishu-card.test.cjs`，2026-10-27T13:33:02.362Z 捕获 `change`。文件大小始终 5756 字节，mtime/ctime 始终为 08:48:35.167Z，只有 atime 从 13:22:59.526Z 更新至 13:33:02.361Z。另一次只读查看 `test/feishu-status.test.cjs` 也捕获 change。可确认本环境中读取引起的访问时间更新会产生监听通知；不是每次读取都会立刻复现。
- 宿主 `DevPluginWatcher` 对通知只按目录/文件名过滤，忽略 node_modules/.git/dist/target 等目录；未核对内容或 mtime，300ms 后调用开发插件重载。由此解释了没有源码修改仍出现重载。没有改动已安装宿主或系统文件访问时间策略。
- 插件缺陷是回传状态只存在内存，卸载后宿主完成事件找不到对应目标。现在已派发任务的 sessionId/turnId、消息边界、授权标识和回传状态保存在插件私有 state.json；服务停止及卸载先暂停写卡，等待首次建卡/派发确认，保存实际卡片 ID 和内容快照。重新连接后复查授权、绑定和项目范围，接回原卡片；宿主已空闲时补读本轮结果，任务仍执行时继续等待事件。恢复不会重新派发 prompt。
- 用户主动停止连接会清理恢复记录；解绑/换绑或更换授权拒绝旧任务恢复。仍然不持久化尚未派发的排队输入，也不为恢复重放用户任务。状态文件包含恢复所需的回复及卡片内容，使用现有私有存储权限，不写入审计正文。
- 验证：恢复前两个回传场景先复现失败；最终完整测试 185/185 通过，修改源码语法检查及 PluginCheck 通过（四条既有警告）。覆盖原卡片恢复、重载期间完成、迟到派发确认、授权/项目范围变化和主动停止。真实飞书卡片适配器配 API 替身验证暂停等待建卡、复用卡片 ID 与 typing 清理。隔离主进程完整执行 onLoad → service.start → 入站 → service.stop → onUnload → 新主进程 onLoad → service.start，原卡片 completed，prompt 调用一次，恢复记录归零。
- 开发实例加载成功及连接 ready 已从宿主日志确认。本轮未额外向真实飞书发送测试消息；修复后的真实跨重载收发仍待用户现场验收。此机制覆盖正常卸载流程，强制结束进程时的最后写卡快照和网络成功/落盘之间的极小窗口不保证严格一次投递；升级前已丢失的内存卡片无法凭新增记录自动重建。
