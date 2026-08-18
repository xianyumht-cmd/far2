param(
    [string]$AppId = 'wx5306c5978fdb76e4',
    [int]$RecentMinutes = 20,
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'SilentlyContinue'

function Convert-ToSafePath {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }

    $safe = $Value
    $replacements = @(
        @($env:USERPROFILE, '%USERPROFILE%'),
        @($env:APPDATA, '%APPDATA%'),
        @($env:LOCALAPPDATA, '%LOCALAPPDATA%')
    )

    foreach ($pair in $replacements) {
        $from = [string]$pair[0]
        $to = [string]$pair[1]
        if (-not [string]::IsNullOrWhiteSpace($from)) {
            $safe = $safe.Replace($from, $to)
        }
    }
    return $safe
}

function Test-ExcludedPath {
    param([string]$Path)
    $text = [string]$Path
    return ($text -match '(?i)(\\|/)(Msg|Message|MsgAttach|FileStorage|ChatMsg|Contact|History|Backup)(\\|/)')
}

function Get-ProcessSnapshot {
    $namePattern = '(?i)(wechat|weixin|wmpf|wechatappex|weixinappex|miniprogram)'
    $rows = @()

    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match $namePattern -or $_.ExecutablePath -match $namePattern
    } | ForEach-Object {
        $rows += [ordered]@{
            name = [string]$_.Name
            pid = [int]$_.ProcessId
            parentPid = [int]$_.ParentProcessId
            sessionId = [int]$_.SessionId
            executablePath = Convert-ToSafePath ([string]$_.ExecutablePath)
        }
    }

    return @($rows | Sort-Object sessionId, name, pid)
}

function Get-RootCandidates {
    $roots = @(
        (Join-Path $env:APPDATA 'Tencent\WeChat'),
        (Join-Path $env:APPDATA 'Tencent\xwechat'),
        (Join-Path $env:LOCALAPPDATA 'Tencent\WeChat'),
        (Join-Path $env:LOCALAPPDATA 'Tencent\xwechat'),
        (Join-Path $env:APPDATA 'Tencent\WeChatAppStore'),
        (Join-Path $env:LOCALAPPDATA 'Tencent\WeChatAppStore'),
        (Join-Path $env:USERPROFILE 'Documents\WeChat Files'),
        (Join-Path $env:USERPROFILE 'Documents\xwechat_files')
    )

    $unique = @{}
    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $key = $root.ToLowerInvariant()
        if (-not $unique.ContainsKey($key)) {
            $unique[$key] = $root
        }
    }

    $result = @()
    foreach ($root in $unique.Values) {
        $result += [ordered]@{
            path = Convert-ToSafePath $root
            exists = [bool](Test-Path -LiteralPath $root)
        }
    }
    return @($result | Sort-Object path)
}

function Get-InterestingDirectories {
    param([array]$RootCandidates)

    $namePattern = '(?i)(wmpf|mini|appstore|applet|plugin|xplugin|runtime|cache)'
    $rows = @()

    foreach ($rootInfo in $RootCandidates) {
        if (-not $rootInfo.exists) { continue }

        $realRoot = [string]$rootInfo.path
        $realRoot = $realRoot.Replace('%USERPROFILE%', $env:USERPROFILE)
        $realRoot = $realRoot.Replace('%APPDATA%', $env:APPDATA)
        $realRoot = $realRoot.Replace('%LOCALAPPDATA%', $env:LOCALAPPDATA)

        Get-ChildItem -LiteralPath $realRoot -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            $level1 = $_
            if (-not (Test-ExcludedPath $level1.FullName) -and $level1.Name -match $namePattern) {
                $rows += [ordered]@{
                    path = Convert-ToSafePath $level1.FullName
                    lastWriteUtc = $level1.LastWriteTimeUtc.ToString('o')
                }
            }

            Get-ChildItem -LiteralPath $level1.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
                $level2 = $_
                if (-not (Test-ExcludedPath $level2.FullName) -and $level2.Name -match $namePattern) {
                    $rows += [ordered]@{
                        path = Convert-ToSafePath $level2.FullName
                        lastWriteUtc = $level2.LastWriteTimeUtc.ToString('o')
                    }
                }
            }
        }
    }

    $seen = @{}
    $deduped = @()
    foreach ($row in ($rows | Sort-Object lastWriteUtc -Descending)) {
        $key = ([string]$row.path).ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $deduped += $row
        }
        if ($deduped.Count -ge 80) { break }
    }
    return @($deduped)
}

function Get-RecentRuntimeFiles {
    param([array]$RootCandidates, [int]$Minutes)

    $cutoff = (Get-Date).ToUniversalTime().AddMinutes(-1 * [Math]::Abs($Minutes))
    $rows = @()
    $fileBudget = 0
    $maxVisited = 12000

    foreach ($rootInfo in $RootCandidates) {
        if (-not $rootInfo.exists -or $fileBudget -ge $maxVisited) { continue }

        $realRoot = [string]$rootInfo.path
        $realRoot = $realRoot.Replace('%USERPROFILE%', $env:USERPROFILE)
        $realRoot = $realRoot.Replace('%APPDATA%', $env:APPDATA)
        $realRoot = $realRoot.Replace('%LOCALAPPDATA%', $env:LOCALAPPDATA)

        Get-ChildItem -LiteralPath $realRoot -File -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ($fileBudget -ge $maxVisited) { return }
            $fileBudget++

            if (Test-ExcludedPath $_.FullName) { return }
            if ($_.LastWriteTimeUtc -lt $cutoff) { return }

            $safePath = Convert-ToSafePath $_.FullName
            $lower = $safePath.ToLowerInvariant()
            if ($lower -notmatch '(wmpf|mini|applet|appstore|xplugin|runtime|cache)' -and $lower -notmatch [regex]::Escape($AppId.ToLowerInvariant())) {
                return
            }

            $rows += [ordered]@{
                path = $safePath
                length = [int64]$_.Length
                lastWriteUtc = $_.LastWriteTimeUtc.ToString('o')
                appIdInPath = [bool]($lower -match [regex]::Escape($AppId.ToLowerInvariant()))
            }
        }
    }

    return @($rows | Sort-Object lastWriteUtc -Descending | Select-Object -First 160)
}

$processes = Get-ProcessSnapshot
$roots = Get-RootCandidates
$interestingDirs = Get-InterestingDirectories -RootCandidates $roots
$recentFiles = Get-RecentRuntimeFiles -RootCandidates $roots -Minutes $RecentMinutes

$sessionIds = @($processes | Select-Object -ExpandProperty sessionId -Unique)
$report = [ordered]@{
    version = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    appIdUnderTest = $AppId
    recentMinutes = $RecentMinutes
    safety = [ordered]@{
        readOnly = $true
        chatDatabaseRead = $false
        messageContentRead = $false
        cookieOrTokenCapture = $false
        excludedPathClasses = @('Msg', 'Message', 'MsgAttach', 'FileStorage', 'ChatMsg', 'Contact', 'History', 'Backup')
    }
    summary = [ordered]@{
        matchingProcessCount = @($processes).Count
        matchingSessionIds = $sessionIds
        existingRootCount = @($roots | Where-Object { $_.exists }).Count
        interestingDirectoryCount = @($interestingDirs).Count
        recentRuntimeFileCount = @($recentFiles).Count
        appIdPathHitCount = @($recentFiles | Where-Object { $_.appIdInPath }).Count
    }
    processes = $processes
    roots = $roots
    interestingDirectories = $interestingDirs
    recentRuntimeFiles = $recentFiles
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $dir = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputPath = Join-Path $dir "wechat-probe-$stamp.json"
} else {
    $parent = Split-Path -Parent $OutputPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$json = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($OutputPath, $json, $utf8NoBom)

Write-Host ''
Write-Host 'FAR2 WeChat Windows Probe' -ForegroundColor Cyan
Write-Host '------------------------'
Write-Host ("微信相关进程: {0}" -f $report.summary.matchingProcessCount)
Write-Host ("Windows Session: {0}" -f (($report.summary.matchingSessionIds -join ', ')))
Write-Host ("微信候选根目录: {0}" -f $report.summary.existingRootCount)
Write-Host ("小程序/运行时目录: {0}" -f $report.summary.interestingDirectoryCount)
Write-Host ("最近 {0} 分钟运行时文件: {1}" -f $RecentMinutes, $report.summary.recentRuntimeFileCount)
Write-Host ("AppId 路径命中: {0}" -f $report.summary.appIdPathHitCount)
Write-Host ''
Write-Host '报告已生成:' -ForegroundColor Green
Write-Host $OutputPath
Write-Host ''
Write-Host '报告不读取聊天数据库/聊天内容，也不抓取 Cookie、Token 或登录凭证。'

try {
    Start-Process explorer.exe -ArgumentList "/select,`"$OutputPath`""
} catch {}
