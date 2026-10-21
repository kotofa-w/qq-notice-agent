# QQ Notice Agent

在 Windows 上把 QQ 群通知整理成摘要，并将原文时间明确、经授权的事项同步到 CalDAV 日历。网关还提供独立的群聊和私聊 Agent 会话、网页控制台、图片与文件工具、表情库和 QQ 空间功能。

默认引擎为 WorkBuddy / CodeBuddy，QQ 接入依赖另行安装的兼容 OneBot 桥。通知来源与回复目标分别授权：只读来源只用于采集，摘要发往已配置的目标会话。

这是从开发工程导出的公开源码快照，使用新的提交历史。第三方软件、账号登录、模型额度和日历服务需要自行准备；首次安装需完成配置和本机验收。代码来源与许可尚有待明确之处，见下方[许可说明](#来源与许可)。

## 主要能力

| 能力 | 范围 |
| --- | --- |
| 通知订阅 | 每个目标独立收取、等待安静窗口、生成摘要和投递，持久保存队列与处理结果 |
| 通知负责人 | 按来源群人工指定负责人，发现候选、核对证据和处理不确定内容；候选不会自动获得资格 |
| 日程筛选 | 每订阅设置群类型、事项类别、确认时间和超时策略；支持候选编号、人工批准、拒绝、更正和撤销 |
| 历史补漏 | 手动选择时段、分页扫描、持久去重和原文预览，人工选择后复用通知处理链 |
| 连接恢复扫描 | 观测采集连接，启动或恢复后有限扫描历史，只生成待确认预览 |
| Agent 会话 | 群聊和私聊分别持久续接，按会话设置模型、工具权限与日历授权 |
| 辅助工具 | 当前会话 MCP、受控文件与图片发送、表情库，以及需单独配置和授权的 QQ 空间任务 |

```text
QQ / OneBot 桥 → 来源消息 → 持久去重与订阅队列 → 模型整理 → 已授权目标
                                                        ↓
                                              日程候选 → 确认策略 → CalDAV

手动选时段 / 连接恢复 → 历史扫描 → 原文预览 → 人工选择与确认 → 原通知队列
```

### 日程如何确认

默认采用“其他群／人工确认”，确认时长为10分钟。选择课程群且未指定超时策略时，设置会转为超时自动写入；只有时间证据充分、事项类别允许、所有写入权限仍有效的候选才符合自动处理条件。自愿或条件性事项、更正与取消需要人工确认。

确认时间从 QQ 通知成功送达后开始。OWNER 可回复 `是 C000001` 或 `否 C000001`，也可在“设置与用量 → 日程筛选管理”操作；存在多个候选时需要明确编号。普通策略冻结于新候选，日程开关会暂停待执行写入，QQ 通知继续。

模糊时间和已过期事项不会因人工批准而变成有效日程。修改或删除既有日历事项时会检查归属、内容指纹和 ETag；出现外部修改冲突时保留人工处理。重启后，结果未知的写入先用同一事项身份核对，再决定恢复动作。

### 补漏的范围

手动补漏默认回看48小时，最多7天，每批最多500条、40页，每轮最多3页。预览保留原发送时间，列出重复项、停止原因和覆盖提示。默认不勾选消息，也不授予历史日历写入；需要人工核对并确认。

自动扫描每30秒观测采集连接，采用2分钟重叠、最多48小时回看，每个目标的自动扫描总预算为3页，重启后仍受此限制。空页、重复页、截断或元数据缺口保留为部分结果，后续由人工继续。新机器从首次可靠基线开始记录，不能据此保证找回安装前的历史通知。

QQ 桥不可达、账号不符与 QQ 离线是不同状态。Hub 未观测区间无法证明 QQ 持续离线；超过自动窗口的前段也不会被标作完整覆盖。**自动扫描只生成预览，不自动确认、发送 QQ 或创建日历。**

## 安装入口

需要 Windows、PowerShell 7、Node.js 22+、Python 3.10+，以及已安装并独立登录的兼容官方 CLI、兼容 OneBot QQ 桥。管理员 OWNER 与机器人 BOT 使用不同账号。

先获取源码；已有仓库可跳过克隆，进入自己的仓库根目录：

```powershell
git clone https://github.com/kotofa-w/qq-notice-agent.git
Set-Location .\qq-notice-agent
```

没有 Git 时可选择 **Code → Download ZIP**，解压后在仓库根目录打开 PowerShell 7。然后执行：

```powershell
Set-Location .\workbuddy-qq-agent-gateway
& .\modules\workbuddy-agent\setup.ps1
if (Test-Path -LiteralPath .\config\qq-only.env) {
    throw 'config/qq-only.env 已存在，请保留并编辑现有配置。'
}
Copy-Item .\config\qq-only.windows.env.example .\config\qq-only.env
# 编辑 qq-only.env：填写账号、令牌、OneBot 地址和官方 CLI 路径
& .\modules\run-qq-only.ps1
```

复制配置前先确认目标文件不存在，保留已有配置。安装脚本会创建 Python 虚拟环境并下载依赖；它不会替你安装 QQ 桥或完成 CLI 登录。启动后打开本机面板 `http://127.0.0.1:3789/client.html`，使用自己的 Hub 令牌登录。

完整步骤、回调配置和首次验收见[安装与首次运行](docs/GETTING_STARTED.md)。

## 文档与目录

| 入口 | 内容 |
| --- | --- |
| [安装与首次运行](docs/GETTING_STARTED.md) | 环境、私有配置、OneBot 回调、CalDAV 和排错 |
| [网关说明](workbuddy-qq-agent-gateway/README.md) | 会话、工具、演示和开发命令 |
| [安全说明](SECURITY.md) | 权限边界、数据去敏和问题报告 |
| [文件索引](docs/FILE_INDEX.md) | 当前公开快照的文件入口 |
| [发布说明](docs/PUBLICATION.md) | 快照来源、去敏范围与发布边界 |
| [来源与许可证说明](LICENSE-NOTICE.md) | 上游来源及许可现状 |

应用源码、测试与前端位于 `workbuddy-qq-agent-gateway/`。个人配置、令牌、登录数据、消息记录、运行目录和虚拟环境应保留在本地，并检查 Git 忽略规则。

## 验证与限制

本仓库提供隔离测试和合成数据演示。测试通过只能说明对应代码检查通过，不能替代你自己的 QQ 桥、CLI、CalDAV、真实通知提取及手机提醒验收。公开快照不附带任何机器的部署成功声明。

安装 Python 依赖后，可在 `workbuddy-qq-agent-gateway/` 目录运行与仓库 CI 对应的检查：

```powershell
npm test
& .\modules\workbuddy-agent\.venv\Scripts\python.exe -X utf8 .\test\workbuddy-bridge-recovery.test.py
& .\modules\workbuddy-agent\.venv\Scripts\python.exe -X utf8 .\modules\workbuddy-agent\test_image_processing.py
npm run audit:public
```

`audit:public` 检查 Git 索引中的已跟踪内容，需要完整 Git 仓库；Download ZIP 不包含 Git 索引。它不能替代对本机未跟踪配置或待分享日志的人工检查。

历史接口由 QQ 桥提供，媒体、撤回消息、跨版本身份和长时间离线的覆盖可能不完整。模型可能误判通知或时间；应核对原文与候选。发送成功的 QQ 消息不具备事务回滚保证，日历冲突不会被强制覆盖。第三方接口更新可能需要适配。

普通聊天可调用发送及本机工具；“完全访问”权限允许 Agent 访问电脑。只向可信目标授予必要权限，按[安全说明](SECURITY.md)管理面板、桥服务与本地数据。

## 来源与许可

项目直接衍生自 [DrivingGodJ/workbuddy-qq-agent-gateway](https://github.com/DrivingGodJ/workbuddy-qq-agent-gateway)，其中包含源自 [Epic0522/Codex-Remote-Contact](https://github.com/Epic0522/Codex-Remote-Contact) 的代码，保留相关来源与署名。已核对的上游许可信息包含未声明许可证和 `NOASSERTION / Other`，尚不足以确认整仓代码的完整使用、再分发或商业授权。

本仓库以**公开源码版**提供，不擅自给整仓添加 MIT、Apache 等许可证。公开可查看不等于已取得完整开源许可；使用、修改或分发前，请阅读[来源与许可证说明](LICENSE-NOTICE.md)，确认相关权利。外部软件与依赖继续适用各自条款。
