param(
    [Parameter(Mandatory)][ValidatePattern('^[1-9][0-9]{4,11}$')][string]$OwnerQQ,
    [Parameter(Mandatory)][ValidatePattern('^[1-9][0-9]{4,11}$')][string]$BotQQ
)
$ErrorActionPreference = 'Stop'
if ($OwnerQQ -eq $BotQQ) { throw 'OWNER and BOT must be separate accounts.' }
$workspace = Split-Path $PSScriptRoot -Parent
$privateRoot = Join-Path $PSScriptRoot 'private'
$napcatConfig = Join-Path $PSScriptRoot 'napcat-v4.18.33\napcat\config'
$envFile = Join-Path $privateRoot 'qq-only.env'
$accountConfig = Join-Path $napcatConfig "onebot11_$BotQQ.json"
foreach ($file in @($envFile, "$envFile.dpapi", $accountConfig)) {
    if (Test-Path -LiteralPath $file) { throw "Configuration already exists: $file. Inspect before replacing." }
}
foreach ($directory in @($privateRoot, $napcatConfig)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $acl = Get-Acl -LiteralPath $directory
    $acl.SetAccessRuleProtection($true, $false)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($sid in @($user, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
}
function New-LocalToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}
$hubToken = New-LocalToken
$onebotToken = New-LocalToken
$webToken = New-LocalToken
$cli = (Join-Path $PSScriptRoot 'codebuddy-cli-current\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy').Replace('\', '/')
$dataDir = (Join-Path $privateRoot 'hub-data').Replace('\', '/')
$envText = @"
CODEX_REMOTE_CONTACT_HOST=127.0.0.1
CODEX_REMOTE_CONTACT_PORT=3789
CODEX_REMOTE_CONTACT_DISABLE_AUTH=0
CODEX_REMOTE_CONTACT_OWNER_QQ_ID=$OwnerQQ
CODEX_REMOTE_CONTACT_BOT_QQ_ID=$BotQQ
CODEX_REMOTE_CONTACT_ENGINE=workbuddy
CODEX_REMOTE_CONTACT_API_TOKEN=$hubToken
ONEBOT_ACCESS_TOKEN=$onebotToken
ONEBOT_API_BASE=http://127.0.0.1:3000
WB_AGENT_CLI="$cli"
CODEX_REMOTE_CONTACT_DATA_DIR="$dataDir"
"@
[IO.File]::WriteAllText($envFile, $envText, [Text.UTF8Encoding]::new($false))
$config = @{network = @{
    httpServers = @(@{name='gateway-api'; enable=$true; host='127.0.0.1'; port=3000; enableCors=$false; enableWebsocket=$false; messagePostFormat='array'; token=$onebotToken; debug=$false})
    httpClients = @(@{name='gateway-events'; enable=$true; url='http://127.0.0.1:3789/api/onebot/event'; messagePostFormat='array'; reportSelfMessage=$false; token=$hubToken; debug=$false})
    websocketServers = @(); websocketClients = @()
}}
[IO.File]::WriteAllText($accountConfig, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$webui = @{host='127.0.0.1'; port=6099; token=$webToken; loginRate=3; autoLoginAccount=''; disableWebUI=$false}
[IO.File]::WriteAllText((Join-Path $napcatConfig 'webui.json'), ($webui | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$dispatchFile = Join-Path $dataDir 'agent-dispatch.json'
if (-not (Test-Path -LiteralPath $dispatchFile)) {
    [IO.File]::WriteAllText($dispatchFile, '{"version":1,"enabled":false,"updatedAt":null}', [Text.UTF8Encoding]::new($false))
}
Write-Output "Configuration ready: $envFile"
Write-Output 'Automatic model dispatch remains OFF until the chosen test chat is ready.'
