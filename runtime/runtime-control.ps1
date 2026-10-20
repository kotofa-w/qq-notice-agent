param([ValidateSet('Start','Stop','Status')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$privateRoot = Join-Path $PSScriptRoot 'private'
$stateFile = Join-Path $privateRoot 'runtime-state.json'
$entry = Join-Path $PSScriptRoot 'run-runtime.ps1'
$taskName = 'WorkBuddyQQGateway-Public'
if ($Action -eq 'Start') {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task) {
        $pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
        $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $sameUser = $task.Principal.UserId -eq $userSid
        if (-not $sameUser) { try { $sameUser = ([Security.Principal.NTAccount]::new($task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value -eq $userSid) } catch { $sameUser = $false } }
        $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $entry + '"'
        if (-not $sameUser -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $pwsh -or $task.Actions[0].Arguments -ne $arguments -or $task.Actions[0].WorkingDirectory -ne (Split-Path $PSScriptRoot -Parent)) { throw 'Scheduled task does not match this deployment.' }
        Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    } else {
        $pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
        Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-NonInteractive','-File', ('"' + $entry + '"')) -WindowStyle Hidden -WorkingDirectory (Split-Path $PSScriptRoot -Parent) | Out-Null
    }
    Write-Output 'Runtime start requested; use Status to inspect readiness.'
    return
}
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output 'Runtime has not been managed yet.'; return }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if ($Action -eq 'Stop') {
    if ($state.phase -eq 'stopped') { Write-Output 'Runtime already stopped.'; return }
    $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.supervisorPid)"
    if (-not $supervisor -or $supervisor.Name -ne 'pwsh.exe' -or -not $supervisor.CommandLine.Contains($entry)) { throw 'No verified supervisor is running; refusing to stop unrelated processes.' }
    [IO.File]::WriteAllText((Join-Path $privateRoot 'runtime-stop.request'), [DateTimeOffset]::Now.ToString('o'))
    for ($tick = 0; $tick -lt 45; $tick++) {
        Start-Sleep -Seconds 1
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if ($state.phase -eq 'stopped') { Write-Output 'Runtime stopped; owned Hub/NapCat processes cleaned.'; return }
        if ($state.phase -eq 'failed') { throw 'Runtime stop failed; inspect runtime-state.json without forcing task termination.' }
    }
    throw 'Runtime stop is still pending; inspect state before any fallback.'
}
$state | ConvertTo-Json
