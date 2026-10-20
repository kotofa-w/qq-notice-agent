param([switch]$Preview)
$ErrorActionPreference = 'Stop'
$taskName = 'WorkBuddyQQGateway-Public'
$workspace = Split-Path $PSScriptRoot -Parent
$entry = Join-Path $PSScriptRoot 'run-runtime.ps1'
$secret = Join-Path $PSScriptRoot 'private\qq-only.env.dpapi'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $entry + '"'
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $workspace
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userSid
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
if ($Preview) { return $task }
foreach ($file in @($entry, $secret)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required runtime file missing: $file" }
}
$existing = Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -EQ $taskName
if ($existing) {
    $sameUser = $existing.Principal.UserId -eq $userSid
    if (-not $sameUser) {
        try { $sameUser = ([Security.Principal.NTAccount]::new($existing.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value -eq $userSid) } catch { $sameUser = $false }
    }
    $sameAction = @($existing.Actions).Count -eq 1 -and $existing.Actions[0].Execute -eq $pwsh -and $existing.Actions[0].Arguments -eq $arguments -and $existing.Actions[0].WorkingDirectory -eq $workspace
    if (-not ($sameUser -and $sameAction)) { throw "Unrelated task has the same name; refusing replacement: $taskName" }
    # Export includes every trigger and setting so a proposed update can be reviewed.
    Write-Output (Export-ScheduledTask -TaskName $taskName -TaskPath '\')
    throw "Already installed: $taskName. No changes made. Updating requires an approved backup and diff."
}
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject $task | Out-Null
Write-Output "Installed current-user logon task: $taskName"
