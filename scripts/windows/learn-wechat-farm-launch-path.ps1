param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$AppId = 'wx5306c5978fdb76e4'
$FarmTitle = 'QQ' + [char]0x7ECF + [char]0x5178 + [char]0x519C + [char]0x573A
$ReportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$ProfileRoot = Join-Path $env:LOCALAPPDATA 'FAR2'
$ProfilePath = Join-Path $ProfileRoot 'wechat-launch-profile.json'
$ExcludedPathPattern = '(?i)(\\|/)(Msg|Message|MsgAttach|FileStorage|ChatMsg|Contact|History|Backup)(\\|/|$)'
$MaxTextBytes = 2MB

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
    if (-not $File -or $File.Length -le 0 -or $File.Length -gt $MaxTextBytes) { return '' }
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

function Find-ExactAnchorDirectory {
    param([System.IO.FileSystemInfo]$Hit)
    if (-not $Hit) { return $null }

    $cursor = if ($Hit.PSIsContainer) { [System.IO.DirectoryInfo]$Hit } else { $Hit.Directory }
    while ($cursor) {
        if ([string]$cursor.Name -match [regex]::Escape($AppId)) {
            return $cursor
        }
        $cursor = $cursor.Parent
    }

    # Some xwechat builds put the AppId in a file name while its containing
    # directory has an opaque hash. In that case the direct parent is still
    # exact evidence because the hit itself carries the target AppId.
    if (-not $Hit.PSIsContainer -and [string]$Hit.Name -match [regex]::Escape($AppId)) {
        return $Hit.Directory
    }
    return $null
}

function Add-Candidate {
    param(
        [hashtable]$Map,
        [string]$Route,
        [int]$Score,
        [string]$Source,
        [System.IO.FileInfo]$File,
        [bool]$ExactAnchor,
        [bool]$AppIdInPath,
        [bool]$AppIdInContent
    )
    $normalized = Normalize-MiniProgramPath $Route
    if ([string]::IsNullOrWhiteSpace($normalized)) { return }

    $key = $normalized.ToLowerInvariant()
    $row = [ordered]@{
        path = $normalized
        score = $Score
        source = $Source
        file = Convert-ToSafePath $File.FullName
        exactAnchor = $ExactAnchor
        appIdInPath = $AppIdInPath
        appIdInContent = $AppIdInContent
        lastWriteUtc = $File.LastWriteTimeUtc.ToString('o')
    }
    if (-not $Map.ContainsKey($key) -or [int]$Map[$key].score -lt $Score) {
        $Map[$key] = $row
    }
}

Write-Host ''
Write-Host 'FAR2 WeChat farm launch-path learner v2' -ForegroundColor Cyan
Write-Host '---------------------------------------'
Write-Host 'This one-time learner is scoped to the exact farm AppId subtree.'
Write-Host 'It does not call wx.login and excludes chat/message/contact/storage paths.'
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

$appidHits = New-Object System.Collections.ArrayList
$anchorMap = @{}
foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        if (Test-ExcludedPath $_.FullName) { return }
        if ([string]$_.FullName -notmatch [regex]::Escape($AppId)) { return }
        [void]$appidHits.Add($_)
        $anchor = Find-ExactAnchorDirectory $_
        if ($anchor -and -not (Test-ExcludedPath $anchor.FullName)) {
            $key = $anchor.FullName.ToLowerInvariant()
            if (-not $anchorMap.ContainsKey($key)) {
                $anchorMap[$key] = [ordered]@{
                    path = $anchor.FullName
                    hitCount = 0
                    newestUtc = [datetime]::MinValue
                }
            }
            $anchorMap[$key].hitCount = [int]$anchorMap[$key].hitCount + 1
            if ($_.LastWriteTimeUtc -gt [datetime]$anchorMap[$key].newestUtc) {
                $anchorMap[$key].newestUtc = $_.LastWriteTimeUtc
            }
        }
    }
}

$anchors = @($anchorMap.Values | Sort-Object @{ Expression = { [int]$_.hitCount }; Descending = $true }, @{ Expression = { [datetime]$_.newestUtc }; Descending = $true } | Select-Object -First 64)

$candidateFiles = New-Object System.Collections.ArrayList
$seenFiles = @{}
foreach ($anchorInfo in $anchors) {
    $anchorPath = [string]$anchorInfo.path
    if (-not (Test-Path -LiteralPath $anchorPath) -or (Test-ExcludedPath $anchorPath)) { continue }

    Get-ChildItem -LiteralPath $anchorPath -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
        $_.Length -gt 0 -and $_.Length -le $MaxTextBytes -and
        -not (Test-ExcludedPath $_.FullName) -and
        ($_.Name -match '(?i)(^launch\.config$|^app\.json$|^game\.json$|^app-config\.json$|^game\.config\.json$|^config\.json$|manifest|launch|config)')
    } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 120 | ForEach-Object {
        $key = $_.FullName.ToLowerInvariant()
        if (-not $seenFiles.ContainsKey($key)) {
            $seenFiles[$key] = $true
            [void]$candidateFiles.Add($_)
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
    $exactAnchor = $appIdInPath
    if (-not $exactAnchor) {
        foreach ($anchorInfo in $anchors) {
            $prefix = ([string]$anchorInfo.path).TrimEnd('\') + '\'
            if ($file.FullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $exactAnchor = $true
                break
            }
        }
    }

    $recent = (($nowUtc - $file.LastWriteTimeUtc).TotalMinutes -le 120)
    $baseScore = 0
    if ($exactAnchor) { $baseScore += 120 }
    if ($appIdInPath) { $baseScore += 80 }
    if ($appIdInContent) { $baseScore += 80 }
    if ($file.Name -ieq 'launch.config') { $baseScore += 100 }
    elseif ($file.Name -ieq 'app.json') { $baseScore += 35 }
    if ($recent) { $baseScore += 30 }

    foreach ($m in [regex]::Matches($text, '(?i)"(?:path|pagePath|entryPagePath|route)"\s*:\s*"([^"\r\n]{1,300})"')) {
        $bonus = if ($file.Name -ieq 'launch.config') { 110 } else { 45 }
        Add-Candidate -Map $map -Route $m.Groups[1].Value -Score ($baseScore + $bonus) -Source ($(if ($file.Name -ieq 'launch.config') { 'exact_launch_config_path' } else { 'named_path_key' })) -File $file -ExactAnchor $exactAnchor -AppIdInPath $appIdInPath -AppIdInContent $appIdInContent
    }
    foreach ($m in [regex]::Matches($text, '(?is)"pages"\s*:\s*\[\s*"([^"\r\n]{1,300})"')) {
        Add-Candidate -Map $map -Route $m.Groups[1].Value -Score ($baseScore + 100) -Source 'exact_manifest_first_page' -File $file -ExactAnchor $exactAnchor -AppIdInPath $appIdInPath -AppIdInContent $appIdInContent
    }
    foreach ($m in [regex]::Matches($text, '(?i)(?:^|["''=:,\s])(pages/[A-Za-z0-9_./-]{2,240})')) {
        Add-Candidate -Map $map -Route $m.Groups[1].Value -Score ($baseScore + 20) -Source 'pages_route_literal' -File $file -ExactAnchor $exactAnchor -AppIdInPath $appIdInPath -AppIdInContent $appIdInContent
    }
}

$candidates = @($map.Values | Sort-Object @{ Expression = { [int]$_.score }; Descending = $true }, @{ Expression = { [string]$_.path }; Descending = $false } | Select-Object -First 30)
$selected = $null
if ($candidates.Count -gt 0) {
    $top = $candidates[0]
    $secondScore = if ($candidates.Count -gt 1) { [int]$candidates[1].score } else { -1 }
    $strongSource = [string]$top.source -in @('exact_launch_config_path', 'exact_manifest_first_page')
    $strongExact = [bool]$top.exactAnchor -and ($strongSource -or [bool]$top.appIdInPath -or [bool]$top.appIdInContent)

    # An exact launch.config route or the first page from an app.json that lives
    # under the exact AppId subtree is already positive published-path evidence.
    # For weaker generic literals keep the score-gap fail-closed rule.
    if ($strongExact -and [int]$top.score -ge 220) {
        $selected = $top
    }
    elseif ([bool]$top.exactAnchor -and [int]$top.score -ge 260 -and ($candidates.Count -eq 1 -or ([int]$top.score - $secondScore) -ge 20)) {
        $selected = $top
    }
}

New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportPath = Join-Path $ReportRoot "wechat-launch-path-evidence-$stamp.json"

$hitSamples = @($appidHits | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 30 | ForEach-Object {
    [ordered]@{
        path = Convert-ToSafePath $_.FullName
        isDirectory = [bool]$_.PSIsContainer
        lastWriteUtc = $_.LastWriteTimeUtc.ToString('o')
    }
})

$report = [ordered]@{
    version = 2
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
        exactAnchorRootCount = $anchors.Count
        candidateConfigFileCount = $candidateFiles.Count
        routeCandidateCount = $candidates.Count
    }
    exactAnchors = @($anchors | ForEach-Object {
        [ordered]@{
            path = Convert-ToSafePath ([string]$_.path)
            hitCount = [int]$_.hitCount
            newestUtc = ([datetime]$_.newestUtc).ToString('o')
        }
    })
    appIdHitSamples = $hitSamples
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
            exactAnchor = [bool]$_.exactAnchor
            appIdInPath = [bool]$_.appIdInPath
            appIdInContent = [bool]$_.appIdInContent
            lastWriteUtc = [string]$_.lastWriteUtc
        }
    })
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 9), $utf8NoBom)

Write-Host ''
Write-Host ("AppId path hits: {0}" -f $appidHits.Count)
Write-Host ("Exact AppId anchors: {0}" -f $anchors.Count)
Write-Host ("Candidate config files: {0}" -f $candidateFiles.Count)
Write-Host ("Route candidates: {0}" -f $candidates.Count)

if ($selected) {
    New-Item -ItemType Directory -Force -Path $ProfileRoot | Out-Null
    $profile = [ordered]@{
        version = 2
        appId = $AppId
        path = [string]$selected.path
        learnedAt = (Get-Date).ToUniversalTime().ToString('o')
        evidenceSource = [string]$selected.source
        evidenceFile = [string]$selected.file
    }
    [System.IO.File]::WriteAllText($ProfilePath, ($profile | ConvertTo-Json -Depth 4), $utf8NoBom)
    Write-Host 'Exact launch path learned and saved locally.' -ForegroundColor Green
    Write-Host ("Launch path: {0}" -f $selected.path) -ForegroundColor Green
    Write-Host ("Evidence: {0}" -f $selected.source) -ForegroundColor DarkGray
    Write-Host ("Profile: {0}" -f $ProfilePath)
    Write-Host 'You can now run test-wechat-final-recovery-gate.cmd.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Evidence report:'
    Write-Host $reportPath
    exit 0
}

Write-Host 'No exact published launch path was proven from the AppId-scoped runtime subtree.' -ForegroundColor Yellow
Write-Host 'Do not rerun P7 yet. Send the new v2 evidence report for the next targeted step.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Evidence report:'
Write-Host $reportPath
exit 2
