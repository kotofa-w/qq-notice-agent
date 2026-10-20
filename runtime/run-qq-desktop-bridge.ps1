param(
    [string]$RuntimeRoot = $PSScriptRoot,
    [string]$QQPath = 'C:\Program Files\Tencent\QQNT\QQ.exe',
    [string]$FrameworkRoot, [string]$BridgeRoot, [string]$ConfigurationPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-credentials.ps1')

function Get-QqBridgeSettings {
    param([string]$RuntimeRoot = $PSScriptRoot, [string]$QQPath = 'C:\Program Files\Tencent\QQNT\QQ.exe',
        [string]$FrameworkRoot, [string]$BridgeRoot, [string]$ConfigurationPath)
    if (-not $FrameworkRoot) { $FrameworkRoot = Join-Path $RuntimeRoot 'napcat-framework-v4.18.33\prepared' }
    if (-not $BridgeRoot) { $BridgeRoot = Join-Path $RuntimeRoot 'napcat-v4.18.33\napcat' }
    if (-not $ConfigurationPath) { $ConfigurationPath = Join-Path $RuntimeRoot 'private\qq-only.env.dpapi' }
    $values = Get-RuntimeEnvironment -Path $ConfigurationPath
    $botQQ = $values['CODEX_REMOTE_CONTACT_BOT_QQ_ID']
    if ($botQQ -notmatch '^[1-9][0-9]{4,11}$') { throw '受保护配置中的 BOT QQ 账号无效。' }
    if ($values['CODEX_REMOTE_CONTACT_QQ_BRIDGE_MODE'] -ne 'external') { throw '请先将受保护配置的 QQ bridge mode 设为 external。' }
    $onebotUrl = if ($values['ONEBOT_API_BASE']) { $values['ONEBOT_API_BASE'].TrimEnd('/') } else { 'http://127.0.0.1:3000' }
    $uri = [Uri]$onebotUrl
    if ($uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1','localhost','[::1]','::1') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'OneBot 必须使用本机 HTTP 根地址。' }
    if (-not $values['ONEBOT_ACCESS_TOKEN'] -or -not $values['CODEX_REMOTE_CONTACT_API_TOKEN']) { throw '受保护配置缺少本机连接凭据。' }
    $onebotConfig = Join-Path $BridgeRoot "config\onebot11_$botQQ.json"
    if (-not (Test-Path -LiteralPath $onebotConfig -PathType Leaf)) { throw "BOT 对应的 OneBot 配置不存在：$onebotConfig" }
    $config = Get-Content -LiteralPath $onebotConfig -Raw | ConvertFrom-Json
    $servers = @($config.network.httpServers | Where-Object { $_.enable -and $_.host -in @('127.0.0.1','localhost','::1') -and [int]$_.port -eq $uri.Port -and $_.token -eq $values['ONEBOT_ACCESS_TOKEN'] })
    if ($servers.Count -ne 1) { throw 'BOT 的 OneBot 服务地址或凭据与受保护配置不一致。' }
    return @{
        RuntimeRoot=$RuntimeRoot; QQPath=$QQPath; FrameworkRoot=$FrameworkRoot; BridgeRoot=$BridgeRoot
        PrivateRoot=(Join-Path $RuntimeRoot 'private'); BotQQ=$botQQ; OneBotConfig=$onebotConfig
        Launcher=(Join-Path $FrameworkRoot 'napimain.exe'); Library=(Join-Path $FrameworkRoot 'napiloader.dll')
        Script=(Join-Path $FrameworkRoot 'nativeLoader.cjs'); OneBotUrl=$onebotUrl; OneBotToken=$values['ONEBOT_ACCESS_TOKEN']
        HubUrl='http://127.0.0.1:3789'; HubToken=$values['CODEX_REMOTE_CONTACT_API_TOKEN']
    }
}

function Test-QqBridgeConnection($Settings) {
    $headers = @{Authorization="Bearer $($Settings.OneBotToken)"}
    try { $login = Invoke-RestMethod -Uri "$($Settings.OneBotUrl)/get_login_info" -Headers $headers -TimeoutSec 2 } catch { return $false }
    if ($login.status -ne 'ok') { return $false }
    $identity = if ($login.data.user_id) { $login.data.user_id } else { $login.data.self_id }
    if ([string]$identity -ne $Settings.BotQQ) { throw '当前 OneBot 登录账号与受保护配置不一致；请核对 QQ 登录账号。' }
    try { $status = Invoke-RestMethod -Uri "$($Settings.OneBotUrl)/get_status" -Headers $headers -TimeoutSec 2 } catch { return $false }
    return $status.status -eq 'ok' -and $status.data.online -eq $true -and $status.data.good -ne $false
}

function Get-QqDesktopProcesses($Settings) {
    return @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object ExecutablePath -EQ $Settings.QQPath)
}

function Invoke-QqDesktopBridge($Settings) {
    if (Test-QqBridgeConnection $Settings) { return @{status='connected';loginVerified=$true;message='现有 QQ Framework 连接已核验，未重复启动。'} }
    if (@(Get-QqDesktopProcesses $Settings).Count) { throw 'QQ 正在运行但 Framework 尚未连接。请从托盘正常退出 QQ，再使用已配置的桌面 QQ 入口启动；不会强制结束 QQ。' }
    foreach ($path in @($Settings.QQPath,$Settings.Launcher,$Settings.Library,$Settings.Script,$Settings.OneBotConfig,(Join-Path $Settings.BridgeRoot 'napcat.mjs'))) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Framework 所需文件缺失：$path" }
    }
    $saved = @{}
    $overrides = @{
        NAPCAT_WORKDIR=$Settings.BridgeRoot; NAPCAT_MAIN_PATH=$Settings.Script.Replace('\','/')
        NAPCAT_INJECT_PATH=$Settings.Library; NAPCAT_LAUNCHER_PATH=$Settings.Launcher
    }
    $errorLog = Join-Path $Settings.PrivateRoot 'qq-framework-launch.error.log'
    try {
        foreach ($key in $overrides.Keys) {
            $saved[$key] = [Environment]::GetEnvironmentVariable($key,'Process')
            [Environment]::SetEnvironmentVariable($key,$overrides[$key],'Process')
        }
        try {
            $process = Start-Process -FilePath $Settings.Launcher -ArgumentList @(('"'+$Settings.QQPath+'"'),('"'+$Settings.Library+'"'),('"'+$Settings.Script.Replace('\','/')+'"')) `
                -WorkingDirectory $Settings.FrameworkRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $Settings.PrivateRoot 'qq-framework-launch.log') -RedirectStandardError $errorLog
        } catch { throw "Framework 启动失败；请检查文件权限与启动路径。日志位置：$errorLog" }
        @{ launcherPid=$process.Id; launchedAt=[DateTimeOffset]::Now.ToString('o'); qqPath=$Settings.QQPath
           mode='framework'; configurationRoot=$Settings.BridgeRoot; loginVerified=$false } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Settings.PrivateRoot 'qq-framework-process.json') -Encoding utf8
        Start-Sleep -Seconds 2
        if ($process.HasExited -and ($process.ExitCode -ne 0 -or -not @(Get-QqDesktopProcesses $Settings).Count)) { throw "Framework 启动器提前退出（exit=$($process.ExitCode)）；请检查 $errorLog" }
        if (Test-QqBridgeConnection $Settings) { return @{status='connected';loginVerified=$true;message='QQ Framework 连接和账号已核验。'} }
        return @{status='launch-requested';loginVerified=$false;message='已请求启动 QQ Framework，尚未确认连接。请在 QQ 窗口完成登录后查看面板连接状态。'}
    } finally {
        foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key],'Process') }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    # The legacy entry uses the same readiness check and duplicate-launch guard.
    & (Join-Path $PSScriptRoot 'start-qq-with-notices.ps1') @PSBoundParameters
}
