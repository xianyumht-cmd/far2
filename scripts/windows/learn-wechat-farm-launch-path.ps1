param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$AppId = 'wx5306c5978fdb76e4'
$FarmTitle = 'QQ' + [char]0x7ECF + [char]0x5178 + [char]0x519C + [char]0x573A
$ReportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$ProfileRoot = Join-Path $env:LOCALAPPDATA 'FAR2'
$ProfilePath = Join-Path $ProfileRoot 'wechat-launch-profile.json'
$ExcludedPathPattern = '(?i)(\\|/)(Msg|Message|MsgAttach|FileStorage|ChatMsg|Contact|History|Backup)(\\|/|$)'

function Convert-ToSafePath {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $safe = [string]$Value
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
    return ([string]$Path -match $ExcludedPathPattern)
}

function Normalize-MiniProgramPath {
    param([string]$Value)
    $path = [string]$Value
    if ([string]::IsNullOrWhiteSpace($path)) { return '' }
    $path = $path.Replace('\/', '/').Trim()
    while ($path.StartsWith('/')) { $path = $path.Substring(1) }
    $path = ($path -split '[?#]', 2)[0]
    if ([string]::IsNullOrWhiteSpace($path)) { return '' }
    if ($path.Length -gt 256) { return '' }
    if ($path.Contains('..') -or $path.Contains('\') -or $path.Contains(':')) { return '' }
    if ($path -notmatch '^[A-Za-z0-9_./-]+$') { return '' }
    if ($path -notmatch '^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)+$') { return '' }
    return $path
}

function Get-TextFileContent {
    param([System.IO.FileInfo]$File)
    if (-not $File -or $File.Length -le 0 -or $File.Length -gt 1048576) { return '' }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($File.FullName)
        if ($bytes.Length -eq 0) { return '' }
        if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
            return [System.Text.Encoding]::Unicode.GetString($bytes)
        }
        if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
            return [System.Text.Encoding]::BigEndianUnicode.GetString($bytes)
        }
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    catch { return '' }
}

function Add-Candidate {
    param(
        [hashtable]$Map,
        [string]$Route,
        [int]$Score,
        [string]$Source,
        [string]$FilePath,
        [bool]$AppIdInPath,
        [bool]$AppIdInContent,
        [datetime]$LastWriteUtc
    )
    $normalized = Normalize-MiniProgramPath $Route
    if ([string]::IsNullOrWhiteSpace($normalized)) { return }
    $key = $normalized.ToLowerInvariant()
    $row = [ordered]@{
        path = $normalized
        score = $Score
        source = $Source
        file = Convert-ToSafePath $FilePath
        appIdInPath = $AppIdInPath
        appIdInContent = $AppIdInContent
        lastWriteUtc = $LastWriteUtc.ToString('o')
    }
    if (-not $Map.ContainsKey($key) -or [int]$Map[$key].score -lt $Score) {
        $Map[$key] = $row
    }
}

Write-Host ''
Write-Host 'FAR2 WeChat farm launch-path learner' -ForegroundColor Cyan
Write-Host '------------------------------------'
Write-Host 'This is a one-time bootstrap for the unattended P7 launcher.'
Write-Host 'It reads only WeChat mini-program runtime/config files under xwechat.'
Write-Host 'Chat/message/contact/storage paths are explicitly excluded.'
Write-Host ''

$openFarm = @(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object {
    [string]$_.MainWindowTitle -eq $FarmTitle
})
if ($openFarm.Count -eq 0) {
    Write-Host 'Open QQ Classic Farm manually in desktop WeChat and wait for the home screen.' -ForegroundColor Yellow
    [void](Read-Host 'Then return here and press Enter')
    Start-Sleep -Milliseconds 700
    $openFarm = @(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.MainWindowTitle -eq $FarmTitle
    })
}
if ($openFarm.Count -eq 0) {
    throw 'QQ Classic Farm window was not detected. Keep desktop WeChat logged in and open the farm before running this learner.'
}

$roots = @(
    (Join-Path $env:APPDATA 'Tencent\xwechat'),
    (Join-Path $env:LOCALAPPDATA 'Tencent\xwechat')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

if (@($roots).Count -eq 0) { throw 'No Tencent\xwechat runtime root was found.' }

$profileRoots = New-Object System.Collections.ArrayList
$appidHits = New-Object System.Collections.ArrayList
foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        if (Test-ExcludedPath $_.FullName) { return }
        if ([string]$_.FullName -notmatch [regex]::Escape($AppId)) { return }
        [void]$appidHits.Add($_)
        $cursor = if ($_.PSIsContainer) { $_ } else { $_.Directory }
        $fallback = $cursor
        while ($cursor) {
            if ([string]$cursor.Name -match '^[0-9a-fA-F]{32}$') {
                if (-not ($profileRoots -contains $cursor.FullName)) { [void]$profileRoots.Add($cursor.FullName) }
                break
            }
            $cursor = $cursor.Parent
        }
        if ($fallback -and -not ($profileRoots -contains $fallback.FullName)) {
            [void]$profileRoots.Add($fallback.FullName)
        }
    }
}

if ($profileRoots.Count -eq 0) {
    foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root -Filter 'launch.config' -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
            -not (Test-ExcludedPath $_.FullName)
        } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 12 | ForEach-Object {
            if (-not ($profileRoots -contains $_.Directory.FullName)) { [void]$profileRoots.Add($_.Directory.FullName) }
        }
    }
}

$candidateFiles = New-Object System.Collections.ArrayList
$seenFiles = @{}
foreach ($profile in @($profileRoots)) {
    if (-not (Test-Path -LiteralPath $profile) -or (Test-ExcludedPath $profile)) { continue }
    Get-ChildItem -LiteralPath $profile -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
        $_.Length -gt 0 -and $_.Length -le 1048576 -and
        -not (Test-ExcludedPath $_.FullName) -and
        ($_.Name -match '(?i)^(launch\.config|app\.json|game\.json|app-config\.json|game\.config\.json|config\.json)$')
    } | ForEach-Object {
        $key = $_.FullName.ToLowerInvariant()
        if (-not $seenFiles.ContainsKey($key)) {
            $seenFiles[$key] = $true
            [void]$candidateFiles.Add($_)
        }
    }
}

# If the exact app directory did not expose standard config names, inspect only
# recently touched small config/json files under xwechat. This remains outside
# all excluded chat/message/contact/storage path classes.
if ($candidateFiles.Count -eq 0) {
    $cutoff = (Get-Date).ToUniversalTime().AddHours(-2)
    foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.Length -gt 0 -and $_.Length -le 1048576 -and
            $_.LastWriteTimeUtc -ge $cutoff -and
            -not (Test-ExcludedPath $_.FullName) -and
            ($_.Name -match '(?i)(launch|app|game|config)')
        } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 80 | ForEach-Object {
            $key = $_.FullName.ToLowerInvariant()
            if (-not $seenFiles.ContainsKey($key)) {
                $seenFiles[$key] = $true
                [void]$candidateFiles.Add($_)
            }
        }
    }
}

$map = @{}
$nowUtc = (Get-Date).ToUniversalTime()
foreach ($file in @($candidateFiles)) {
    $text = Get-TextFileContent $file
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    $appIdInPath = [string]$file.FullName -match [regex]::Escape($AppId)
    $appIdInContent = $text.IndexOf($AppId, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $recent = (($nowUtc - $file.LastWriteTimeUtc).TotalMinutes -le 60)
    $baseScore = 0
    if ($appIdInPath) { $baseScore += 80 }
    if ($appIdInContent) { $baseScore += 80 }
    if ($file.Name -ieq 'launch.config') { $baseScore += 60 }
    if ($recent) { $baseScore += 40 }

    foreach ($m in [regex]::Matches($text, '(?i)"(?:path|pagePath|entryPagePath|route)"\s*:\s*"([^"\r\n]{1,300})"')) {
        Add-Candidate -Map $map -Route $m.Groups[1].Value -Score ($baseScore + 35) -Source 'named_path_key' -FilePath $file.FullName -AppIdInPath $appIdInPath -AppIdInContent $appIdInContent -LastWriteUtc $file.LastWriteTimeUtc
    }
    foreach ($m in [regex]::Matches($text, '(?is)"pages"\s*:\s*\[\s*"([^"\r\n]{1,300})"')) {
        Add-Candidate -Map $map -Route $m.Groups[1].Value -Score ($baseScore + 30) -Source 'manifest_first_page' -FilePath $file.FullName -AppIdInPath $appIdInPath -AppIdInContent $appIdInContent -LastWriteUtc $file.LastWriteTimeUtc
    }
    foreach ($m in [regex]::Matches($text, '(?i)(?:^|["''=:,\s])(pages/[A-Za-z0-9_./-]{2,240})')) {
        Add-Candidate -Map $map -Route $m.Groups[1].Value -Score ($baseScore + 15) -Source 'pages_route_literal' -FilePath $file.FullName -AppIdInPath $appIdInPath -AppIdInContent $appIdInContent -LastWriteUtc $file.LastWriteTimeUtc
    }
}

$candidates = @($map.Values | Sort-Object @{ Expression = { [int]$_.score }; Descending = $true }, @{ Expression = { [string]$_.path }; Descending = $false } | Select-Object -First 20)
$selected = $null
if ($candidates.Count -gt 0) {
    $top = $candidates[0]
    $secondScore = if ($candidates.Count -gt 1) { [int]$candidates[1].score } else { -1 }
    $topHasExactEvidence = [bool]$top.appIdInPath -or [bool]$top.appIdInContent -or ([string]$top.source -eq 'named_path_key' -and [int]$top.score -ge 120)
    if ([int]$top.score -ge 90 -and $topHasExactEvidence -and ($candidates.Count -eq 1 -or ([int]$top.score - $secondScore) -ge 20)) {
        $selected = $top
    }
}

New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportPath = Join-Path $ReportRoot "wechat-launch-path-evidence-$stamp.json"
$report = [ordered]@{
    version = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    appId = $AppId
    farmWindowDetected = $true
    safety = [ordered]@{
        readOnly = $true
        chatDatabaseRead = $false
        messageContentRead = $false
        contactDataRead = $false
        tokenOrCookieCaptured = $false
        rawWxLoginCodeCaptured = $false
        excludedPathClasses = @('Msg','Message','MsgAttach','FileStorage','ChatMsg','Contact','History','Backup')
        persistedData = 'mini-program appId + published page path only'
    }
    discovery = [ordered]@{
        xwechatRootCount = @($roots).Count
        appIdPathHitCount = $appidHits.Count
        candidateProfileRootCount = $profileRoots.Count
        candidateConfigFileCount = $candidateFiles.Count
        routeCandidateCount = $candidates.Count
    }
    selected = if ($selected) {
        [ordered]@{
            path = [string]$selected.path
            score = [int]$selected.score
            source = [string]$selected.source
            file = [string]$selected.file
        }
    } else { $null }
    candidates = @($candidates | ForEach-Object {
        [ordered]@{
            path = [string]$_.path
            score = [int]$_.score
            source = [string]$_.source
            file = [string]$_.file
            appIdInPath = [bool]$_.appIdInPath
            appIdInContent = [bool]$_.appIdInContent
            lastWriteUtc = [string]$_.lastWriteUtc
        }
    })
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 8), $utf8NoBom)

Write-Host ''
Write-Host ("AppId path hits: {0}" -f $appidHits.Count)
Write-Host ("Candidate config files: {0}" -f $candidateFiles.Count)
Write-Host ("Route candidates: {0}" -f $candidates.Count)

if ($selected) {
    New-Item -ItemType Directory -Force -Path $ProfileRoot | Out-Null
    $profile = [ordered]@{
        version = 1
        appId = $AppId
        path = [string]$selected.path
        learnedAt = (Get-Date).ToUniversalTime().ToString('o')
        evidenceSource = [string]$selected.source
    }
    [System.IO.File]::WriteAllText($ProfilePath, ($profile | ConvertTo-Json -Depth 4), $utf8NoBom)
    Write-Host 'Exact launch path learned and saved locally.' -ForegroundColor Green
    Write-Host ("Profile: {0}" -f $ProfilePath)
    Write-Host 'You can now run test-wechat-final-recovery-gate.cmd.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Evidence report:'
    Write-Host $reportPath
    exit 0
}

Write-Host 'No single exact launch path could be proven automatically.' -ForegroundColor Yellow
Write-Host 'Do not rerun P7 yet. Send the evidence report for a targeted follow-up.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Evidence report:'
Write-Host $reportPath
exit 2
