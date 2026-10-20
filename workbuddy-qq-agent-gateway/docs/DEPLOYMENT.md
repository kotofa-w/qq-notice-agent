# Windows 部署补充说明

网关默认 127.0.0.1:3789，OneBot API 默认 127.0.0.1:3000。前台启动与 CLI 安装见 [Windows 启动说明](WINDOWS.md)。使用已有私有配置，不覆盖 QQ 登录数据、人格、会话或订阅。

## 本机与容器

Windows 默认使用 local 文件传输，OneBot 与网关需共享同一主机可读文件。可显式选择 Docker 并配置实际可执行文件、context 和已有容器；未指定 context 时使用 Docker 当前 context。Linux 容器 staging 保留专用临时前缀，结束后只清理副本，用户原件不动。私聊文件需要 local 桥。

容器 localhost 指向容器自身，回调应使用桥可达的 Windows 宿主地址。保留 Authorization Bearer 或 X-Signature HMAC-SHA1 校验；不同桥的 HTTP token 与回调签名 secret 需按对应设置核对。

## 登录后启动与日历

仓库根目录的可选 runtime 脚本提供当前用户登录任务、DPAPI 配置和 Start/Stop/Status，需要自行完成本机初始化；详见 [Windows 启动说明](WINDOWS.md)。已有实例时不重复启动。面板在线与 QQ 在线分别检查。

日历 provider 只接受 caldav 或 none。显式配置可写 HTTPS 日历 URL 和凭据后，在目标会话开启自动化；有明确时间依据的待办和日程写成带提醒的 CalDAV 事件。未配置时关闭能力。不要在 CI 或离线验收中写入真实日历。

## 费用与排障

聊天、通知、表情标注和空间任务可能消耗模型额度。总开关关闭仍记录消息但不启动新模型请求。按面板的 Hub、OneBot、引擎及任务错误排查；日志可能含私人聊天，勿公开上传。发送结果不确定先核对 QQ，避免重复外部动作。
