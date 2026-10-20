param(
    [string]$RuntimeRoot = $PSScriptRoot,
    [string]$QQPath = 'C:\Program Files\Tencent\QQNT\QQ.exe',
    [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'QQ（通知采集）.lnk'),
    [string]$RegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    [string]$BackupRoot, [switch]$Preview
)
$ErrorActionPreference = 'Stop'

function Get-QqNoticeStartupPlan {
    param([string]$QQPath, [string]$PwshPath, [string]$LauncherPath,
        [AllowNull()][string]$CurrentRunValue, [string]$ShortcutTarget, [AllowEmptyString()][string]$ShortcutArguments)
    foreach ($path in @($QQPath,$PwshPath,$LauncherPath)) {
        if (-not [IO.Path]::IsPathFullyQualified($path) -or $path -match '["\r\n]') { throw '启动路径必须为不含引号或换行的绝对路径。' }
    }
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $LauncherPath + '" -QQPath "' + $QQPath + '"'
    $runValue = '"' + $PwshPath + '" ' + $arguments
    $originalRun = $CurrentRunValue -match ('^"' + [regex]::Escape($QQPath) + '"(?: /background)?$') -or $CurrentRunValue -eq $QQPath
    if (-not $originalRun -and $CurrentRunValue -cne $runValue) { throw 'QQNT 自启动项为未知内容；拒绝覆盖。' }
    $originalShortcut = $ShortcutTarget -eq $QQPath -and [string]::IsNullOrWhiteSpace($ShortcutArguments)
    $installedShortcut = $ShortcutTarget -eq $PwshPath -and $ShortcutArguments -ceq $arguments
    if (-not $originalShortcut -and -not $installedShortcut) { throw 'QQ 快捷方式为未知目标或参数；拒绝覆盖。' }
    return @{RunValue=$runValue;Arguments=$arguments;TargetPath=$PwshPath;ChangeRequired=($CurrentRunValue -cne $runValue -or -not $installedShortcut)}
}

function Install-QqNoticeStartup {
    param([string]$RuntimeRoot = $PSScriptRoot, [string]$QQPath = 'C:\Program Files\Tencent\QQNT\QQ.exe',
        [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'QQ（通知采集）.lnk'),
        [string]$RegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', [string]$BackupRoot, [switch]$Preview)
    $launcher = Join-Path $RuntimeRoot 'start-qq-with-notices.ps1'
    $pwsh = (Get-Command pwsh.exe -CommandType Application | Select-Object -First 1).Source
    foreach ($path in @($QQPath,$launcher)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "安装所需文件不存在：$path" } }
    $shortcutExisted = Test-Path -LiteralPath $ShortcutPath -PathType Leaf
    if (-not $shortcutExisted -and (Test-Path -LiteralPath $ShortcutPath)) { throw '快捷方式路径已被非文件占用；拒绝覆盖。' }
    $key = Get-Item -LiteralPath $RegistryPath
    if ($key.GetValueKind('QQNT') -notin @([Microsoft.Win32.RegistryValueKind]::String,[Microsoft.Win32.RegistryValueKind]::ExpandString)) { throw 'QQNT 自启动项类型未知；拒绝覆盖。' }
    $oldValue = $key.GetValue('QQNT',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $originalTarget = if ($shortcutExisted) { $shortcut.TargetPath } else { $QQPath }
    $originalArguments = if ($shortcutExisted) { $shortcut.Arguments } else { '' }
    $plan = Get-QqNoticeStartupPlan -QQPath $QQPath -PwshPath $pwsh -LauncherPath $launcher -CurrentRunValue $oldValue -ShortcutTarget $originalTarget -ShortcutArguments $originalArguments
    if (-not $BackupRoot) { $BackupRoot = Join-Path $RuntimeRoot 'private\qq-connection-before-20261017' }
    if ($Preview) { return @{preview=$true;changeRequired=$plan.ChangeRequired;shortcut=$ShortcutPath;registry=$RegistryPath;backup=$BackupRoot;runValue=$plan.RunValue;arguments=$plan.Arguments} }
    if (-not $plan.ChangeRequired) { return @{status='already-installed';backup=$BackupRoot} }
    $manifest = Join-Path $BackupRoot 'startup-before.json'
    $shortcutBackup = Join-Path $BackupRoot 'QQ.lnk'
    if (Test-Path -LiteralPath $BackupRoot) {
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw '备份目录已有不完整内容；拒绝覆盖，请核对恢复记录。' }
        $backup = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if ($backup.registry -ne $RegistryPath -or $backup.shortcut -ne [IO.Path]::GetFullPath($ShortcutPath) -or $backup.qqPath -ne $QQPath) { throw '备份目录属于其他入口；拒绝覆盖。' }
        # Older backups predate shortcutExisted and always contain an original link.
        if ($backup.shortcutExisted -ne $false -and -not (Test-Path -LiteralPath $shortcutBackup -PathType Leaf)) { throw '备份目录缺少原快捷方式；拒绝覆盖。' }
    } else {
        New-Item -ItemType Directory -Path $BackupRoot | Out-Null
        if ($shortcutExisted) { Copy-Item -LiteralPath $ShortcutPath -Destination $shortcutBackup }
        @{registry=$RegistryPath;name='QQNT';value=$oldValue;kind=[string]$key.GetValueKind('QQNT');shortcut=[IO.Path]::GetFullPath($ShortcutPath)
          shortcutExisted=[bool]$shortcutExisted;qqPath=$QQPath;target=$shortcut.TargetPath;arguments=$shortcut.Arguments;icon=$shortcut.IconLocation;createdAt=[DateTimeOffset]::Now.ToString('o')
          restore='If shortcutExisted=true restore QQ.lnk to shortcut path; otherwise remove only the installed shortcut. Restore registry QQNT value and kind recorded here.'} |
            ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8
    }
    # A desktop write failure leaves the existing Run entry intact.
    $shortcut.TargetPath = $plan.TargetPath
    $shortcut.Arguments = $plan.Arguments
    $shortcut.WorkingDirectory = $RuntimeRoot
    if (-not $shortcut.IconLocation) { $shortcut.IconLocation = "$QQPath,0" }
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Set-ItemProperty -LiteralPath $RegistryPath -Name QQNT -Value $plan.RunValue -Type String
    return @{status='installed';backup=$BackupRoot;message='QQ 通知采集快捷方式与登录启动入口已配置；原值及快捷方式存在状态已备份。'}
}

if ($MyInvocation.InvocationName -ne '.') { Install-QqNoticeStartup @PSBoundParameters }
