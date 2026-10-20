param(
    [string]$RuntimeRoot = $PSScriptRoot,
    [string]$QQPath = 'C:\Program Files\Tencent\QQNT\QQ.exe',
    [string]$FrameworkRoot, [string]$BridgeRoot, [string]$ConfigurationPath,
    [ValidateRange(1,60)][int]$HubAttempts = 15, [string]$MutexName
)
$ErrorActionPreference = 'Stop'
$startArguments = @{}
foreach ($key in $PSBoundParameters.Keys) { $startArguments[$key] = $PSBoundParameters[$key] }
. (Join-Path $PSScriptRoot 'run-qq-desktop-bridge.ps1') -RuntimeRoot $RuntimeRoot -QQPath $QQPath -FrameworkRoot $FrameworkRoot -BridgeRoot $BridgeRoot -ConfigurationPath $ConfigurationPath

function Test-QqNoticeHub($Settings) {
    try {
        $null = Invoke-RestMethod -Uri "$($Settings.HubUrl)/api/state" -Headers @{Authorization="Bearer $($Settings.HubToken)"} -TimeoutSec 2
        return $true
    } catch { return $false }
}

function Start-QqNoticeHub($Settings) {
    & (Join-Path $Settings.RuntimeRoot 'runtime-control.ps1') -Action Start | Out-Null
}

function Invoke-QqNoticeStart {
    param([string]$RuntimeRoot = $PSScriptRoot, [string]$QQPath = 'C:\Program Files\Tencent\QQNT\QQ.exe',
        [string]$FrameworkRoot, [string]$BridgeRoot, [string]$ConfigurationPath,
        [ValidateRange(1,60)][int]$HubAttempts = 15, [string]$MutexName)
    if (-not $MutexName) {
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($RuntimeRoot).ToLowerInvariant())))
        $MutexName = 'Local\WorkBuddyQQNotice-' + $hash.Substring(0,24)
    }
    $mutex = [Threading.Mutex]::new($false,$MutexName)
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { return @{status='already-starting';loginVerified=$false;message='QQ 消息通知正在启动，请稍候查看 QQ 窗口和面板。'} }
        $settings = Get-QqBridgeSettings -RuntimeRoot $RuntimeRoot -QQPath $QQPath -FrameworkRoot $FrameworkRoot -BridgeRoot $BridgeRoot -ConfigurationPath $ConfigurationPath
        if (-not (Test-QqNoticeHub $settings)) {
            Start-QqNoticeHub $settings
            $ready = $false
            for ($tick=0; $tick -lt $HubAttempts; $tick++) {
                Start-Sleep -Seconds 1
                if (Test-QqNoticeHub $settings) { $ready=$true; break }
            }
            if (-not $ready) { throw 'Hub 启动等待超时；请检查 runtime/private/runtime-state.json。' }
        }
        return Invoke-QqDesktopBridge $settings
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-QqNoticeStart @startArguments
    Write-Output $result.message
}
