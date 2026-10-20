$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-credentials.ps1')
$workspace = Split-Path $PSScriptRoot -Parent
$repo = Join-Path $workspace 'workbuddy-qq-agent-gateway'
$privateRoot = Join-Path $PSScriptRoot 'private'
$stateFile = Join-Path $privateRoot 'runtime-state.json'
$stopFile = Join-Path $privateRoot 'runtime-stop.request'
$hubEntry = Join-Path $repo 'src\server.js'
$napcatRoot = Join-Path $PSScriptRoot 'napcat-v4.18.33'
$napcatEntry = Join-Path $napcatRoot 'index.js'
# Stable deployment identifier, retained across QQ account changes with the scheduled task.
$mutex = [Threading.Mutex]::new($false, 'Local\WorkBuddyQQGateway-Public')
$locked = $false
$children = @{}
$starts = @{ hub = 0; napcat = 0 }
$state = @{ phase = 'starting'; supervisorPid = $PID; hubPid = $null; napcatPid = $null; qqReady = $false; hubGracefulExit = $null; lastError = $null }

function Save-State {
    $state.updatedAt = [DateTimeOffset]::Now.ToString('o')
    $temp = "$stateFile.tmp"
    [IO.File]::WriteAllText($temp, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $stateFile -Force
}

function Get-QqBridgeConfiguration($values) {
    $raw = $values['CODEX_REMOTE_CONTACT_QQ_BRIDGE_MODE']
    if ($null -ne $raw -and $raw -isnot [string]) { throw 'QQ bridge mode must be a string.' }
    $mode = if ([string]::IsNullOrWhiteSpace($raw)) { 'managed' } else { $raw.Trim().ToLowerInvariant() }
    if ($mode -notin @('managed','external')) { throw 'QQ bridge mode must be managed or external.' }
    return @{ mode=$mode; childNames=$(if ($mode -eq 'external') { @('hub') } else { @('hub','napcat') }) }
}

function Find-OwnedProcess([string]$name) {
    $pidFile = Join-Path $privateRoot "$name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $savedPid = [int](Get-Content -LiteralPath $pidFile)
    $row = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid"
    if (-not $row) { return $null }
    $matches = $row.Name -eq 'node.exe' -and $(if ($name -eq 'hub') {
        $row.CommandLine.Contains($hubEntry) -or ($row.CommandLine.Contains('src/server.js') -and $row.CommandLine.Contains("--env-file=$(Join-Path $privateRoot 'qq-only.env')"))
    } else {
        $row.CommandLine.Contains($napcatEntry) -and [regex]::IsMatch($row.CommandLine, ('-q\s+' + [regex]::Escape($botQQ) + '(?:\s|$)'))
    })
    if (-not $matches) { throw "Saved $name PID does not match this deployment; refusing adoption." }
    return Get-Process -Id $savedPid
}

function Start-Child([string]$name) {
    $starts[$name]++
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    if ($name -eq 'hub') {
        $info.FileName = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
        $info.Arguments = '"' + $hubEntry + '"'
        $info.WorkingDirectory = $repo
        foreach ($key in $environment.Keys) { $info.EnvironmentVariables[$key] = $environment[$key] }
    } else {
        $info.FileName = Join-Path $napcatRoot 'node.exe'
        $info.Arguments = '"' + $napcatEntry + '" -q ' + $botQQ
        $info.WorkingDirectory = $napcatRoot
        foreach ($key in @('NAPCAT_QUICK_ACCOUNT','NAPCAT_QUICK_PASSWORD','NAPCAT_QUICK_PASSWORD_MD5','NAPCAT_WEBUI_SECRET_KEY','NAPCAT_WEBUI_PREFERRED_PORT')) {
            $info.EnvironmentVariables.Remove($key)
        }
    }
    $process = [Diagnostics.Process]::Start($info)
    [IO.File]::WriteAllText((Join-Path $privateRoot "$name.pid"), [string]$process.Id)
    return $process
}

function Stop-OwnedTree([Diagnostics.Process]$root, [bool]$gracefulHub) {
    if (-not $root -or $root.HasExited) { return }
    $rows = @(Get-CimInstance Win32_Process)
    $rootRow = $rows | Where-Object ProcessId -eq $root.Id
    if (-not $rootRow -or [Math]::Abs(($rootRow.CreationDate - $root.StartTime).TotalMilliseconds) -gt 1) { throw 'Runtime process identity changed; refusing cleanup.' }
    $tree = [Collections.Generic.List[object]]::new()
    $visited = [Collections.Generic.HashSet[int]]::new()
    $tree.Add($rootRow); [void]$visited.Add($root.Id)
    $parents = @($root.Id)
    $parentTimes = @{ ([int]$root.Id) = $rootRow.CreationDate }
    while ($parents.Count -gt 0) {
        $next = @($rows | Where-Object { $parents -contains [int]$_.ParentProcessId -and -not $visited.Contains([int]$_.ProcessId) -and $_.CreationDate -ge $parentTimes[[int]$_.ParentProcessId] })
        if ($next.Count -eq 0) { break }
        foreach ($child in $next) { $tree.Add($child); [void]$visited.Add([int]$child.ProcessId); $parentTimes[[int]$child.ProcessId] = $child.CreationDate }
        $parents = @($next | ForEach-Object { [int]$_.ProcessId })
    }
    if ($gracefulHub) {
        try {
            $null = Invoke-RestMethod -Uri "$hubUrl/api/runtime/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -Headers $headers -TimeoutSec 5
            $state.hubGracefulExit = $root.WaitForExit(15000)
        } catch { $state.lastError = 'Hub graceful stop unavailable; applying verified PID fallback.' }
    }
    for ($i = $tree.Count - 1; $i -ge 0; $i--) {
        $candidate = $tree[$i]
        if ($candidate.Name -notmatch '^(node|python|pythonw|conhost)\.exe$') { continue }
        $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)"
        if ($live -and $live.Name -eq $candidate.Name -and $live.CreationDate -eq $candidate.CreationDate) {
            Stop-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        }
    }
}

try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { Write-Output 'Runtime already running; duplicate launch ignored.'; return }
    $environment = Get-RuntimeEnvironment
    $criticalKeys = @('CODEX_REMOTE_CONTACT_OWNER_QQ_ID','CODEX_REMOTE_CONTACT_BOT_QQ_ID','CODEX_REMOTE_CONTACT_HOST','CODEX_REMOTE_CONTACT_PORT','CODEX_REMOTE_CONTACT_DISABLE_AUTH','CODEX_REMOTE_CONTACT_API_TOKEN','ONEBOT_API_BASE','ONEBOT_ACCESS_TOKEN')
    foreach ($key in @($environment.Keys) + $criticalKeys | Select-Object -Unique) {
        $override = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ($null -ne $override) { $environment[$key] = $override }
    }
    if ($environment['CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER'] -eq 'caldav' -and $environment['CODEX_REMOTE_CONTACT_CALDAV_CREDENTIAL_FILE']) {
        try {
            $caldavCredential = Import-Clixml -LiteralPath $environment['CODEX_REMOTE_CONTACT_CALDAV_CREDENTIAL_FILE']
            if ($caldavCredential -isnot [Management.Automation.PSCredential]) { throw 'Invalid credential type.' }
            $environment['CODEX_REMOTE_CONTACT_CALDAV_USERNAME'] = $caldavCredential.UserName
            $environment['CODEX_REMOTE_CONTACT_CALDAV_PASSWORD'] = $caldavCredential.GetNetworkCredential().Password
            $caldavCredential = $null
        } catch { throw 'CalDAV private credential could not be loaded for the current Windows user.' }
    }
    $botQQ = $environment['CODEX_REMOTE_CONTACT_BOT_QQ_ID']
    $ownerQQ = $environment['CODEX_REMOTE_CONTACT_OWNER_QQ_ID']
    if ($botQQ -notmatch '^[1-9][0-9]{4,11}$' -or $ownerQQ -notmatch '^[1-9][0-9]{4,11}$' -or $botQQ -eq $ownerQQ) { throw 'Distinct valid deployment OWNER/BOT QQ identities are required.' }
    $state.botQQ = $botQQ
    $state.ownerQQ = $ownerQQ
    $bridge = Get-QqBridgeConfiguration $environment
    $bridgeMode = $bridge.mode
    $state.bridgeMode = $bridgeMode
    $managedNames = @($bridge.childNames)
    if ($environment['CODEX_REMOTE_CONTACT_DISABLE_AUTH'] -eq '1' -or -not $environment['CODEX_REMOTE_CONTACT_API_TOKEN'] -or -not $environment['ONEBOT_ACCESS_TOKEN']) { throw 'Authenticated runtime credentials are required.' }
    if (($environment['CODEX_REMOTE_CONTACT_HOST'] -and $environment['CODEX_REMOTE_CONTACT_HOST'] -ne '127.0.0.1') -or ($environment['CODEX_REMOTE_CONTACT_PORT'] -and $environment['CODEX_REMOTE_CONTACT_PORT'] -ne '3789')) { throw 'This deployment requires Hub loopback port 3789.' }
    $onebotUrl = if ($environment['ONEBOT_API_BASE']) { $environment['ONEBOT_API_BASE'].TrimEnd('/') } else { 'http://127.0.0.1:3000' }
    $onebotUri = [Uri]$onebotUrl
    if ($onebotUri.Scheme -ne 'http' -or $onebotUri.Host -notin @('127.0.0.1','localhost','[::1]','::1')) { throw 'Local NapCat must use a loopback HTTP endpoint.' }
    $hubUrl = 'http://127.0.0.1:3789'
    $headers = @{ Authorization = "Bearer $($environment['CODEX_REMOTE_CONTACT_API_TOKEN'])" }
    $webui = Get-Content -LiteralPath (Join-Path $napcatRoot 'napcat\config\webui.json') -Raw | ConvertFrom-Json
    if ($webui.host -ne '127.0.0.1' -or $webui.autoLoginAccount) { throw 'NapCat must retain loopback and explicit BOT login.' }
    Remove-Item -LiteralPath $stopFile -ErrorAction SilentlyContinue
    foreach ($name in $managedNames) { $children[$name] = Find-OwnedProcess $name }
    while (-not (Test-Path -LiteralPath $stopFile)) {
        foreach ($name in $managedNames) {
            if (-not $children[$name] -or $children[$name].HasExited) {
                if ($starts[$name] -ge 3) {
                    if ($name -eq 'hub') { throw 'Hub repeatedly exited; supervisor stopped for Task Scheduler retry.' }
                    $state.lastError = 'NapCat exited three times; Hub remains online. Restart runtime after repairing QQ.'
                    continue
                }
                try { $children[$name] = Start-Child $name } catch {
                    if ($name -eq 'hub') { throw }
                    $state.lastError = 'NapCat unavailable; Hub remains online and QQ startup is deferred.'
                }
            }
        }
        $state.hubPid = if ($children.hub -and -not $children.hub.HasExited) { $children.hub.Id } else { $null }
        $state.napcatPid = if ($children.napcat -and -not $children.napcat.HasExited) { $children.napcat.Id } else { $null }
        $state.qqReady = $false
        if ($state.napcatPid -or $bridgeMode -eq 'external') {
            try {
                $login = Invoke-RestMethod -Uri "$onebotUrl/get_login_info" -Headers @{ Authorization = "Bearer $($environment['ONEBOT_ACCESS_TOKEN'])" } -TimeoutSec 3
                $loginId = if ($login.data.user_id) { $login.data.user_id } else { $login.data.self_id }
                $state.qqReady = $login.status -eq 'ok' -and [string]$loginId -eq $botQQ
            } catch { $state.qqReady = $false }
        }
        $state.phase = 'running'; Save-State
        for ($tick = 0; $tick -lt 15 -and -not (Test-Path -LiteralPath $stopFile); $tick++) { Start-Sleep -Seconds 1 }
    }
    $state.phase = 'stopping'; Save-State
    Stop-OwnedTree $children.hub $true
    Stop-OwnedTree $children.napcat $false
    $state.hubPid = $null; $state.napcatPid = $null; $state.qqReady = $false
    $state.phase = 'stopped'; Save-State
    Remove-Item -LiteralPath $stopFile -ErrorAction SilentlyContinue
} catch {
    $state.phase = 'failed'; $state.lastError = 'Runtime operation failed; inspect configuration and owned process identities.'
    $state.failureLine = $_.InvocationInfo.ScriptLineNumber
    if ($locked) { Save-State }
    throw
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
