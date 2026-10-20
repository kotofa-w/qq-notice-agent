# NapCat Framework接入说明

本仓库不附带NapCat、QQ安装文件、登录状态或第三方补丁。请从[NapCat官方发布](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.33)及[官方Framework说明](https://napneko.github.io/guide/boot/Framework)准备与QQ兼容的版本，核对对应版本文档。

Framework在桌面QQ会话中提供OneBot接口。网关建议在本机启用带令牌的HTTP API，并设置到网关`/api/onebot/event`的鉴权回调；账号须与私有配置中的BOT一致。

`runtime/start-qq-with-notices.ps1`是完成本机配置后的可选统一入口，先核对Hub和采集连接。它需要配套运行脚本、受保护配置及自己准备的Framework/桥目录，并非第三方软件安装器。QQ路径、Framework目录、桥目录和配置路径可通过参数指定。

外部桥模式使用`CODEX_REMOTE_CONTACT_QQ_BRIDGE_MODE=external`，Hub运行管理不接管外部桌面QQ。不要同时运行占用相同端口或账号的另一份桥。没有配置后台运行时，请按[安装指南](../../docs/GETTING_STARTED.md)启动前台网关。
