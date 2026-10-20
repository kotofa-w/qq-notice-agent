param([switch]$Replace)
$ErrorActionPreference = 'Stop'
$privateDir = Join-Path $PSScriptRoot 'private'
$logsDir = Join-Path $PSScriptRoot 'logs'
$credentialFile = Join-Path $privateDir 'credential.clixml'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
function Write-SetupState([string]$Status) {
    @{ status=$Status; inputProcessId=$PID; updatedAtUtc=[DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logsDir 'credential-setup.json') -Encoding utf8
}
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.Name -match 'CodexSandbox') { throw 'Run this input window as your own Windows user.' }
    if ((Test-Path -LiteralPath $credentialFile) -and -not $Replace) {
        throw 'Credentials already exist. Use -Replace only when intentionally changing them.'
    }
    New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid,[Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $privateDir -AclObject $acl
    $Host.UI.RawUI.WindowTitle = 'fruux CalDAV - local credential input'
    Write-Host 'Use the device-specific username/password from fruux Sync.'
    Write-Host 'The password is masked and saved with Windows CurrentUser DPAPI encryption.'
    Write-SetupState 'waiting-for-local-input'
    $username = (Read-Host 'fruux device username').Trim()
    if (-not $username -or $username.Contains(':')) { throw 'Invalid device username.' }
    $password = Read-Host 'fruux device password' -AsSecureString
    if ($password.Length -eq 0) { throw 'Password cannot be empty.' }
    $credential = [PSCredential]::new($username,$password)
    if (Test-Path -LiteralPath $credentialFile) {
        Copy-Item -LiteralPath $credentialFile -Destination ($credentialFile + '.previous')
    }
    $credential | Export-Clixml -LiteralPath $credentialFile
    $loaded = Import-Clixml -LiteralPath $credentialFile
    if ($loaded.UserName -cne $username -or $loaded.GetNetworkCredential().Password -cne $credential.GetNetworkCredential().Password) {
        throw 'Encrypted credential roundtrip failed.'
    }
    Write-SetupState 'saved'
    Write-Host 'Credentials saved. Return to the chat; no password is printed.'
} catch {
    Write-SetupState 'failed-or-cancelled'
    Write-Host ('Setup stopped: ' + $_.Exception.Message)
} finally {
    $null = Read-Host 'Press Enter to close this window'
}
