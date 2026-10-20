[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$taskName = 'WorkBuddyQQGateway-Public'
$workspace = Split-Path $PSScriptRoot -Parent
$entry = Join-Path $PSScriptRoot 'run-runtime.ps1'
$pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $entry + '"'
$existing = Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -EQ $taskName
if (-not $existing) { Write-Output "Not installed: $taskName"; return }
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sameUser = $existing.Principal.UserId -eq $userSid
if (-not $sameUser) {
    try { $sameUser = ([Security.Principal.NTAccount]::new($existing.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value -eq $userSid) } catch { $sameUser = $false }
}
$sameAction = @($existing.Actions).Count -eq 1 -and $existing.Actions[0].Execute -eq $pwsh -and $existing.Actions[0].Arguments -eq $arguments -and $existing.Actions[0].WorkingDirectory -eq $workspace
if (-not ($sameUser -and $sameAction)) { throw "Task does not match this deployment and current user; refusing removal: $taskName" }
if ($PSCmdlet.ShouldProcess($taskName, 'Remove scheduled task (leave running services unchanged)')) {
    Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
    Write-Output "Removed task: $taskName. Running services remain unchanged."
}
