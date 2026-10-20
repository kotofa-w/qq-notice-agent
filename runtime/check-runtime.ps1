$ErrorActionPreference = 'Stop'
foreach ($file in @('run-runtime.ps1','runtime-control.ps1','install-startup.ps1','uninstall-startup.ps1','runtime-credentials.ps1','protect-runtime-config.ps1')) {
    $syntaxErrors = $null; $tokens = $null
    $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$tokens, [ref]$syntaxErrors)
    if ($syntaxErrors.Count) { throw "PowerShell syntax error in $file" }
}
# Execute only the stop-tree function with fake CIM/process actions, never the runner.
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-runtime.ps1'), [ref]$null, [ref]$null)
$bridgeFunction = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-QqBridgeConfiguration' }, $true)
if (-not $bridgeFunction) { throw 'QQ bridge configuration resolver is missing.' }
Invoke-Expression $bridgeFunction.Extent.Text
foreach ($value in @($null, '', 'managed', ' MANAGED ')) {
    $bridge = Get-QqBridgeConfiguration @{ CODEX_REMOTE_CONTACT_QQ_BRIDGE_MODE = $value }
    if ($bridge.mode -ne 'managed' -or ($bridge.childNames -join ',') -ne 'hub,napcat') { throw 'Managed QQ bridge defaults changed.' }
}
$bridge = Get-QqBridgeConfiguration @{ CODEX_REMOTE_CONTACT_QQ_BRIDGE_MODE = ' external ' }
if ($bridge.mode -ne 'external' -or ($bridge.childNames -join ',') -ne 'hub') { throw 'External QQ bridge must manage only Hub.' }
foreach ($value in @('unknown', 1, $false, @('external','managed'))) {
    $rejected = $false
    try { $null = Get-QqBridgeConfiguration @{ CODEX_REMOTE_CONTACT_QQ_BRIDGE_MODE = $value } } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid QQ bridge mode was accepted.' }
}
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-OwnedTree' }, $true)
Invoke-Expression $function.Extent.Text
$root = [Diagnostics.Process]::GetCurrentProcess()
$created = $root.StartTime
$script:rows = @(
    [pscustomobject]@{ ProcessId=$root.Id; ParentProcessId=0; Name='node.exe'; CreationDate=$created },
    [pscustomobject]@{ ProcessId=2147483001; ParentProcessId=$root.Id; Name='python.exe'; CreationDate=$created },
    [pscustomobject]@{ ProcessId=2147483002; ParentProcessId=2147483001; Name='node.exe'; CreationDate=$created },
    [pscustomobject]@{ ProcessId=2147483003; ParentProcessId=0; Name='python.exe'; CreationDate=$created }
)
$script:stopped = [Collections.Generic.List[int]]::new()
function Get-CimInstance { param($ClassName, $Filter)
    if ($Filter) { return $script:rows | Where-Object ProcessId -eq ([int]$Filter.Split('=')[1]) }
    return $script:rows
}
function Stop-Process { param([int]$Id, $ErrorAction) $script:stopped.Add($Id) }
Stop-OwnedTree $root $false
if (($script:stopped -join ',') -ne "2147483002,2147483001,$($root.Id)") { throw 'Process tree scope check failed.' }
$script:rows = @($script:rows[0]); $script:stopped.Clear()
Stop-OwnedTree $root $false
if ($script:stopped.Count -ne 1) { throw 'Empty-child process tree check failed.' }
$script:rows = @($script:rows[0],
    [pscustomobject]@{ ProcessId=2147483001; ParentProcessId=$root.Id; Name='python.exe'; CreationDate=$created.AddSeconds(2) },
    [pscustomobject]@{ ProcessId=2147483002; ParentProcessId=2147483001; Name='node.exe'; CreationDate=$created.AddSeconds(1) })
$script:stopped.Clear(); Stop-OwnedTree $root $false
if ($script:stopped.Contains(2147483002)) { throw 'Reused intermediate parent PID escaped creation-time boundary.' }
Write-Output 'Runtime syntax and fake bounded process-tree checks passed; no real processes stopped.'
