param([string]$CliPath)
$ErrorActionPreference = 'Stop'
if ($CliPath) { throw 'CLI configuration is protected by DPAPI; this restart entry does not rewrite credentials.' }
& (Join-Path $PSScriptRoot 'runtime-control.ps1') -Action Stop
for ($tick = 0; $tick -lt 10; $tick++) {
    $task = Get-ScheduledTask -TaskName 'WorkBuddyQQGateway-Public' -TaskPath '\' -ErrorAction SilentlyContinue
    if (-not $task -or $task.State -ne 'Running') { break }
    Start-Sleep -Seconds 1
}
& (Join-Path $PSScriptRoot 'runtime-control.ps1') -Action Start
