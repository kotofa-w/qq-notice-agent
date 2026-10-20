param(
    [string]$EnvFile = (Join-Path $PSScriptRoot '..\config\qq-only.env'),
    [string]$Node = $env:CODEX_REMOTE_CONTACT_NODE_PATH
)
$ErrorActionPreference = 'Stop'

if (-not $Node) {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'Node.js 22+ is required. Pass -Node with its executable path.' }
    $Node = $nodeCommand.Source
}
& $Node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { throw 'Use Node.js 22+ for the Windows gateway.' }

$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeArguments = @()
if ($EnvFile) {
    $resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
    $nodeArguments += "--env-file=$resolvedEnvFile"
}
$nodeArguments += (Join-Path $projectDirectory 'src\server.js')
# Load configuration in Node; never evaluate it as PowerShell or print secrets.
Push-Location $projectDirectory
try {
    & $Node @nodeArguments
    if ($LASTEXITCODE -ne 0) { throw "Gateway exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}
