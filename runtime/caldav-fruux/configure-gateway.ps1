$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\runtime-credentials.ps1')
$envPath = Join-Path $PSScriptRoot '..\private\qq-only.env.dpapi'
$credentialPath = Join-Path $PSScriptRoot 'private\credential.clixml'
$discovery = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'private\discovery.json') -Raw | ConvertFrom-Json
$calendars = @($discovery.calendars | Where-Object canCreateEvent)
if ($calendars.Count -ne 1) { throw 'Expected exactly one writable calendar.' }
$target = [Uri]$calendars[0].url
if ($target.Scheme -ne 'https' -or $target.Host -ne 'dav.fruux.com' -or $target.Port -ne 443) { throw 'Unexpected fruux calendar URL.' }
$credential = Import-Clixml -LiteralPath $credentialPath
if ($credential -isnot [Management.Automation.PSCredential]) { throw 'Invalid credential file.' }
$credential = $null
$before = Get-RuntimeEnvironment -Path $envPath
$updates = [ordered]@{
    CODEX_REMOTE_CONTACT_CALENDAR_PROVIDER = 'caldav'
    CODEX_REMOTE_CONTACT_CALDAV_URL = $target.AbsoluteUri
    CODEX_REMOTE_CONTACT_CALDAV_CALENDAR_NAME = [string]$calendars[0].name
    CODEX_REMOTE_CONTACT_CALDAV_REMINDER_MINUTES = '30'
    CODEX_REMOTE_CONTACT_CALDAV_CREDENTIAL_FILE = [IO.Path]::GetFullPath($credentialPath)
}
$bytes = Unprotect-RuntimeBytes -Bytes ([IO.File]::ReadAllBytes($envPath))
try { $originalText = [Text.Encoding]::UTF8.GetString($bytes) } finally { [Array]::Clear($bytes,0,$bytes.Length) }
foreach ($key in $updates.Keys) {
    if ($before.ContainsKey($key) -and $before[$key] -ne $updates[$key]) { throw "Existing CalDAV setting differs: $key" }
}
$newText = $originalText.TrimEnd("`r", "`n") + "`r`n"
foreach ($key in $updates.Keys) {
    if (-not $before.ContainsKey($key)) { $newText += "$key='$($updates[$key])'`r`n" }
}
$parsed = ConvertFrom-RuntimeEnvText -Text $newText
foreach ($key in $before.Keys) { if ($parsed[$key] -cne $before[$key]) { throw 'Existing runtime settings changed.' } }
$backupPath = Join-Path $PSScriptRoot 'private\backups\pre-gateway-integration\qq-only-before-fruux.env.dpapi'
if (-not (Test-Path -LiteralPath $backupPath)) { [IO.File]::WriteAllBytes($backupPath, [IO.File]::ReadAllBytes($envPath)) }
$newBytes = [Text.Encoding]::UTF8.GetBytes($newText)
try { $protected = Protect-RuntimeBytes -Bytes $newBytes } finally { [Array]::Clear($newBytes,0,$newBytes.Length) }
[IO.File]::WriteAllBytes("$envPath.tmp", $protected)
$roundtrip = Get-RuntimeEnvironment -Path "$envPath.tmp"
foreach ($key in $parsed.Keys) { if ($roundtrip[$key] -cne $parsed[$key]) { throw 'Protected runtime roundtrip failed.' } }
Move-Item -LiteralPath "$envPath.tmp" -Destination $envPath -Force
@{ configured=$true; provider='caldav'; oldKeysPreserved=$true; addedKeys=@($updates.Keys); passwordStoredInEnvFile=$false } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'logs\gateway-configuration.json') -Encoding utf8
Write-Output 'fruux configured; original environment keys preserved; credential remains in DPAPI CLIXML.'
