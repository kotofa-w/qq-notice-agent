# 安装与首次运行

本文面向新的 Windows 环境，使用通用前台启动脚本。已有个人部署的后台任务、登录入口或加密配置需自行衔接，不会随源码复制到新机器。

## 准备环境

- Windows 和 PowerShell 7，后续命令在 PowerShell 7 中运行。
- Node.js 22+、Python 3.10+，可通过 `node --version`、`python --version` 检查。
- 独立安装并完成登录的兼容官方 WorkBuddy / CodeBuddy CLI。桌面应用已登录不代表 CLI 已登录；先在交互终端确认 CLI 本身可以工作。
- 兼容 OneBot HTTP API 和事件上报的 QQ 桥，以及用于机器人登录的账号。仅安装官方 QQ 不会提供 OneBot 接口。
- 用于管理和确认的 OWNER 账号，与 BOT 账号不同。模型请求使用你自己的账号额度。

Python 安装脚本会依据[依赖清单](../workbuddy-qq-agent-gateway/modules/workbuddy-agent/requirements.txt)安装 SDK 与图片处理依赖。现有适配针对兼容 CLI 能力编写，旧版或桌面内置的不完整 CLI 包可能无法工作。安装方式与版本还应核对官方 CLI 文档；不要复制别人的登录文件或令牌。

## 1. 安装网关依赖

获取源码后，进入嵌套的网关目录。以下命令以仓库根目录为起点：

```powershell
Set-Location .\workbuddy-qq-agent-gateway
& .\modules\workbuddy-agent\setup.ps1
```

脚本创建 `modules/workbuddy-agent/.venv/` 并安装依赖，不安装 QQ、OneBot 桥或官方 CLI。已有不完整或其他平台的虚拟环境时，先按报错备份处理，不直接覆盖。

Python 不在 PATH 时，可用 `-Python 'C:/path/to/python.exe'` 指定。文中的 `C:/path/to/` 均为占位路径，需换成自己的安装位置。

## 2. 创建本地配置

先确认 `config/qq-only.env` 不存在，再复制模板，避免覆盖现有配置：

```powershell
Copy-Item .\config\qq-only.windows.env.example .\config\qq-only.env
```

编辑该文件，填写以下字段。实际值留在本机，不写入公开 Issue、截图或提交。

| 字段 | 配置要求 |
| --- | --- |
| `CODEX_REMOTE_CONTACT_OWNER_QQ_ID` | 管理员账号 |
| `CODEX_REMOTE_CONTACT_BOT_QQ_ID` | QQ 桥实际登录的机器人账号，不能与 OWNER 相同 |
| `CODEX_REMOTE_CONTACT_API_TOKEN` | 自行生成的 Hub 管理及事件鉴权密钥，保持默认鉴权开启 |
| `ONEBOT_API_BASE` | 自己的 OneBot HTTP API 地址；同机模板使用 `http://127.0.0.1:3000` |
| `ONEBOT_ACCESS_TOKEN` | 与 QQ 桥 HTTP API 服务端一致的访问令牌 |
| `WB_AGENT_CLI` | 已安装、已登录官方 CLI 的入口路径；可为支持的 Node 脚本或原生可执行文件 |
| `CODEX_REMOTE_CONTACT_QQ_FILE_TRANSPORT` | 同机文件传输使用 `local`，桥与网关需能读取同一台机器的文件 |

`WB_AGENT_CLI` 不要指向 `.cmd/.bat` 包装器；Node 脚本入口应指向包内实际 `bin/codebuddy`。若 CLI 版本不兼容，应按错误检查其能力，不能只以文件存在作为安装成功依据。

配置采用 Node 的 `--env-file` 语法，不是 PowerShell 脚本。Windows 路径建议用正斜杠，并为含空格的值加引号。当前进程已有的同名环境变量优先于配置文件，排错时同时检查两处。

模板中的临时目录和 URL 是示例。容器部署需明确配置文件传输、容器可达的宿主地址及桥扩展接口；当前指南先覆盖同机运行。

## 3. 配置 OneBot 桥

按所选桥的文档启用 HTTP API 和消息事件上报，并完成 BOT 账号登录。核对其 `get_login_info` 返回的账号与 `CODEX_REMOTE_CONTACT_BOT_QQ_ID` 一致。

默认同机回调地址为：

```text
http://127.0.0.1:3789/api/onebot/event
```

桥的 HTTP API 访问令牌与 `ONEBOT_ACCESS_TOKEN` 一致；事件上报按桥的支持方式配置 Hub 鉴权。使用 OneBot HMAC-SHA1 签名时，上报密钥与 `CODEX_REMOTE_CONTACT_API_TOKEN` 一致。两种令牌用途不同，不要因回调失败关闭整个 Hub 鉴权。

桥、网关和回调地址必须彼此可达。`127.0.0.1` 只指当前网络环境；桥在容器或其他机器时不能直接套用同机地址。不要将管理面板和 QQ 桥直接映射到公网。

## 4. 启动与首次检查

在网关目录执行：

```powershell
& .\modules\run-qq-only.ps1
```

该脚本前台运行，`Ctrl+C` 停止网关。它不安装自启动任务，不负责自动登录 QQ。Node 不在 PATH 时可传 `-Node 'C:/path/to/node.exe'`；已有独立配置文件时用 `-EnvFile 'C:/path/to/qq-only.env'`。仅从进程环境注入配置时，传 `-EnvFile ''`。

打开 `http://127.0.0.1:3789/client.html`，输入自己的 Hub 令牌。若修改了监听端口，使用对应地址。Hub 页面可打开只说明网页服务可访问，还需要在诊断中核对 QQ 桥及账号。

首次启用建议按实际效果检查：

1. 在明确授权的目标会话测试一条文字消息，核对权限、模型和回复目标。
2. 配置一个只读通知来源及订阅，确认通知送往指定目标，来源群不被回复。
3. 停止并重新启动网关，确认同一目标会话和已有状态可恢复。
4. 按需测试图片、文件、历史预览或日历；只启用已核对的功能。

这些步骤会在你自己的环境产生真实模型调用或 QQ 消息。运行前选择合适的测试目标；没有完成的检查应保留为未验收。

## 5. 日程和历史补漏

日历功能需要额外配置 HTTPS CalDAV 可写日历、用户名和密码：

```text
CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER=caldav
CODEX_REMOTE_CONTACT_CALDAV_URL=https://calendar.example.invalid/path/to/calendar/
CODEX_REMOTE_CONTACT_CALDAV_USERNAME=YOUR_USERNAME
CODEX_REMOTE_CONTACT_CALDAV_PASSWORD=YOUR_PASSWORD
CODEX_REMOTE_CONTACT_CALDAV_CALENDAR_NAME=Calendar
CODEX_REMOTE_CONTACT_CALDAV_REMINDER_MINUTES=30
```

以上均为占位值，不能直接使用。通用启动脚本从进程环境或私有 env 文件读取用户名和密码；模板中的凭据文件选项需要相应部署入口主动解密并注入，不会被通用脚本自动导入。未配置日历提供者时日历能力关闭；配置后还需核对目标会话授权与每订阅策略。

在“设置与用量 → 日程筛选管理”选择订阅。默认人工确认，10分钟从 QQ 通知送达后起计；课程群可配置超时自动写入。自愿、条件性、更正和取消事项仍需人工确认。验证日历时检查实际事件、时间、提醒属性和冲突处理；手机是否弹窗取决于同步客户端和系统设置，需另行验收。

已启用订阅旁的“补漏”支持手动时段和自动恢复预览。新环境从首次可靠基线记录连接，自动回看最多48小时、2分钟重叠、每目标总预算3页。仅生成原文预览，默认不选旧消息或日历；确认后才进入原处理链。空页、重复页或超过范围显示部分覆盖，不表示已经补齐全部通知。

## 演示与排错

不接 QQ 或模型时，可在网关目录运行 `npm run demo`，打开 `http://127.0.0.1:3790/client.html`。演示使用合成状态，不能证明你的真实连接或日历可用。

| 现象 | 优先检查 |
| --- | --- |
| 启动缺少账号或令牌 | 私有 env 是否填写，进程环境是否覆盖了文件值 |
| 面板可用但桥未连接 | OneBot 地址、API 令牌、实际登录账号、桥是否启动 |
| QQ 已登录但无消息 | 事件回调地址、签名密钥、来源或目标授权 |
| CLI 启动或认证失败 | 实际入口路径、官方 CLI 独立登录、版本能力和 Python SDK 安装 |
| 文件无法发送 | 同机文件访问及 `local` 传输条件，或容器挂载与传输配置 |
| 日历没有写入 | 提供者与凭据、目标授权、订阅策略、原文证据、候选状态和过期判断 |
| 补漏显示部分结果 | 停止原因、基线、窗口、页数上限及上游历史接口可用性 |

公开求助只提供经过人工去敏的错误、版本和合成复现步骤，见[安全说明](../SECURITY.md)。完整工具与模块说明见[网关 README](../workbuddy-qq-agent-gateway/README.md)。
