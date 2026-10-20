$ErrorActionPreference = 'Stop'
$credential = Import-Clixml -LiteralPath (Join-Path $PSScriptRoot 'private\credential.clixml')
$payload = @{ username=$credential.UserName; password=$credential.GetNetworkCredential().Password } | ConvertTo-Json -Compress
$payload | & py -3 -X utf8 (Join-Path $PSScriptRoot 'discover.py')
if ($LASTEXITCODE -ne 0) { throw 'fruux read-only discovery failed.' }
