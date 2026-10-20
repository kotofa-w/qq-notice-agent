# Windows运行说明

通用安装步骤见[安装指南](../../docs/GETTING_STARTED.md)，项目能力与限制见[根README](../../README.md)。

需要PowerShell 7、Node.js 22+、Python 3.10+、独立登录的兼容模型CLI以及配置完成的OneBot桥。SDK依赖固定在`modules/workbuddy-agent/requirements.txt`。CLI路径通过私有配置`WB_AGENT_CLI`指定，使用已登录的官方完整CLI，不把桌面端登录等同于无头CLI登录。

网关在`127.0.0.1:3789`提供面板和`/api/onebot/event`回调，OneBot地址与双方令牌由私有环境文件配置。账号、登录与桥兼容性需要自己核对。local文件传输要求桥与网关能读取同一主机的文件；Docker适配需明确配置已有容器。

前台启动不安装登录任务；后台运行脚本需要另外准备`runtime/private`下的本机配置，DPAPI只适用于原Windows用户。克隆源码不会复制登录、自启动、密钥或会话。

历史基线、消息投递、模型会话与日历状态独立验证。首次连接仅建立可靠基线并生成有限预览，补漏必须人工确认。真实消息发送、日历写入和手机提醒不属于离线测试。
