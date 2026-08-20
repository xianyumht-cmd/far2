param(
    [string]$AppId = 'wx5306c5978fdb76e4',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$FarmWindowTitle = 'QQ' + [char]0x7ECF + [char]0x5178 + [char]0x519C + [char]0x573A
$AllowedSwitches = @(
    'wmpf-appid',
    'type',
    'wmpf-render-type',
    'instance-index',
    'client_version',
    'product-id',
    'service-sandbox-type',
    'utility-sub-type'
)

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

function Get-SafeSwitchValue {
    param(
        [string]$CommandLine,
        [string]$Name
    )

    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }

    $escaped = [regex]::Escape($Name)
    $pattern = '(?i)(?:^|\s)--' + $escaped + '(?:=|\s+)(?:"([^"]*)"|''([^'']*)''|([^\s]+))'
    $match = [regex]::Match($CommandLine, $pattern)
    if (-not $match.Success) { return $null }

    $value = ''
    for ($i = 1; $i -le 3; $i++) {
        if ($match.Groups[$i].Success) {
            $value = $match.Groups[$i].Value
            break
        }
    }

    switch ($Name.ToLowerInvariant()) {
        'wmpf-appid' {
            if ($value -match '^wx[0-9a-fA-F]{16}$') { return $value.ToLowerInvariant() }
        }
        'instance-index' {
            if ($value -match '^\d{1,10}$') { return $value }
        }
        default {
            if ($value -match '^[A-Za-z0-9._:+-]{1,100}$') { return $value }
        }
    }

    return '[UNSAFE_VALUE_REDACTED]'
}

function Get-SafeSwitches {
    param([string]$CommandLine)

    $out = [ordered]@{}
    foreach ($name in $AllowedSwitches) {
        $value = Get-SafeSwitchValue -CommandLine $CommandLine -Name $name
        if ($null -ne $value) {
            $out[$name] = $value
        }
    }
    return $out
}

function Get-WeChatProcesses {
    $rows = @()
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '(?i)^(Weixin|WeChatAppEx|WeixinAppEx)\.exe$'
    } | ForEach-Object {
        $rows += [pscustomobject][ordered]@{
            name = [string]$_.Name
            pid = [int]$_.ProcessId
            parentPid = [int]$_.ParentProcessId
            sessionId = [int]$_.SessionId
            executablePath = Convert-ToSafePath ([string]$_.ExecutablePath)
            safeSwitches = Get-SafeSwitches ([string]$_.CommandLine)
        }
    }
    return @($rows | Sort-Object pid)
}

if (-not ('Far2WechatP2WindowProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Far2WechatP2WindowProbe {
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
}
'@
}

function Get-FarmWindows {
    param([array]$Processes)

    $pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($proc in $Processes) {
        [void]$pidSet.Add([uint32]$proc.pid)
    }

    $rows = New-Object System.Collections.ArrayList
    $callback = [Far2WechatP2WindowProbe+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)

        [uint32]$windowProcessId = 0
        [void][Far2WechatP2WindowProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
        if (-not $pidSet.Contains($windowProcessId)) { return $true }

        $titleBuffer = New-Object System.Text.StringBuilder 1024
        $classBuffer = New-Object System.Text.StringBuilder 256
        [void][Far2WechatP2WindowProbe]::GetWindowText($hWnd, $titleBuffer, $titleBuffer.Capacity)
        [void][Far2WechatP2WindowProbe]::GetClassName($hWnd, $classBuffer, $classBuffer.Capacity)

        $title = $titleBuffer.ToString()
        if ($title -eq $FarmWindowTitle) {
            [void]$rows.Add([pscustomobject][ordered]@{
                hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
                pid = [int]$windowProcessId
                visible = [bool][Far2WechatP2WindowProbe]::IsWindowVisible($hWnd)
                titleMatched = $true
                className = $classBuffer.ToString()
            })
        }

        return $true
    }

    [void][Far2WechatP2WindowProbe]::EnumWindows($callback, [IntPtr]::Zero)
    return @($rows | Sort-Object pid)
}

function Get-DescendantPids {
    param(
        [int]$RootPid,
        [array]$Processes
    )

    $result = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$result.Add($RootPid)
    $changed = $true

    while ($changed) {
        $changed = $false
        foreach ($proc in $Processes) {
            if ($result.Contains([int]$proc.parentPid) -and -not $result.Contains([int]$proc.pid)) {
                [void]$result.Add([int]$proc.pid)
                $changed = $true
            }
        }
    }

    return @($result | Sort-Object)
}

function Get-LoopbackEndpoints {
    param([int[]]$Pids)

    $pidSet = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($processId in $Pids) { [void]$pidSet.Add([int]$processId) }
    $rows = @()

    try {
        Get-NetTCPConnection -ErrorAction Stop | Where-Object {
            $pidSet.Contains([int]$_.OwningProcess) -and (
                $_.LocalAddress -in @('127.0.0.1', '::1') -or
                $_.RemoteAddress -in @('127.0.0.1', '::1')
            )
        } | ForEach-Object {
            $rows += [pscustomobject][ordered]@{
                protocol = 'tcp'
                pid = [int]$_.OwningProcess
                localAddress = [string]$_.LocalAddress
                localPort = [int]$_.LocalPort
                remoteAddress = [string]$_.RemoteAddress
                remotePort = [int]$_.RemotePort
                state = [string]$_.State
            }
        }
    }
    catch {}

    try {
        Get-NetUDPEndpoint -ErrorAction Stop | Where-Object {
            $pidSet.Contains([int]$_.OwningProcess) -and $_.LocalAddress -in @('127.0.0.1', '::1')
        } | ForEach-Object {
            $rows += [pscustomobject][ordered]@{
                protocol = 'udp'
                pid = [int]$_.OwningProcess
                localAddress = [string]$_.LocalAddress
                localPort = [int]$_.LocalPort
                remoteAddress = ''
                remotePort = 0
                state = ''
            }
        }
    }
    catch {}

    return @($rows | Sort-Object protocol, pid, localPort -Unique)
}

function Get-AppRootInfo {
    $usersRoot = Join-Path $env:APPDATA 'Tencent\xwechat\radium\users'
    if (-not (Test-Path -LiteralPath $usersRoot)) { return @() }

    $rows = @()
    Get-ChildItem -LiteralPath $usersRoot -Directory -Force | ForEach-Object {
        $appRoot = Join-Path $_.FullName ("applet\local\{0}" -f $AppId)
        if (Test-Path -LiteralPath $appRoot) {
            $rows += [pscustomobject][ordered]@{
                profileId = $_.Name
                profileRoot = $_.FullName
                appRoot = $appRoot
            }
        }
    }
    return @($rows)
}

function Get-NamedPipeHints {
    $rows = @()
    try {
        Get-ChildItem -LiteralPath '\\.\pipe\' -ErrorAction Stop | ForEach-Object {
            $name = [string]$_.Name
            if ($name -match '(?i)(wmpf|wechat|weixin|applet|miniprogram)') {
                $rows += $name
            }
        }
    }
    catch {}
    return @($rows | Sort-Object -Unique | Select-Object -First 200)
}

function Test-TextMarkersInFile {
    param(
        [string]$Path,
        [string[]]$Markers
    )

    try {
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($item.Length -gt 4194304) { return $null }
        $bytes = [IO.File]::ReadAllBytes($Path)
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        $hits = [ordered]@{}
        foreach ($marker in $Markers) {
            $count = [regex]::Matches($text, [regex]::Escape($marker), [Text.RegularExpressions.RegexOptions]::IgnoreCase).Count
            if ($count -gt 0) { $hits[$marker] = $count }
        }
        if ($hits.Count -eq 0) { return $null }
        return [pscustomobject][ordered]@{
            path = Convert-ToSafePath $Path
            length = [int64]$item.Length
            lastWriteUtc = $item.LastWriteTimeUtc.ToString('o')
            markerCounts = $hits
        }
    }
    catch {
        return $null
    }
}

function Get-CodeMarkerHits {
    param([array]$AppRoots)

    $markers = @($AppId, 'wx.login', 'JSLogin', 'LoginGetQRCar', 'LoginCheckQR')
    $rows = @()
    $seen = @{}
    $cutoff = (Get-Date).ToUniversalTime().AddMinutes(-30)

    foreach ($root in $AppRoots) {
        $candidateDirs = @([string]$root.appRoot)
        $codeCache = Join-Path ([string]$root.profileRoot) 'applet\codecache'
        if (Test-Path -LiteralPath $codeCache) { $candidateDirs += $codeCache }

        foreach ($dir in $candidateDirs) {
            $files = @()
            try {
                $files = @(Get-ChildItem -LiteralPath $dir -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
                    $_.Length -le 4194304 -and (
                        $dir -eq [string]$root.appRoot -or
                        $_.LastWriteTimeUtc -ge $cutoff
                    )
                } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 160)
            }
            catch {}

            foreach ($file in $files) {
                $key = $file.FullName.ToLowerInvariant()
                if ($seen.ContainsKey($key)) { continue }
                $seen[$key] = $true
                $hit = Test-TextMarkersInFile -Path $file.FullName -Markers $markers
                if ($null -ne $hit) { $rows += $hit }
            }
        }
    }

    return @($rows | Sort-Object lastWriteUtc -Descending | Select-Object -First 120)
}

try {
    Write-Host ''
    Write-Host 'FAR2 WeChat Farm P2 Runtime Probe' -ForegroundColor Cyan
    Write-Host '================================='
    Write-Host 'Keep desktop WeChat logged in and keep QQ Classic Farm OPEN.'
    Write-Host 'This probe stores only allowlisted process switch values, loopback endpoints,'
    Write-Host 'named-pipe names, and keyword hit counts. It stores no chat or credential content.'
    Write-Host ''

    $processes = Get-WeChatProcesses
    $farmWindows = Get-FarmWindows -Processes $processes
    $visibleFarmWindows = @($farmWindows | Where-Object { $_.visible })

    if ($visibleFarmWindows.Count -eq 0) {
        throw 'Farm window not found. Open QQ Classic Farm in desktop WeChat and run P2 again.'
    }

    $hostPid = [int]$visibleFarmWindows[0].pid
    $candidatePids = @(Get-DescendantPids -RootPid $hostPid -Processes $processes)
    $candidateProcesses = @($processes | Where-Object { $candidatePids -contains [int]$_.pid })
    $rendererCandidates = @($candidateProcesses | Where-Object {
        $_.safeSwitches.Contains('wmpf-appid') -or $_.safeSwitches.Contains('wmpf-render-type')
    })
    $exactAppIdCandidates = @($candidateProcesses | Where-Object {
        $_.safeSwitches.Contains('wmpf-appid') -and [string]$_.safeSwitches['wmpf-appid'] -eq $AppId
    })

    $loopbackEndpoints = Get-LoopbackEndpoints -Pids $candidatePids
    $namedPipeHints = Get-NamedPipeHints
    $appRoots = Get-AppRootInfo
    $codeMarkerHits = Get-CodeMarkerHits -AppRoots $appRoots

    $report = [ordered]@{
        version = 1
        phase = 'wechat-farm-p2-runtime'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        appId = $AppId
        safety = [ordered]@{
            readOnly = $true
            rawCommandLineStored = $false
            allowlistedSwitchValuesOnly = $true
            remoteInternetEndpointsStored = $false
            fileContentStored = $false
            markerCountsOnly = $true
            chatDatabaseRead = $false
            credentialCapture = $false
        }
        summary = [ordered]@{
            sessionIds = @($candidateProcesses | ForEach-Object { [int]$_.sessionId } | Sort-Object -Unique)
            farmWindowCount = @($farmWindows).Count
            visibleFarmWindowCount = @($visibleFarmWindows).Count
            farmHostPid = $hostPid
            candidateProcessCount = @($candidateProcesses).Count
            rendererCandidateCount = @($rendererCandidates).Count
            exactAppIdCandidateCount = @($exactAppIdCandidates).Count
            loopbackEndpointCount = @($loopbackEndpoints).Count
            namedPipeHintCount = @($namedPipeHints).Count
            appRootCount = @($appRoots).Count
            codeMarkerHitFileCount = @($codeMarkerHits).Count
        }
        farmWindows = $farmWindows
        farmHostProcess = @($candidateProcesses | Where-Object { [int]$_.pid -eq $hostPid })
        candidateProcesses = $candidateProcesses
        rendererCandidates = $rendererCandidates
        exactAppIdCandidates = $exactAppIdCandidates
        loopbackEndpoints = $loopbackEndpoints
        namedPipeHints = $namedPipeHints
        appRoots = @($appRoots | ForEach-Object {
            [pscustomobject][ordered]@{
                profileId = $_.profileId
                appRoot = Convert-ToSafePath $_.appRoot
            }
        })
        codeMarkerHits = $codeMarkerHits
    }

    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $dir = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $OutputPath = Join-Path $dir ("wechat-farm-p2-{0}.json" -f $stamp)
    }
    else {
        $parent = Split-Path -Parent $OutputPath
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($OutputPath, ($report | ConvertTo-Json -Depth 12), $utf8NoBom)

    Write-Host 'Capture completed.' -ForegroundColor Green
    Write-Host ("Farm host PID: {0}" -f $hostPid)
    Write-Host ("Renderer candidates: {0}" -f $report.summary.rendererCandidateCount)
    Write-Host ("Exact AppId candidates: {0}" -f $report.summary.exactAppIdCandidateCount)
    Write-Host ("Loopback endpoints: {0}" -f $report.summary.loopbackEndpointCount)
    Write-Host ("Named-pipe hints: {0}" -f $report.summary.namedPipeHintCount)
    Write-Host ("Code marker hit files: {0}" -f $report.summary.codeMarkerHitFileCount)
    Write-Host ''
    Write-Host 'Report path:' -ForegroundColor Cyan
    Write-Host $OutputPath
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'Probe failed.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
