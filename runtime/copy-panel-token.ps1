$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-credentials.ps1')
$token = Get-RuntimePanelToken
Set-Clipboard -Value $token
Write-Output 'Panel token copied. Paste it into the local gateway login dialog.'
