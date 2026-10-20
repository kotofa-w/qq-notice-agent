param([Parameter(Mandatory)][ValidatePattern('^[1-9][0-9]{4,11}$')][string]$BotQQ)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'napcat-v4.18.33'
$config = Join-Path $root "napcat\config\onebot11_$BotQQ.json"
if (-not (Test-Path -LiteralPath $config)) { throw 'Run configure-qq.ps1 with your actual OWNER/BOT accounts first.' }
$webui = Get-Content -LiteralPath (Join-Path $root 'napcat\config\webui.json') -Raw | ConvertFrom-Json
if ($webui.host -ne '127.0.0.1' -or $webui.autoLoginAccount) { throw 'WebUI must use loopback and have no implicit auto-login account.' }
$names = @('NAPCAT_QUICK_ACCOUNT', 'NAPCAT_QUICK_PASSWORD', 'NAPCAT_QUICK_PASSWORD_MD5', 'NAPCAT_WEBUI_SECRET_KEY', 'NAPCAT_WEBUI_PREFERRED_PORT')
$saved = @{}
foreach ($name in $names) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
Push-Location $root
try {
    & (Join-Path $root 'node.exe') (Join-Path $root 'index.js') '-q' $BotQQ
    if ($LASTEXITCODE -ne 0) { throw "NapCat exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
