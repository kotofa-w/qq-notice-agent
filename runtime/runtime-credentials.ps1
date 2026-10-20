# Hub credentials only; NapCat account configuration remains protected by its directory ACL.
function ConvertFrom-RuntimeEnvText {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $values = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $Text = $Text.TrimStart([char]0xFEFF)
    $pattern = '(?ms)\G(?:[ \t]*(?:\#[^\r\n]*)?(?:\r?\n|\z)|[ \t]*(?:export[ \t]+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"(?<double>[^"]*)"|''(?<single>[^'']*)''|(?<plain>(?![ \t]*["''])[^\r\n#]*))[ \t]*(?:\#[^\r\n]*)?(?:\r?\n|\z))'
    $parser = [regex]::new($pattern, [Text.RegularExpressions.RegexOptions]::None, [TimeSpan]::FromSeconds(2))
    $position = 0
    while ($position -lt $Text.Length) {
        # Match from the current position, without executing any env-file content.
        $match = $parser.Match($Text, $position)
        if (-not $match.Success -or $match.Length -eq 0) { throw 'Invalid Hub env-file syntax; no values were imported.' }
        $position += $match.Length
        if (-not $match.Groups['key'].Success) { continue }
        $key = $match.Groups['key'].Value
        if ($values.ContainsKey($key)) { throw 'Duplicate Hub env-file key; no values were imported.' }
        if ($match.Groups['double'].Success) {
            $value = $match.Groups['double'].Value.Replace('\n', "`n").Replace('\r', "`r")
        } elseif ($match.Groups['single'].Success) {
            $value = $match.Groups['single'].Value
        } else {
            $value = $match.Groups['plain'].Value.Trim()
        }
        $values.Add($key, $value)
    }
    return ,$values
}

function Protect-RuntimeBytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    Add-Type -AssemblyName System.Security
    return ,[Security.Cryptography.ProtectedData]::Protect($Bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}

function Unprotect-RuntimeBytes {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    Add-Type -AssemblyName System.Security
    return ,[Security.Cryptography.ProtectedData]::Unprotect($Bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}

function Get-RuntimeEnvironment {
    param([string]$Path = (Join-Path $PSScriptRoot 'private\qq-only.env.dpapi'))
    $bytes = Unprotect-RuntimeBytes -Bytes ([IO.File]::ReadAllBytes($Path))
    try {
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        return ,(ConvertFrom-RuntimeEnvText -Text $text)
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Import-RuntimeEnvironment {
    param([string]$Path = (Join-Path $PSScriptRoot 'private\qq-only.env.dpapi'))
    $values = Get-RuntimeEnvironment -Path $Path
    foreach ($key in $values.Keys) { [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process') }
}

function Get-RuntimePanelToken {
    param([string]$Path = (Join-Path $PSScriptRoot 'private\qq-only.env.dpapi'))
    $values = Get-RuntimeEnvironment -Path $Path
    if (-not $values.ContainsKey('CODEX_REMOTE_CONTACT_API_TOKEN') -or -not $values['CODEX_REMOTE_CONTACT_API_TOKEN']) {
        throw 'Hub credential is missing or empty.'
    }
    return $values['CODEX_REMOTE_CONTACT_API_TOKEN']
}
