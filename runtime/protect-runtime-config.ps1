param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-credentials.ps1')

if ($SelfTest) {
    $sample = "# synthetic only`nHOST=127.0.0.1`nPATH_VALUE='C:\synthetic folder'`nDOUBLE=`"line\nnext#inside`" # comment`nEMPTY=`nexport FLAG = yes`n# final comment"
    $values = ConvertFrom-RuntimeEnvText -Text $sample
    if ($values.Count -ne 5 -or $values['PATH_VALUE'] -ne 'C:\synthetic folder' -or $values['DOUBLE'] -ne "line`nnext#inside" -or $values['EMPTY'] -ne '') { throw 'Env parser self-test failed.' }
    foreach ($invalid in @('BAD LINE', "A=1`nA=2", 'A="unterminated')) {
        $rejected = $false
        try { $null = ConvertFrom-RuntimeEnvText -Text $invalid } catch { $rejected = $true }
        if (-not $rejected) { throw 'Env parser accepted invalid input.' }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($sample)
    $roundtrip = Unprotect-RuntimeBytes -Bytes (Protect-RuntimeBytes -Bytes $bytes)
    if ([Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($roundtrip)) { throw 'DPAPI roundtrip self-test failed.' }
    [Array]::Clear($bytes, 0, $bytes.Length)
    [Array]::Clear($roundtrip, 0, $roundtrip.Length)
    Write-Output 'Synthetic env parser and CurrentUser DPAPI self-test passed; runtime configuration untouched.'
    return
}

$source = Join-Path $PSScriptRoot 'private\qq-only.env'
$target = "$source.dpapi"
if (Test-Path -LiteralPath $target) {
    throw 'Protected Hub configuration already exists; refusing to overwrite. If plaintext also remains after an interrupted migration, verify both in memory using Unprotect-RuntimeBytes and ReadAllBytes before removing plaintext. Keep the DPAPI file and use Get-RuntimeEnvironment under the original Windows user to recover values.'
}
$bytes = [IO.File]::ReadAllBytes($source)
$temp = "$target.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $null = ConvertFrom-RuntimeEnvText -Text $text
    [IO.File]::WriteAllBytes($temp, (Protect-RuntimeBytes -Bytes $bytes))
    $verified = Unprotect-RuntimeBytes -Bytes ([IO.File]::ReadAllBytes($temp))
    try {
        if ([Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($verified)) { throw 'DPAPI verification failed; plaintext retained.' }
    } finally { [Array]::Clear($verified, 0, $verified.Length) }
    [IO.File]::Move($temp, $target)
    # Refuse deletion if another process changed the source during migration.
    $current = [IO.File]::ReadAllBytes($source)
    try {
        if ([Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($current)) { throw 'Plaintext changed during migration; both files retained for manual recovery.' }
    } finally { [Array]::Clear($current, 0, $current.Length) }
    Remove-Item -LiteralPath $source
    Write-Output 'Hub configuration protected with CurrentUser DPAPI; plaintext removed. NapCat configuration still uses directory ACL protection.'
} finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
}
