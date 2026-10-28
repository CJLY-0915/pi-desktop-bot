# 微信 iLink 请求兼容性与 HTTP 412

0.1.7 实机反馈：首轮 `/getupdates` 成功、面板出现绑定命令，之后拉取返回 HTTP 412。首次成功不能作为持续收发验收通过的依据。

## 已核实及 0.1.8 的修正

- 公共 HTTP 客户端原来分开调用 `req.write(body)` 与 `req.end()`，在未指定长度时使用 chunked。改为 `req.end(body)`，由 Node 为完整字符串/Buffer 生成正确长度。真实本地 HTTP 服务验证中文、emoji、二进制及空 body 的长度和字节完整性。严格拒绝 chunked 的本地网关测试在修改前返回 412，修改后通过；这仅证明报文兼容性，不能证明微信真实 412 一定由此产生。
- 微信消息接口缺少公开客户端使用的 `iLink-App-Id` 和 `iLink-App-ClientVersion`。登录原来只发版本 `1`。登录与消息请求现在使用相同应用头：公开 bot 应用标识和 `major<<16 | minor<<8 | patch` 编码的本插件通道版本。通道版本仍是原有 `2.0.0`，没有冒充参考包版本。
- 连续失败不再始终每两秒请求；采用 2/2/30 秒退避循环，成功后重置。失败时不清空游标、不推进游标，也不误标记消息投递失败。已接收但处理失败的批次仍按原逻辑保留和重试。
- HTTP 非 200 时，若存在 JSON 的 ret/errcode/errmsg/message，保留脱敏后的错误信息，说明截断至 300 字符。不展示 HTML、完整响应体、令牌、上下文或 URL。

## 公开依据

对照腾讯署名的公开 npm 包 `@tencent-weixin/openclaw-weixin@2.4.10`：

- [api.ts](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.10/src/api/api.ts)：版本编码 95–107 行；公共应用头 227–253 行；字符串 body 的 fetch 请求 389–425 行；getupdates 444–485 行。
- [package.json](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.10/package.json)：公开 ilink_appid 为 `bot`。
- [monitor.ts](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.10/src/monitor/monitor.ts)：失败重试与 30 秒退避。

这些是公开客户端的实现证据，不等同服务端强制规范。该客户端用 fetch 处理 body 长度，没有给 HTTP 412 专门分支或定义；其令牌过期判据是协议 ret/errcode 为 -14，不能把所有 HTTP 412 解释为令牌过期。

## 验证与未确认范围

本地请求级回归覆盖首轮成功、随后连续三次 HTTP 412、再次成功、下一次失败时重置重试计数；检查真实接收的请求头、Content-Length、非 chunked、游标连续性、连接状态、脱敏和重试时间。测试只使用回环 HTTP 服务，不读取真实凭据或聊天、不向微信发送验收消息。

本机同时启用了另一个微信机器人插件，这仅是运行环境事实。未读取其账户配置，不能证明两个插件使用同一机器人，也不能断言并发轮询导致 412。若用户知道两个插件连接同一个机器人，可先只保留一个连接作对照；插件不会擅自停止其他插件。

尚未确认微信实际拒绝原因、服务端并发限制及真实平台恢复。发布继续执行全量测试、PluginCheck/PluginPack 和最终安装包无 node_modules 的加载检查。

0.1.8 微信请求改动完成时全量 276 项测试通过，其中相关请求/微信回归 60 项通过；合并后续飞书最终答复与过程折叠修复后，全量 282 项测试通过，0 失败、0 跳过。30 个实现文件及 Agent 扩展语法检查通过，四处版本号一致。
