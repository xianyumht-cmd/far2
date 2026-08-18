param(
    [string]$AppId = 'wx5306c5978fdb76e4',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$FarmWindowTitle = 'QQ' + [char]0x7ECF + [char]0x5178 + [char]0x519C + [char]0x573A

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

function Get-SwitchValue {
    param([string]$CommandLine, [string]$Name)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
    $escaped = [regex]::Escape($Name)
    $pattern = '(?i)(?:^|\s)--' + $escaped + '(?:=|\s+)(?:"([^"]*)"|''([^'']*)''|([^\s]+))'
    $m = [regex]::Match($CommandLine, $pattern)
    if (-not $m.Success) { return $null }
    for ($i = 1; $i -le 3; $i++) {
        if ($m.Groups[$i].Success) { return [string]$m.Groups[$i].Value }
    }
    return $null
}

function Get-ProcessRows {
    $rows = @()
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '(?i)^(Weixin|WeChatAppEx|WeixinAppEx)\.exe$'
    } | ForEach-Object {
        $cmd = [string]$_.CommandLine
        $rawAppId = Get-SwitchValue -CommandLine $cmd -Name 'wmpf-appid'
        $appIdStatus = 'absent'
        $targetAppId = $null
        if ($null -ne $rawAppId) {
            if ([string]::Equals($rawAppId, $AppId, [StringComparison]::OrdinalIgnoreCase)) {
                $appIdStatus = 'target'
                $targetAppId = $AppId
            }
            else {
                $appIdStatus = 'other'
            }
        }

        $rows += [pscustomobject][ordered]@{
            name = [string]$_.Name
            pid = [int]$_.ProcessId
            parentPid = [int]$_.ParentProcessId
            sessionId = [int]$_.SessionId
            executablePath = Convert-ToSafePath ([string]$_.ExecutablePath)
            type = Get-SwitchValue -CommandLine $cmd -Name 'type'
            wmpfRenderType = Get-SwitchValue -CommandLine $cmd -Name 'wmpf-render-type'
            instanceIndex = Get-SwitchValue -CommandLine $cmd -Name 'instance-index'
            wmpfAppIdStatus = $appIdStatus
            targetAppId = $targetAppId
        }
    }
    return @($rows | Sort-Object pid)
}

if (-not ('Far2WechatP2bWindowProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Far2WechatP2bWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
'@
}

function Get-FarmHostPid {
    param([array]$Processes)
    $pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($proc in $Processes) { [void]$pidSet.Add([uint32]$proc.pid) }
    $found = New-Object System.Collections.ArrayList
    $callback = [Far2WechatP2bWindowProbe+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        [uint32]$windowProcessId = 0
        [void][Far2WechatP2bWindowProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
        if (-not $pidSet.Contains($windowProcessId)) { return $true }
        if (-not [Far2WechatP2bWindowProbe]::IsWindowVisible($hWnd)) { return $true }
        $buf = New-Object System.Text.StringBuilder 1024
        [void][Far2WechatP2bWindowProbe]::GetWindowText($hWnd, $buf, $buf.Capacity)
        if ($buf.ToString() -eq $FarmWindowTitle) { [void]$found.Add([int]$windowProcessId) }
        return $true
    }
    [void][Far2WechatP2bWindowProbe]::EnumWindows($callback, [IntPtr]::Zero)
    return @($found | Sort-Object -Unique)
}

function Get-DescendantPids {
    param([int]$RootPid, [array]$Processes)
    $set = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$set.Add($RootPid)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($proc in $Processes) {
            if ($set.Contains([int]$proc.parentPid) -and -not $set.Contains([int]$proc.pid)) {
                [void]$set.Add([int]$proc.pid)
                $changed = $true
            }
        }
    }
    return @($set | Sort-Object)
}

function Get-LoopbackPeerListeners {
    param([int[]]$CandidatePids)
    $pidSet = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($p in $CandidatePids) { [void]$pidSet.Add([int]$p) }

    $connections = @()
    try {
        $connections = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
            $pidSet.Contains([int]$_.OwningProcess) -and $_.RemoteAddress -in @('127.0.0.1', '::1') -and [int]$_.RemotePort -gt 0
        })
    }
    catch {}

    $remotePorts = @($connections | ForEach-Object { [int]$_.RemotePort } | Sort-Object -Unique)
    $listeners = @()
    foreach ($port in $remotePorts) {
        try {
            Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | ForEach-Object {
                $ownerPid = [int]$_.OwningProcess
                $proc = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $ownerPid) -ErrorAction SilentlyContinue
                $listeners += [pscustomobject][ordered]@{
                    port = $port
                    listenerPid = $ownerPid
                    processName = if ($proc) { [string]$proc.Name } else { '' }
                    executablePath = if ($proc) { Convert-ToSafePath ([string]$proc.ExecutablePath) } else { '' }
                }
            }
        }
        catch {}
    }
    return @($listeners | Sort-Object port, listenerPid -Unique)
}

try {
    Write-Host ''
    Write-Host 'FAR2 WeChat Farm P2B Target AppId Probe' -ForegroundColor Cyan
    Write-Host '======================================='
    Write-Host 'Keep desktop WeChat logged in and keep QQ Classic Farm OPEN.'
    Write-Host 'This probe reveals only whether wmpf-appid matches the target AppId.'
    Write-Host 'Other mini-program AppId values are not stored.'
    Write-Host ''

    $processes = Get-ProcessRows
    $hostPids = @(Get-FarmHostPid -Processes $processes)
    if ($hostPids.Count -ne 1) { throw ("Expected exactly one visible farm window, found {0}." -f $hostPids.Count) }

    $hostPid = [int]$hostPids[0]
    $candidatePids = @(Get-DescendantPids -RootPid $hostPid -Processes $processes)
    $candidateProcesses = @($processes | Where-Object { $candidatePids -contains [int]$_.pid })
    $appIdProcesses = @($candidateProcesses | Where-Object { $_.wmpfAppIdStatus -ne 'absent' })
    $targetProcesses = @($candidateProcesses | Where-Object { $_.wmpfAppIdStatus -eq 'target' })
    $peerListeners = @(Get-LoopbackPeerListeners -CandidatePids $candidatePids)

    $report = [ordered]@{
        version = 1
        phase = 'wechat-farm-p2b-target-appid'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        targetAppId = $AppId
        safety = [ordered]@{
            readOnly = $true
            rawCommandLineStored = $false
            otherAppIdValuesStored = $false
            credentialCapture = $false
            remoteInternetEndpointsStored = $false
        }
        summary = [ordered]@{
            farmHostPid = $hostPid
            candidateProcessCount = @($candidateProcesses).Count
            appIdBearingProcessCount = @($appIdProcesses).Count
            targetAppIdProcessCount = @($targetProcesses).Count
            loopbackPeerListenerCount = @($peerListeners).Count
        }
        appIdBearingProcesses = $appIdProcesses
        targetAppIdProcesses = $targetProcesses
        loopbackPeerListeners = $peerListeners
    }

    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $dir = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $OutputPath = Join-Path $dir ("wechat-farm-p2b-{0}.json" -f $stamp)
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($OutputPath, ($report | ConvertTo-Json -Depth 10), $utf8NoBom)

    Write-Host 'Capture completed.' -ForegroundColor Green
    Write-Host ("Farm host PID: {0}" -f $hostPid)
    Write-Host ("Processes with wmpf-appid: {0}" -f @($appIdProcesses).Count)
    Write-Host ("Processes matching target AppId: {0}" -f @($targetProcesses).Count)
    Write-Host ("Loopback peer listeners identified: {0}" -f @($peerListeners).Count)
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
