# 当前插件与 ZCode Bot Channel 能力差距分析

> 本文正文保留实施前的核查基线与 188 项测试记录，旧差距表不代表当前实现状态。初次实现按单活动渠道、私聊范围补齐卡片、阻塞问答、正式附件、持续回传、显式重试、微信上下文、文件发送及插件日程；0.1.5 起支持不同渠道同时启用。当前行为与宿主限制见 [本次实现与边界](zcode-private-chat-implementation.md)。Lark、同渠道多机器人及群话题不在范围内。

## 结论

当前插件已具备个人私聊远程控制的主要链路：飞书/Telegram/微信接入、显式绑定、创建和选择 PI 会话、派发任务、接收结果、停止、配置菜单、Plan/Goal 检查点审批，以及已派发回合在正常重载后的结果恢复。

与 ZCode 相比，主要差距在“完整会话能力和持续协作”，而非扫码或流式卡片的外观：结构化问答、逐工具权限响应、跨端持续任务回传、正式多模态输入、定时任务结果路由、失败后的显式重试、多机器人实例和飞书/Lark 群话题协作。

如果目标只是一个人通过飞书私聊操作本机，基础覆盖已经较完整；如果目标是获得 ZCode Bot 的整体使用效果，当前仍缺数条关键闭环。没有合理统一的功能分母，不宜给出“已对齐百分之多少”。

## 核查依据与范围

- 本次经 GitHub API 核实，获取的官方 `main` 为 `3c5b227649371507ddc4eb46ac5133afe6db1cab`。下文官方链接固定到该提交。
- UI：`packages/ui/src/BotsDialog.tsx` 与 `BotsDialog/` 下的 ProviderSettingsCard、BotSummaryCard、WorkspaceAccessCard、BoundGroupsCard、PrivateDeliveryRetry 和 shared。
- 服务：沿 `botsService.ts` 的绑定/授权、命令、任务启动与订阅、权限/elicitation、附件、私聊持续同步、自动化投递链路阅读，并核对 provider/runtime/type/formatter 和相关测试。
- 文档：`docs/bots.md`、群协作、话题材料、私聊同步、流式卡片可靠性、runtime 拆分、绑定引导、E2E catalog 及相关故障边界材料。文档包含历史记录，发生矛盾时优先当前代码和最新专门契约。
- 本地：`main.js`、`manifest.json`、`renderer/`、`extensions/agent.js`、bridge/commands/store/project-access/security/IPC、三渠道及卡片/文件 API、相关测试和既有对照文档。
- 补查自动化边界：官方 `automation-port.ts`、`cronBotDelivery.ts` 与 automation repository 的投递目标保存逻辑。
- 本次只新增分析文档，不修改功能，不将 ZCode 全产品或 Mobile Web 的能力全部算作 Bot 功能。

## ZCode 机器人实际提供什么效果

### 1. 每个机器人是一个完整访问实例

一个 Bot 有独立 id、名称、provider、凭据引用、启用状态、绑定身份、项目范围、当前任务/草稿和回复设置。可以管理多个实例，并运行不同渠道的机器人；同渠道也可以创建多个不同账号实例。

这不等于任意多人共用一个私聊 Bot。官方每个 Bot 绑定一个 actor；启用实例不能重复占用冲突的 provider 用户或连接凭据。群协作有另外的授权规则。

官方依据：[BotsDialog.tsx](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/BotsDialog.tsx) 的 handleAddBot 和机器人列表（约 671、1028 行）；[botsService.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/bots/botsService.ts) 的配置冲突检查（约 278 行）。

### 2. 聊天复用正式任务能力

私聊绑定后可以选项目、任务、模型、思考等级和运行模式，普通消息创建或继续正式任务。远端项目使用稳定 workspace identity 和目标 Environment 的模型视图，断开后显式 `/reconnect`，不会因同路径误回落到本地。

普通提问、工具权限和计划审批都是有请求身份、有状态的正式交互。飞书/Lark 使用原生卡片，Telegram 使用 inline keyboard，微信使用编号文本。支持逐题回答、单选、多选、自定义回答、取消及过期校验；回答进入原请求的响应，而不是依赖下一轮模型猜测数字含义。

官方依据：[命令解析](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/bots/commandParser.ts)；[botsService.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/bots/botsService.ts) 的 elicitation 处理（约 4168 行）、permission_request（5642 行）和 elicitation_request（5726 行）；[官方 bots 文档](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/bots.md)。

### 3. 绑定任务后持续收到跨端输出

支持私聊的 Feishu/Lark、Telegram、微信 Bot 保留绑定任务订阅。一轮结束不会解除订阅，随后从 IM、桌面或 Mobile Web 继续该任务，后续 AI 输出仍能回传。不会额外转发桌面用户输入正文，也不会因订阅而给桌面来源的权限/问答新增 IM 操作授权。

恢复只订阅后续事件，不重放历史，也不为订阅自动建立远端连接。同任务的多个投递目标共享底层事件源，但各自串行消费，失败相互隔离。

官方依据：[单聊持续回传规范](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/bots-private-task-sync.md)；[botsService.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/bots/botsService.ts) 的 reconcilePrivateSynchronization/restorePrivateSynchronization（1399、1417 行）和 persistentPrivate（约 4973 行）。

### 4. 飞书/Lark 群协作及独立话题

绑定 owner 显式启用群后，普通群默认会话与每个话题有独立任务、模型、项目及交互状态。普通群主聊天使用 @ 触发；话题首次接入后可持续接收后续消息，新消息能够停止旧轮并在停止确认后续接。`/stop` 保持话题接入，`/leave` 退出。

首条话题输入可带根引用和历史文本附件；后续按边界补增量。引用、真实发送者及附件进入正式输入材料。历史权限缺失或必要材料准备失败不能残缺执行。群结果默认按终态摘要回推原会话/话题，有授权、投递状态与对账边界。

这里隔离的是会话与任务上下文，同工作区文件仍然共享，不自动创建 worktree。设置页只提供群开关和已记录话题数量，没有完整话题管理器、成员管理器或发送策略编辑器。

官方依据：[群协作当前契约](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/bots-feishu-group-collaboration.md)（约 25 行起）；[话题输入材料](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/bots-topic-input-materials.md)；[BoundGroupsCard](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/ui/src/BotsDialog/BoundGroupsCard.tsx)。

### 5. 附件理解与延后结果投递

图片/音频通过 ZCodePromptAttachment 进入正式输入，是否使用相应多模态能力取决于所选 Agent/模型。普通文件提供文件上下文；群话题材料还走目标运行时的附件寄存，支持远端读取。能下载附件不等于支持任意格式解析。

Bot 来源的 CronCreate 可继承可信投递目标并持久保存，未来自动或手动触发该自动化运行时，先订阅再派发，把终态摘要/失败送回原聊天。目标由服务注入，不是模型自由填写收件人。当前投递 schema 限 Feishu/Lark/Weixin，不能推广为所有渠道，也没有 `/schedule` 或 Bot 管理页的计划任务 CRUD。

官方依据：[botsService.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/services/src/bots/botsService.ts) 的 prepareBotMessageContent（1989 行）和 watchAutomationRun（8053 行）；[automation-port.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/automation-port.ts) 的 create 对 activeBotDeliveryTarget 的传递（136 行）；[cronBotDelivery.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/packages/desktop/src/host/cronBotDelivery.ts) 的 watchCronRunBotDelivery。

## 能力对照

“接近”仅指已核查的代码行为；平台真实可用性另见验证范围。

| 能力 | ZCode 当前能力 | 当前插件 | 判断及用户影响 |
| --- | --- | --- | --- |
| 三渠道基本接入 | 飞书、Telegram、微信；飞书/微信扫码，Telegram Token | 相同主要路径，本地二维码 | 接近；无需为相似接入流程重做架构 |
| Lark / Webhook | Lark 为正式可新增渠道；Webhook 有服务实现，但当前新增 UI 隐藏 | 无对应适配与接入 | Lark 是产品缺失；Webhook 是服务扩展差距，不能说官方向导已开放 |
| 钉钉 / Discord / WeCom | 钉钉即将支持；Discord/WeCom 预留 | 钉钉有底层适配，但 UI 即将支持 | 不应把插件钉钉计作已交付优势，也不能把官方预留项计作落后 |
| 多实例同时运行 | 独立 Bot id、名称、凭据、状态、并行 runtime | 每渠道一组凭据，全局一个活动 channel | 明确缺失；不能同时维持飞书和微信，也不能同渠道多账号 |
| 项目与会话选择 | 正式项目/任务与草稿，目标 Environment 配置 | 项目/会话菜单与自动建会话 | 常用操作接近，但 PI 与 ZCode 的任务语义不同 |
| 模型/思考/运行模式 | 目标模型视图、两级选择、当前任务配置 | providers/list、session/configure，两级菜单 | 基本具备；插件受全局危险操作开关限制 |
| 项目访问范围 | 按 Bot 配置 allowedWorkspaces，支持身份隔离 | 按渠道设置 all/selected，以本地路径筛选 | 本地项目范围接近；没有等价的 Source/远端身份模型 |
| 结构化普通问答 | 原请求单选、多选、自由回答、多题与恢复 | 拦截 asktool，要求模型改成编号文本，等待新消息 | 关键部分实现；缺少正式请求响应闭环 |
| 工具权限确认 | 展示操作摘要，按请求提供允许/拒绝等选项 | 未桥接逐工具 permission；可查看等待状态、切换整体权限模式 | 关键缺失；遇到权限请求仍可能必须回桌面 |
| Plan 审批 | 完整计划、专用交互、自定义回答、请求状态 | 每 5 秒轮询 plans/pending，标题/摘要与批准/拒绝 | 有基本审批，不等价于完整计划审阅和交互 |
| 普通执行回复 | 飞书/Lark 流式卡、三档文本粒度、typing、封卡 | 相同基本机制，卡片预算、节流、退避、开路 | 接近；不应把主要差距定位为“还缺流式卡片” |
| 工具过程与文件变更 | 操作语义摘要、状态、按轮次的文件增删行数 | 工具名/阶段，成功 Edit/Write 路径和文件数 | 部分实现；手机上较难判断具体操作和改动量 |
| 绑定任务跨端回传 | 常驻订阅，跨 IM/桌面/Mobile Web 多轮 | 只对插件派发的 turnBuffers 回合回传 | 明确缺失；桌面继续同会话不会自动等价同步 |
| 已派发任务重载恢复 | 持久绑定、恢复订阅等机制 | 保存 pendingTurns、turnId、消息边界与卡片快照 | 插件已有实质恢复能力；不应再笼统判为完全没有恢复 |
| 附件输入 | 正式 image/audio prompt attachments；文件上下文 | 下载后将类型/文件路径拼到 content 文本 | 部分实现；原生看图/音频能力未接入，依赖 Agent 后续工具读取 |
| 飞书附件类型 | provider 保留附件 kind/文件信息 | feishu.cjs 仅交付 images，bridge 回退为 image | 已确认差异；普通文件/音频可能被标为 image，原文件名未完整保留 |
| 定时任务结果 | Bot 来源 CronCreate 保存投递目标，运行后送原聊天 | 没有该来源元数据、调度结果订阅与投递关联 | 明确缺失；宿主能调度不代表结果会自动回到机器人 |
| 飞书群/话题 | owner 授权、独立话题、历史/引用、输入续接、群投递 | 飞书 adapter 过滤群，bridge 拒绝 group | 整套缺失；不属于单一开关修补 |
| 投递失败恢复 | 错误与连接状态分离，私聊显式重试；群有回执/对账 | deliveryError，内存待发箱；没有显式重试 UI | 部分实现；“已执行”与“手机收到”之间仍需更完整反馈 |
| 微信重启后出站 | 最新 context_token 按账号/用户保存至 CredentialService | contextTokens 为内存 Map | 重启/换 channel 实例后丢失，需要重新获得入站上下文 |
| Agent 主动发文件 | 本次核查的通用 Bot adapter 没有足够证据证明普遍文件上传交付 | 有 /send 和 uploadMedia；send_file_to_phone 声明存在 | 不应虚构官方在此一定更强；插件手动发送有实现，Agent 自动工具闭环待核实 |
| 国际化/主题 | 跟随 app locale，使用宿主主题组件 | 面板和机器人提示主要中文，固定浅色 | 体验范围差距；中文个人使用时优先级较低 |

本地定位：`main.js:67`、`:137`；`renderer/app.js:7`；`lib/bot-commands.cjs:149`；`lib/bridge.cjs:130`、`:174`、`:401`、`:436`、`:454`、`:522`、`:739`、`:880`；`extensions/agent.js:125`、`:148`、`:179`；`lib/feishu.cjs:96`、`:102`；`lib/weixin.cjs:398`、`:466`、`:533`。

## 差距为什么影响实际使用

### 最优先：只靠手机能否完成一轮任务

举例：让 Agent 修改登录流程，Agent 先问单选/多选问题，再申请执行命令，最后要求审阅计划。

ZCode 把这些作为正式请求投递到聊天：选择或输入回答后响应原请求，再继续任务。插件当前只有 Plan/Goal 的基本批准/拒绝链路；普通 asktool 被阻止，改写成文本问题依赖模型遵从，下一条数字只是普通输入；工具权限没有对应的远程批准入口。

建议先补正式 question/permission 响应，而不是通过默认自动批准或整体扩大权限绕开。能否实现及入口形态需要以 PI 当前公开宿主契约为准，不能直接照搬 ZCode 内部 API。

### 第二优先：绑定任务能否持续回传与可靠交付

举例：在手机发起任务，回桌面继续追问，再离开电脑；ZCode 可继续向原私聊发送后续 AI 输出。

插件的 `drainQueue` 为自己派发的任务创建缓冲，结束后删除。`handleAgentEvent` 没有匹配缓冲就返回，`handleHostTurnEnded` 也要求匹配 turnId。因此“有会话关联”不等于“持续订阅该会话”。现有重载恢复解决的是已派发回合，不是跨端永久同步。

建议把长期绑定订阅与单轮执行状态分开，并保留来源授权边界，避免桌面来源的权限请求因订阅自动获得手机审批授权。同时补显式重试、微信出站上下文持久化。不能承诺任意网络失败后严格一次投递。

### 第三优先：附件是否真正到达模型

举例：手机发截图要求找 UI 问题。插件现在会告诉 Agent 图片的本地路径，未把图片作为正式多模态消息字段提交。这可能通过后续文件工具间接完成，但与模型直接收到图片不同；音频同理。

建议先统一飞书/微信/Telegram 附件元数据，再确认 PI 正式附件注入入口。飞书目前还有非图片附件被 images 兼容路径标为 image 的具体问题。附件失败策略也不一致：飞书/微信只记警告后可能继续正文或忽略纯附件；Telegram 临时下载失败保留 update 重试。不能声称三渠道都有完整可靠附件接收。

### 第四优先：按目标决定产品扩展

需要离开电脑后自动收结果时，增加 Bot 来源自动化的目标记录与终态投递。需要同时使用多个平台时，再将 channel 单例提升为独立 Bot 实例。需要团队协作时，再实现群/话题的授权、任务、输入材料与投递状态。

群协作必须保持话题隔离与真实发送者身份，并处理新输入停止续接、历史权限、重复消息与失效审批；直接删除私聊过滤会绕过这些边界。

## 已有实现中应澄清的能力声明

1. **限速函数存在，但未接入运行入口。** `lib/security.cjs:46` 定义 createRateLimiter；全项目检索仅找到定义、导出和测试使用，没有 main/bridge/provider 的运行调用。README 的“每聊天 12 条/分钟”不能算当前真实运行能力。
2. **Agent 主动发文件仍有未闭合项。** `extensions/agent.js:214` 仍使用 `handler`，既有 `docs/zcode-channel-audit.md` 记录真实加载器曾报告 `execute` 契约问题。当前测试 harness 没提供 registerTool，未覆盖该注册。此次没有重验真实加载器，故不能据历史记录直接认定当前宿主必然失败，也不能按声明认定可用；手动 `/send` 应与它分开评价。
3. **项目范围不是原生文件发送沙箱。** `lib/bridge.cjs:383` 只确认绑定会话属于允许项目，随后把用户路径直接交给 uploadMedia；没有在该入口限制发送文件必须属于允许项目。这与经 desktop.control 派发任务的权限边界不同。
4. **net.domains 声明不是 Node 联网沙箱。** 通道通过原生 Node HTTP/SDK 联网，不能把 manifest 域名表解释成宿主对全部流量的强制约束。既有 `docs/bot-channel-parity.md` 末尾已澄清，README 中“严格只访问声明域名”的表述仍需谨慎。
5. **钉钉不是已交付用户能力。** UI 明确 comingSoon，manifest 描述包含它不构成可用性证据。

这些是对当前能力的核对发现，本次未进行全仓安全审计，也未修改或修复上述问题。

## 差异不应全部视作落后

- 微信显式 `/bind`：插件统一授权流程；官方扫码后首条普通消息激活。这是产品选择，显式绑定更清楚，但多一步操作。
- 插件 10 分钟绑定码与官方 UI 约 30 秒有效期：取舍不同，不能单凭时长判定高下。
- 插件私聊忙时保留有限队列：属于额外便利；与 ZCode 的任务 admission、普通群队列和话题停止续接不能简单画等号。当前排队输入不跨重载保存，不能据此称比官方更可靠。
- PI 的 Agent/Plan/Goal、权限模式、desktop.control 与 ZCode 的任务/协议不同；保留宿主既有模型是合理做法。
- 插件正常卸载后的原卡片恢复、轮次边界过滤、短任务完成竞态处理已经有实现和测试，不应因为未移植 ZCode runtime lock 就判定生命周期完全缺失。
- 飞书/Telegram 的手动文件上传是插件明确可用的适配能力；本次没有证据把“Agent 任意生成文件自动送到手机”算作 ZCode 全渠道标准能力。

## 官方资料本身的边界

- `docs/bots.md` 写 Webhook 可从新增列表接入，但当前 `BotsDialog.tsx:1109` 明确过滤 webhook。服务能力与 UI 可达性必须分开。
- `docs/bots.md` 有“只允许私聊”和“only @”的历史说明；当前群/话题专门契约及代码已扩展，不能据旧段落断言不支持群或话题必须每次 @。
- 文档列 `/cli`，但当前 `commandParser.ts` 没有该分支，不能把它计为现成命令。
- Bot command policy 在数据与服务层存在；当前 UI 的注释明确暂不暴露编辑入口，不应说官方有逐项命令开关页面。
- 没有独立“测试连接”按钮，不应把运行状态检查等同于用户可触发的连接测试。
- 官方控制流/组件/E2E 测试与真实飞书/Lark/微信租户、真手机验收分开记录。部分文档明确真实平台或 OS 验证尚未完成，不能因官方实现更完整就宣称所有场景已实测稳定。

## 验证结果与未覆盖范围

本次实际执行：`node --test 'test/*.test.cjs'`，188 项通过，0 失败，0 跳过，退出码 0。测试临时环境设为本会话 scratch；日志保存在会话 scratch。测试覆盖现有消息派发、菜单、卡片、通道、绑定、审批、附件、生命周期和已派发回合恢复。

本次没有运行 ZCode 全仓构建/测试，没有启动两边真实应用进行逐页面操作，没有向真实聊天平台发送测试消息，也没有重新扫码或创建定时任务。官方能力判断以固定源码、专门规范和测试代码为证；本地可用性以源码与本次测试为证，不替代平台端到端验收。

无阻碍完成本次分析的剩余问题。实现上述差距时，结构化问答/工具权限/正式附件/持续事件流是否有可用的 PI 公开宿主接口，仍需单独核实；这是实施边界，不是当前已证明的宿主缺陷。
