param([string]$Python = $env:WB_PYTHON)
$ErrorActionPreference = 'Stop'

if (-not $Python) {
    $pythonCommand = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $pythonCommand) { throw 'Python 3.10+ is required. Pass -Python with its executable path.' }
    $Python = $pythonCommand.Source
}
& $Python -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }

$venvDirectory = Join-Path $PSScriptRoot '.venv'
$venvPython = Join-Path $venvDirectory 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    if (Test-Path -LiteralPath $venvDirectory) { throw 'The existing .venv is incomplete or uses another platform. Move it to a backup before setup.' }
    & $Python -m venv $venvDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the WorkBuddy virtual environment.' }
}
& $venvPython -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
if ($LASTEXITCODE -ne 0) { throw 'The existing .venv needs Python 3.10+. Back it up before recreating it.' }
& $venvPython -m pip install --disable-pip-version-check --retries 1 --timeout 30 -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'SDK installation failed. The virtual environment is retained for retry.' }
& $venvPython -X utf8 -c "import codebuddy_agent_sdk; from importlib.metadata import version; print('SDK', version('codebuddy-agent-sdk'))"
if ($LASTEXITCODE -ne 0) { throw 'The installed SDK could not be imported.' }
Write-Output "Python: $venvPython"
