param(
    [string]$AppId = 'wx5306c5978fdb76e4',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0

function Convert-ToSafePath {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $safe = $Value
    foreach ($pair in @(
        @($env:APPDATA, '%APPDATA%'),
        @($env:LOCALAPPDATA, '%LOCALAPPDATA%'),
        @($env:USERPROFILE, '%USERPROFILE%')
    )) {
        $from = [string]$pair[0]
        if (-not [string]::IsNullOrWhiteSpace($from)) {
            $safe = $safe.Replace($from, [string]$pair[1])
        }
    }
    return $safe
}

function Test-ExcludedPath {
    param([string]$Path)
    return ([string]$Path -match '(?i)(\\|/)(Msg|Message|MsgAttach|FileStorage|ChatMsg|Contact|History|Backup)(\\|/|$)')
}

function Get-CommandLineSignals {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return [ordered]@{ appIdMentioned = $false; switchNames = @(); profileHashMentions = @() }
    }

    $switchNames = @([regex]::Matches($CommandLine, '(?<!\S)--([A-Za-z0-9_-]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique | Select-Object -First 60)
    $profileHashes = @([regex]::Matches($CommandLine, '(?i)(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])') | ForEach-Object { $_.Value.ToLowerInvariant() } | Sort-Object -Unique | Select-Object -First 10)

    return [ordered]@{
        appIdMentioned = [bool]($CommandLine -match [regex]::Escape($AppId))
        switchNames = $switchNames
        profileHashMentions = $profileHashes
    }
}

function Get-WeChatProcessSnapshot {
    $rows = @()
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '(?i)^(Weixin|WeChatAppEx|WeixinAppEx)\.exe$'
    } | ForEach-Object {
        $signals = Get-CommandLineSignals ([string]$_.CommandLine)
        $rows += [ordered]@{
            name = [string]$_.Name
            pid = [int]$_.ProcessId
            parentPid = [int]$_.ParentProcessId
            sessionId = [int]$_.SessionId
            executablePath = Convert-ToSafePath ([string]$_.ExecutablePath)
            commandLineSignals = $signals
        }
    }
    return @($rows | Sort-Object sessionId, name, pid)
}

if (-not ('Far2WechatWindowProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Far2WechatWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
'@
}

function Get-WeChatWindows {
    param([array]$Processes)

    $pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($proc in $Processes) {
        if ([string]$proc.name -match '(?i)^(Weixin|WeChatAppEx|WeixinAppEx)\.exe$') {
            [void]$pidSet.Add([uint32]$proc.pid)
        }
    }

    $rows = New-Object System.Collections.ArrayList
    $callback = [Far2WechatWindowProbe+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        [uint32]$pid = 0
        [void][Far2WechatWindowProbe]::GetWindowThreadProcessId($hWnd, [ref]$pid)
        if (-not $pidSet.Contains($pid)) { return $true }

        $titleBuffer = New-Object System.Text.StringBuilder 1024
        $classBuffer = New-Object System.Text.StringBuilder 256
        [void][Far2WechatWindowProbe]::GetWindowText($hWnd, $titleBuffer, $titleBuffer.Capacity)
        [void][Far2WechatWindowProbe]::GetClassName($hWnd, $classBuffer, $classBuffer.Capacity)
        $rect = New-Object Far2WechatWindowProbe+RECT
        [void][Far2WechatWindowProbe]::GetWindowRect($hWnd, [ref]$rect)

        [void]$rows.Add([ordered]@{
            hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
            pid = [int]$pid
            visible = [bool][Far2WechatWindowProbe]::IsWindowVisible($hWnd)
            title = $titleBuffer.ToString()
            className = $classBuffer.ToString()
            rect = [ordered]@{
                left = [int]$rect.Left
                top = [int]$rect.Top
                right = [int]$rect.Right
                bottom = [int]$rect.Bottom
            }
        })
        return $true
    }
    [void][Far2WechatWindowProbe]::EnumWindows($callback, [IntPtr]::Zero)
    return @($rows | Sort-Object pid, hwnd)
}

function Get-AppRoots {
    $usersRoot = Join-Path $env:APPDATA 'Tencent\xwechat\radium\users'
    $rows = @()
    if (-not (Test-Path -LiteralPath $usersRoot)) { return @() }

    Get-ChildItem -LiteralPath $usersRoot -Directory -Force | ForEach-Object {
        $candidate = Join-Path $_.FullName ("applet\local\{0}" -f $AppId)
        if (Test-Path -LiteralPath $candidate) {
            $rows += [ordered]@{
                profileId = $_.Name
                appRoot = Convert-ToSafePath $candidate
            }
        }
    }
    return @($rows | Sort-Object profileId)
}

function Get-AppInventory {
    param([array]$AppRoots)
    $rows = @()
    foreach ($root in $AppRoots) {
        $realRoot = Join-Path (Join-Path $env:APPDATA 'Tencent\xwechat\radium\users') ([string]$root.profileId)
        $realRoot = Join-Path $realRoot ("applet\local\{0}" -f $AppId)
        if (-not (Test-Path -LiteralPath $realRoot)) { continue }

        Get-ChildItem -LiteralPath $realRoot -File -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if (Test-ExcludedPath $_.FullName) { return }
            $rows += [ordered]@{
                profileId = [string]$root.profileId
                path = Convert-ToSafePath $_.FullName
                length = [int64]$_.Length
                lastWriteUtc = $_.LastWriteTimeUtc.ToString('o')
                extension = [string]$_.Extension
            }
        }
    }
    return @($rows | Sort-Object lastWriteUtc -Descending | Select-Object -First 1200)
}

function Protect-SensitiveObject {
    param($Value, [string]$KeyName = '')

    if ($KeyName -match '(?i)(token|ticket|cookie|secret|password|passwd|session|credential|auth|openid|unionid|(^|_)key($|_)|(^|_)code($|_))') {
        return '[REDACTED]'
    }
    if ($null -eq $Value) { return $null }

    if ($Value -is [System.Collections.IDictionary]) {
        $out = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $out[[string]$key] = Protect-SensitiveObject $Value[$key] ([string]$key)
        }
        return $out
    }

    if ($Value -is [pscustomobject]) {
        $out = [ordered]@{}
        foreach ($prop in $Value.PSObject.Properties) {
            $out[$prop.Name] = Protect-SensitiveObject $prop.Value $prop.Name
        }
        return $out
    }

    if (($Value -is [System.Collections.IEnumerable]) -and -not ($Value -is [string])) {
        $out = @()
        foreach ($item in $Value) { $out += ,(Protect-SensitiveObject $item '') }
        return $out
    }

    if ($Value -is [string] -and $Value.Length -gt 1024) {
        return ('[LONG_STRING_REDACTED length={0}]' -f $Value.Length)
    }
    return $Value
}

function Get-LaunchConfigSummary {
    param([array]$AppRoots)
    $rows = @()
    foreach ($root in $AppRoots) {
        $realRoot = Join-Path (Join-Path $env:APPDATA 'Tencent\xwechat\radium\users') ([string]$root.profileId)
        $file = Join-Path (Join-Path $realRoot ("applet\local\{0}" -f $AppId)) 'launch.config'
        if (-not (Test-Path -LiteralPath $file)) { continue }

        $item = Get-Item -LiteralPath $file
        $entry = [ordered]@{
            profileId = [string]$root.profileId
            path = Convert-ToSafePath $file
            length = [int64]$item.Length
            lastWriteUtc = $item.LastWriteTimeUtc.ToString('o')
            format = 'unknown'
            redactedContent = $null
            discoveredKeys = @()
        }

        if ($item.Length -le 65536) {
            $text = [IO.File]::ReadAllText($file)
            try {
                $parsed = $text | ConvertFrom-Json
                $entry.format = 'json'
                $entry.redactedContent = Protect-SensitiveObject $parsed
            } catch {
                $entry.format = 'non-json'
                $entry.discoveredKeys = @([regex]::Matches($text, '(?i)["'']([A-Za-z0-9_.-]{1,80})["'']\s*[:=]') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique | Select-Object -First 100)
            }
        } else {
            $entry.format = 'too-large'
        }
        $rows += $entry
    }
    return @($rows)
}

function Get-InventoryDiff {
    param([array]$Before, [array]$After)
    $map = @{}
    foreach ($item in $Before) { $map[[string]$item.path] = $item }
    $rows = @()
    foreach ($item in $After) {
        $old = $map[[string]$item.path]
        if ($null -eq $old) {
            $rows += [ordered]@{ change = 'created'; path = $item.path; profileId = $item.profileId; length = $item.length; lastWriteUtc = $item.lastWriteUtc }
            continue
        }
        if ([int64]$old.length -ne [int64]$item.length -or [string]$old.lastWriteUtc -ne [string]$item.lastWriteUtc) {
            $rows += [ordered]@{ change = 'modified'; path = $item.path; profileId = $item.profileId; length = $item.length; lastWriteUtc = $item.lastWriteUtc }
        }
    }
    return @($rows | Sort-Object lastWriteUtc -Descending | Select-Object -First 300)
}

Write-Host ''
Write-Host 'FAR2 微信农场 P1 差分探针' -ForegroundColor Cyan
Write-Host '=========================='
Write-Host '请保持微信电脑版已登录。'
Write-Host '先关闭“农场小程序窗口”，不要退出微信。' -ForegroundColor Yellow
Write-Host '本探针不会读取聊天数据库/聊天内容，也不会抓 Cookie、Token、登录 Code。'
Write-Host ''
Read-Host '确认农场窗口已关闭后，按 Enter 记录基线'

$appRootsBefore = Get-AppRoots
$processesBefore = Get-WeChatProcessSnapshot
$windowsBefore = Get-WeChatWindows -Processes $processesBefore
$inventoryBefore = Get-AppInventory -AppRoots $appRootsBefore
$baselineAt = (Get-Date).ToUniversalTime()

Write-Host ''
Write-Host '现在请从【微信电脑版】打开 QQ经典农场，等农场主页完全加载。' -ForegroundColor Green
Read-Host '主页加载完成后，回到这里按 Enter 继续'
Start-Sleep -Milliseconds 800

$appRootsAfter = Get-AppRoots
$processesAfter = Get-WeChatProcessSnapshot
$windowsAfter = Get-WeChatWindows -Processes $processesAfter
$inventoryAfter = Get-AppInventory -AppRoots $appRootsAfter
$launchConfigs = Get-LaunchConfigSummary -AppRoots $appRootsAfter
$capturedAt = (Get-Date).ToUniversalTime()

$beforePids = @{}
foreach ($proc in $processesBefore) { $beforePids[[int]$proc.pid] = $true }
$newProcesses = @($processesAfter | Where-Object { -not $beforePids.ContainsKey([int]$_.pid) })
$newAppEx = @($newProcesses | Where-Object { [string]$_.name -match '(?i)^(WeChatAppEx|WeixinAppEx)\.exe$' })
$changedFiles = Get-InventoryDiff -Before $inventoryBefore -After $inventoryAfter
$sessionIds = @($processesAfter | ForEach-Object { [int]$_['sessionId'] } | Sort-Object -Unique)
$visibleWindows = @($windowsAfter | Where-Object { $_.visible })

$report = [ordered]@{
    version = 2
    phase = 'wechat-farm-p1-diff'
    generatedAt = $capturedAt.ToString('o')
    appId = $AppId
    safety = [ordered]@{
        readOnly = $true
        chatDatabaseRead = $false
        messageContentRead = $false
        cookieOrTokenCapture = $false
        rawProcessCommandLineStored = $false
        appSpecificFileContentsRead = @('launch.config')
        launchConfigSensitiveFieldsRedacted = $true
    }
    captureWindow = [ordered]@{
        baselineAt = $baselineAt.ToString('o')
        afterFarmLoadedAt = $capturedAt.ToString('o')
        durationSeconds = [Math]::Round(($capturedAt - $baselineAt).TotalSeconds, 1)
    }
    summary = [ordered]@{
        matchingSessionIds = $sessionIds
        appRootCount = @($appRootsAfter).Count
        processCountBefore = @($processesBefore).Count
        processCountAfter = @($processesAfter).Count
        newProcessCount = @($newProcesses).Count
        newWeChatAppExCount = @($newAppEx).Count
        windowCountAfter = @($windowsAfter).Count
        visibleWindowCountAfter = @($visibleWindows).Count
        changedAppFileCount = @($changedFiles).Count
        launchConfigCount = @($launchConfigs).Count
    }
    appRoots = $appRootsAfter
    newProcessesAfterOpeningFarm = $newProcesses
    newWeChatAppExAfterOpeningFarm = $newAppEx
    windowsAfterOpeningFarm = $windowsAfter
    changedFarmAppFiles = $changedFiles
    launchConfigs = $launchConfigs
    processSnapshotBefore = $processesBefore
    processSnapshotAfter = $processesAfter
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $dir = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputPath = Join-Path $dir ("wechat-farm-p1-{0}.json" -f $stamp)
} else {
    $parent = Split-Path -Parent $OutputPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($OutputPath, ($report | ConvertTo-Json -Depth 12), $utf8NoBom)

Write-Host ''
Write-Host '采集完成。' -ForegroundColor Green
Write-Host ("Session: {0}" -f ($sessionIds -join ', '))
Write-Host ("农场 App 根目录: {0}" -f $report.summary.appRootCount)
Write-Host ("打开农场后新增微信进程: {0}" -f $report.summary.newProcessCount)
Write-Host ("其中新增 WeChatAppEx: {0}" -f $report.summary.newWeChatAppExCount)
Write-Host ("打开后可见微信窗口: {0}" -f $report.summary.visibleWindowCountAfter)
Write-Host ("农场目录变化文件: {0}" -f $report.summary.changedAppFileCount)
Write-Host ''
Write-Host '报告:'
Write-Host $OutputPath -ForegroundColor Cyan
Write-Host ''
Write-Host '把这个 wechat-farm-p1-*.json 发给我即可。'

try {
    Start-Process explorer.exe -ArgumentList "/select,`"$OutputPath`""
} catch {}
