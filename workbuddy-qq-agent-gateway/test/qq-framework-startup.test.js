import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const runtime = fileURLToPath(new URL('../../runtime/', import.meta.url)).replaceAll("'", "''");
function powershell(body) {
  const script = `$ErrorActionPreference='Stop'; . '${runtime}start-qq-with-notices.ps1'; . '${runtime}install-qq-notice-startup.ps1'; ${body}`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('existing verified online bot is reused without starting another QQ', () => {
  const result = powershell(`
    function Get-QqBridgeSettings { @{ BotQQ='100000002' } }
    function Test-QqNoticeHub { $true }
    function Invoke-QqDesktopBridge { @{status='connected'; loginVerified=$true} }
    function Start-QqNoticeHub { throw 'unexpected Hub start' }
    Invoke-QqNoticeStart | ConvertTo-Json -Compress
  `);
  assert.equal(result.status, 'connected');
  assert.equal(result.loginVerified, true);
});

test('Hub readiness is bounded and bridge is never launched on timeout', () => {
  assert.deepEqual(powershell(`
    function Get-QqBridgeSettings { @{} }
    function Test-QqNoticeHub { $false }
    function Start-QqNoticeHub { $script:starts++ }
    function Start-Sleep {}
    function Invoke-QqDesktopBridge { throw 'unexpected bridge start' }
    $script:starts=0
    try { Invoke-QqNoticeStart -HubAttempts 3 } catch { @{message=$_.Exception.Message;starts=$script:starts} | ConvertTo-Json -Compress }
  `), { message: 'Hub 启动等待超时；请检查 runtime/private/runtime-state.json。', starts: 1 });
});

test('connection requires both configured identity and online status', () => {
  const result = powershell(`
    $settings=@{BotQQ='100000002';OneBotUrl='http://127.0.0.1:3000';OneBotToken='synthetic'}
    function Invoke-RestMethod { param($Uri) if ($Uri.EndsWith('get_login_info')) { @{status='ok';data=@{user_id=100000002}} } else { @{status='ok';data=@{online=$false}} } }
    $offline=Test-QqBridgeConnection $settings
    function Invoke-RestMethod { param($Uri) if ($Uri.EndsWith('get_login_info')) { @{status='ok';data=@{user_id=100000002}} } else { @{status='ok';data=@{online=$true}} } }
    $online=Test-QqBridgeConnection $settings
    function Invoke-RestMethod { @{status='ok';data=@{user_id=100000003}} }
    try { Test-QqBridgeConnection $settings } catch { $wrong=$_.Exception.Message }
    @{offline=$offline;online=$online;wrong=$wrong} | ConvertTo-Json -Compress
  `);
  assert.equal(result.offline, false);
  assert.equal(result.online, true);
  assert.match(result.wrong, /账号与受保护配置不一致/);
});

test('ordinary running QQ is rejected safely and connected QQ is idempotent', () => {
  const result = powershell(`
    function Test-QqBridgeConnection { $true }
    function Get-QqDesktopProcesses { throw 'must reuse existing connection first' }
    $existing=Invoke-QqDesktopBridge @{}
    function Test-QqBridgeConnection { $false }
    function Get-QqDesktopProcesses { @(@{Id=123}) }
    try { Invoke-QqDesktopBridge @{} } catch { $message=$_.Exception.Message }
    @{status=$existing.status;message=$message} | ConvertTo-Json -Compress
  `);
  assert.equal(result.status, 'connected');
  assert.match(result.message, /正常退出 QQ/);
});

test('launcher restores process environment after native launch failure', () => {
  const result = powershell(`
    function Test-QqBridgeConnection { $false }
    function Get-QqDesktopProcesses { @() }
    function Test-Path { $true }
    function Start-Process { throw 'synthetic launch failure' }
    $env:NAPCAT_WORKDIR='original'
    $settings=@{QQPath='C:\\QQ space\\QQ.exe';Launcher='launcher';Library='library';Script='script';FrameworkRoot='framework';BridgeRoot='bridge';OneBotConfig='config';PrivateRoot=$env:TEMP}
    try { Invoke-QqDesktopBridge $settings } catch { $message=$_.Exception.Message }
    @{env=$env:NAPCAT_WORKDIR;message=$message} | ConvertTo-Json -Compress
  `);
  assert.equal(result.env, 'original');
  assert.match(result.message, /Framework 启动失败/);
});

test('early launcher exit is reported and is never called a successful connection', () => {
  const result = powershell(`
    function Test-QqBridgeConnection { $false }
    function Get-QqDesktopProcesses { @() }
    function Test-Path { $true }
    function Start-Sleep {}
    function Start-Process { @{Id=123;HasExited=$true;ExitCode=1} }
    $settings=@{QQPath='qq';Launcher='launcher';Library='library';Script='script';FrameworkRoot='framework';BridgeRoot='bridge';OneBotConfig='config';PrivateRoot=$env:TEMP}
    function Set-Content {}
    try { Invoke-QqDesktopBridge $settings } catch { @{message=$_.Exception.Message} | ConvertTo-Json -Compress }
  `);
  assert.match(result.message, /提前退出/);
});

test('duplicate in-progress startup cannot start Hub or QQ twice', () => {
  assert.equal(powershell(`
    $name='Local\\QQNotice-Test-'+[Guid]::NewGuid().ToString('N')
    $mutex=[Threading.Mutex]::new($false,$name)
    $job=Start-ThreadJob -ArgumentList $name -ScriptBlock { param($name) $m=[Threading.Mutex]::new($false,$name); $null=$m.WaitOne(); 'locked'; Start-Sleep -Seconds 4; $m.ReleaseMutex(); $m.Dispose() }
    while (-not ($job | Receive-Job -Keep)) { Start-Sleep -Milliseconds 25 }
    try { Invoke-QqNoticeStart -MutexName $name | ConvertTo-Json -Compress } finally { $job | Stop-Job; $job | Remove-Job; $mutex.Dispose() }
  `).status, 'already-starting');
});

test('startup plan quotes paths with spaces and rejects unknown existing entries', () => {
  const result = powershell(`
    $p=@{QQPath='C:\\QQ space\\QQ.exe';PwshPath='C:\\PowerShell space\\pwsh.exe';LauncherPath='D:\\Agent space\\start-qq-with-notices.ps1';CurrentRunValue='"C:\\QQ space\\QQ.exe" /background';ShortcutTarget='C:\\QQ space\\QQ.exe';ShortcutArguments=''}
    $plan=Get-QqNoticeStartupPlan @p
    $p.CurrentRunValue='"C:\\unknown.exe" /background'
    try { Get-QqNoticeStartupPlan @p } catch { $unknown=$_.Exception.Message }
    $p.CurrentRunValue=$plan.RunValue; $p.ShortcutTarget=$p.PwshPath; $p.ShortcutArguments=$plan.Arguments
    $again=Get-QqNoticeStartupPlan @p
    @{run=$plan.RunValue;args=$plan.Arguments;again=$again.ChangeRequired;unknown=$unknown} | ConvertTo-Json -Compress
  `);
  assert.equal(result.run, '"C:\\PowerShell space\\pwsh.exe" -NoProfile -NonInteractive -WindowStyle Hidden -File "D:\\Agent space\\start-qq-with-notices.ps1" -QQPath "C:\\QQ space\\QQ.exe"');
  assert.equal(result.again, false);
  assert.match(result.unknown, /未知/);
});

test('custom deployment paths survive loading the unified entry', () => {
  const result = powershell(`
    . '${runtime}start-qq-with-notices.ps1' -RuntimeRoot 'D:\\isolated runtime' -QQPath 'C:\\isolated QQ\\QQ.exe' -FrameworkRoot 'D:\\framework space' -BridgeRoot 'D:\\bridge space' -ConfigurationPath 'D:\\private space\\config.dpapi'
    @{root=$RuntimeRoot;qq=$QQPath;framework=$FrameworkRoot;bridge=$BridgeRoot;config=$ConfigurationPath} | ConvertTo-Json -Compress
  `);
  assert.equal(result.root, 'D:\\isolated runtime');
  assert.equal(result.qq, 'C:\\isolated QQ\\QQ.exe');
  assert.equal(result.framework, 'D:\\framework space');
  assert.equal(result.bridge, 'D:\\bridge space');
  assert.equal(result.config, 'D:\\private space\\config.dpapi');
});

test('installer preview writes nothing, installation keeps originals and repeated installation is a no-op', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'qq notice startup '));
  try {
    const result = powershell(`
      $root='${fixture.replaceAll("'", "''")}'
      $qq=Join-Path $root 'QQ.exe'; $linkPath=Join-Path $root 'QQ.lnk'; $backup=Join-Path $root 'startup backup'
      foreach ($name in @('QQ.exe','QQ.lnk','start-qq-with-notices.ps1')) { [IO.File]::WriteAllText((Join-Path $root $name),'original') }
      $script:run='"'+$qq+'" /background'; $originalRun=$script:run
      $script:saves=0; $script:writes=0
      $script:key=[pscustomobject]@{}
      $script:key | Add-Member ScriptMethod GetValueKind { param($name) [Microsoft.Win32.RegistryValueKind]::String }
      $script:key | Add-Member ScriptMethod GetValue { param($name,$default,$options) $script:run }
      $script:link=[pscustomobject]@{TargetPath=$qq;Arguments='';IconLocation='original-icon';WorkingDirectory='';WindowStyle=1;Path=$linkPath}
      $script:link | Add-Member ScriptMethod Save { $script:saves++; [IO.File]::WriteAllText($this.Path,'installed') }
      $script:shell=[pscustomobject]@{}
      $script:shell | Add-Member ScriptMethod CreateShortcut { param($path) $script:link }
      function Get-Item { param($LiteralPath) if ($LiteralPath -ne 'HKCU:\\Software\\QQNotice-Test') { throw 'unexpected registry access' }; $script:key }
      function New-Object { param($ComObject) if ($ComObject -ne 'WScript.Shell') { throw 'unexpected COM access' }; $script:shell }
      function Set-ItemProperty { param($LiteralPath,$Name,$Value,$Type) if ($LiteralPath -ne 'HKCU:\\Software\\QQNotice-Test' -or $Name -ne 'QQNT') { throw 'unexpected registry write' }; $script:writes++; $script:run=$Value }
      $p=@{RuntimeRoot=$root;QQPath=$qq;ShortcutPath=$linkPath;RegistryPath='HKCU:\\Software\\QQNotice-Test';BackupRoot=$backup}
      $previewResult=Install-QqNoticeStartup @p -Preview
      $previewClean=-not (Test-Path -LiteralPath $backup) -and $script:saves -eq 0 -and $script:writes -eq 0
      $installed=Install-QqNoticeStartup @p
      $manifest=Get-Content -LiteralPath (Join-Path $backup 'startup-before.json') -Raw | ConvertFrom-Json
      $again=Install-QqNoticeStartup @p
      @{previewClean=$previewClean;installed=$installed.status;again=$again.status;saves=$script:saves;writes=$script:writes
        originalLink=[IO.File]::ReadAllText((Join-Path $backup 'QQ.lnk'));originalRun=($manifest.value -eq $originalRun);icon=$script:link.IconLocation} | ConvertTo-Json -Compress
    `);
    assert.deepEqual(result, { previewClean: true, installed: 'installed', again: 'already-installed', saves: 1, writes: 1, originalLink: 'original', originalRun: true, icon: 'original-icon' });
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('missing Framework file never creates a process or a success result', () => {
  assert.match(powershell(`
    function Test-QqBridgeConnection { $false }
    function Get-QqDesktopProcesses { @() }
    function Test-Path { $false }
    function Start-Process { throw 'unexpected process launch' }
    try { Invoke-QqDesktopBridge @{QQPath='missing';BridgeRoot='bridge'} } catch { @{message=$_.Exception.Message} | ConvertTo-Json -Compress }
  `).message, /Framework 所需文件缺失/);
});

test('online QQ with explicitly unhealthy OneBot status is not accepted', () => {
  assert.equal(powershell(`
    function Invoke-RestMethod { param($Uri) if ($Uri.EndsWith('get_login_info')) { @{status='ok';data=@{user_id=100000002}} } else { @{status='ok';data=@{online=$true;good=$false}} } }
    Test-QqBridgeConnection @{BotQQ='100000002';OneBotUrl='http://127.0.0.1:3000';OneBotToken='synthetic'} | ConvertTo-Json -Compress
  `), false);
});

test('installed arguments deliver the custom QQ executable path to the launcher', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'qq notice quoted '));
  try {
    const result = powershell(`
      $root='${fixture.replaceAll("'", "''")}'
      $launcher=Join-Path $root 'start launcher.ps1'
      $content='param([string]$QQPath)' + [Environment]::NewLine + '[IO.File]::WriteAllText((Join-Path $PSScriptRoot ''captured.txt''),$QQPath)'
      [IO.File]::WriteAllText($launcher,$content)
      $qq=Join-Path $root 'QQ with spaces\\QQ.exe'
      $pwsh=(Get-Command pwsh.exe).Source
      $plan=Get-QqNoticeStartupPlan -QQPath $qq -PwshPath $pwsh -LauncherPath $launcher -CurrentRunValue ('"'+$qq+'" /background') -ShortcutTarget $qq -ShortcutArguments ''
      $process=Start-Process -FilePath $pwsh -ArgumentList $plan.Arguments -WindowStyle Hidden -Wait -PassThru
      @{code=$process.ExitCode;path=[IO.File]::ReadAllText((Join-Path $root 'captured.txt'));expected=$qq} | ConvertTo-Json -Compress
    `);
    assert.equal(result.code, 0);
    assert.equal(result.path, result.expected);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('missing default user shortcut is created without touching public QQ and Preview is read-only', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'qq notice new desktop '));
  try {
    const result = powershell(`
      $root='${fixture.replaceAll("'", "''")}'
      $qq=Join-Path $root 'QQ.exe'; $backup=Join-Path $root 'startup-user'
      $publicFixture=Join-Path $root 'Public QQ.lnk'
      foreach ($name in @('QQ.exe','Public QQ.lnk','start-qq-with-notices.ps1')) { [IO.File]::WriteAllText((Join-Path $root $name),'original') }
      $script:expectedDesktop=Join-Path ([Environment]::GetFolderPath('Desktop')) 'QQ（通知采集）.lnk'
      $script:shortcutExists=$false; $script:saves=0; $script:writes=0
      $script:run='"'+$qq+'" /background'; $originalRun=$script:run
      $script:key=[pscustomobject]@{}
      $script:key | Add-Member ScriptMethod GetValueKind { param($name) [Microsoft.Win32.RegistryValueKind]::String }
      $script:key | Add-Member ScriptMethod GetValue { param($name,$default,$options) $script:run }
      $script:link=[pscustomobject]@{TargetPath='';Arguments='';IconLocation='';WorkingDirectory='';WindowStyle=1}
      $script:link | Add-Member ScriptMethod Save { $script:saves++; $script:shortcutExists=$true }
      $script:shell=[pscustomobject]@{}
      $script:shell | Add-Member ScriptMethod CreateShortcut { param($path) if ($path -ne $script:expectedDesktop) { throw 'unexpected desktop target' }; $script:link }
      function Test-Path { param($LiteralPath,$PathType) if ($LiteralPath -eq $script:expectedDesktop) { return $script:shortcutExists }; if ($PathType) { Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath -PathType $PathType } else { Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath } }
      function Get-Item { param($LiteralPath) if ($LiteralPath -ne 'HKCU:\\Software\\QQNotice-Test') { throw 'unexpected registry access' }; $script:key }
      function New-Object { param($ComObject) if ($ComObject -ne 'WScript.Shell') { throw 'unexpected COM access' }; $script:shell }
      function Set-ItemProperty { param($LiteralPath,$Name,$Value,$Type) if ($LiteralPath -ne 'HKCU:\\Software\\QQNotice-Test' -or $Name -ne 'QQNT') { throw 'unexpected registry write' }; $script:writes++; $script:run=$Value }
      $p=@{RuntimeRoot=$root;QQPath=$qq;RegistryPath='HKCU:\\Software\\QQNotice-Test';BackupRoot=$backup}
      $previewResult=Install-QqNoticeStartup @p -Preview
      $previewClean=-not (Test-Path -LiteralPath $backup) -and -not $script:shortcutExists -and $script:writes -eq 0
      $installed=Install-QqNoticeStartup @p
      $manifest=Get-Content -LiteralPath (Join-Path $backup 'startup-before.json') -Raw | ConvertFrom-Json
      $again=Install-QqNoticeStartup @p
      @{previewClean=$previewClean;installed=$installed.status;again=$again.status;saves=$script:saves;writes=$script:writes
        publicOriginal=[IO.File]::ReadAllText($publicFixture);shortcutExisted=$manifest.shortcutExisted;noLinkBackup=(-not (Test-Path -LiteralPath (Join-Path $backup 'QQ.lnk')))
        originalRun=($manifest.value -eq $originalRun);runChanged=($script:run -ne $originalRun);icon=$script:link.IconLocation;expectedIcon=($qq+',0')} | ConvertTo-Json -Compress
    `);
    assert.equal(result.previewClean, true);
    assert.equal(result.installed, 'installed');
    assert.equal(result.again, 'already-installed');
    assert.equal(result.saves, 1);
    assert.equal(result.writes, 1);
    assert.equal(result.publicOriginal, 'original');
    assert.equal(result.shortcutExisted, false);
    assert.equal(result.noLinkBackup, true);
    assert.equal(result.originalRun, true);
    assert.equal(result.runChanged, true);
    assert.equal(result.icon, result.expectedIcon);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
