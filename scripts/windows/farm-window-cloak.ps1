param(
    [string]$ControlFile = '',
    [int]$IntervalMs = 60,
    [int]$OffscreenX = -32000,
    [int]$OffscreenY = -32000
)

$ErrorActionPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$controlCandidates = @()
foreach ($candidate in @(
    $ControlFile,
    $env:FAR2_FARM_WINDOW_CONTROL_FILE,
    (Join-Path $projectRoot 'core\data\farm-window-control.json'),
    (Join-Path $projectRoot 'core\dist\data\farm-window-control.json')
)) {
    $text = [string]$candidate
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    $full = [System.IO.Path]::GetFullPath($text)
    if ($controlCandidates -notcontains $full) { $controlCandidates += $full }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\FAR2FarmWindowCloak')
if (-not $mutex.WaitOne(0, $false)) { exit 0 }

try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct Far2Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public static class Far2WindowApi {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out Far2Rect lpRect);
}
'@

    $selfSession = (Get-Process -Id $PID).SessionId
    $knownPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $farmPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $originalRects = @{}
    $appId = '1112386029'
    # ASCII-safe construction of the Chinese word for "farm" to avoid WinPS 5.1 encoding issues.
    $farmTitleToken = ([string][char]0x519C) + ([string][char]0x573A)
    $script:hideFarmWindows = $true
    $script:lastControlCheck = [DateTime]::MinValue
    $script:lastStatusWrite = [DateTime]::MinValue
    $script:utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    $statusFiles = @()
    foreach ($candidate in $controlCandidates) {
        $statusFile = Join-Path (Split-Path -Parent $candidate) ("farm-window-cloak-status-{0}.json" -f $selfSession)
        if ($statusFiles -notcontains $statusFile) { $statusFiles += $statusFile }
    }

    function Update-ControlState {
        $now = Get-Date
        if (($now - $script:lastControlCheck).TotalMilliseconds -lt 250) { return }
        $script:lastControlCheck = $now

        try {
            $existing = @(
                $controlCandidates |
                    Where-Object { Test-Path -LiteralPath $_ } |
                    ForEach-Object { Get-Item -LiteralPath $_ } |
                    Sort-Object LastWriteTimeUtc -Descending
            )

            if (-not $existing.Count) {
                # Historical/default behavior: hide farm windows when no control file exists.
                $script:hideFarmWindows = $true
                return
            }

            $selected = [string]$existing[0].FullName
            $state = Get-Content -LiteralPath $selected -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $state -and $state.hidden -is [bool]) {
                $script:hideFarmWindows = [bool]$state.hidden
            }
        }
        catch {
            # Keep the previous state on a transient/partial read.
        }
    }

    function Write-ControllerStatus {
        $now = Get-Date
        if (($now - $script:lastStatusWrite).TotalMilliseconds -lt 1000) { return }
        $script:lastStatusWrite = $now

        try {
            $updatedAt = [long](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds)
            $payload = [ordered]@{
                version = 2
                processId = [int]$PID
                sessionId = [int]$selfSession
                hidden = [bool]$script:hideFarmWindows
                updatedAt = $updatedAt
            }
            $json = $payload | ConvertTo-Json -Compress

            foreach ($file in $statusFiles) {
                try {
                    $dir = Split-Path -Parent $file
                    if (-not (Test-Path -LiteralPath $dir)) {
                        New-Item -ItemType Directory -Force -Path $dir | Out-Null
                    }
                    [System.IO.File]::WriteAllText($file, $json, $script:utf8NoBom)
                }
                catch {}
            }
        }
        catch {}
    }

    function Get-WindowRectSnapshot {
        param([IntPtr]$Handle)
        if ($Handle -eq [IntPtr]::Zero) { return $null }

        $rect = New-Object Far2Rect
        if (-not [Far2WindowApi]::GetWindowRect($Handle, [ref]$rect)) { return $null }

        return [pscustomobject]@{
            Left = [int]$rect.Left
            Top = [int]$rect.Top
            Right = [int]$rect.Right
            Bottom = [int]$rect.Bottom
        }
    }

    function Hide-FarmWindow {
        param($Proc)
        if (-not $Proc) { return }
        $handle = [IntPtr]$Proc.MainWindowHandle
        if ($handle -eq [IntPtr]::Zero) { return }

        $key = $handle.ToInt64().ToString()
        if (-not $originalRects.ContainsKey($key)) {
            $rect = Get-WindowRectSnapshot -Handle $handle
            if ($rect -and $rect.Left -gt -10000 -and $rect.Top -gt -10000) {
                $originalRects[$key] = $rect
            }
        }

        [Far2WindowApi]::SetWindowPos(
            $handle,
            [IntPtr]::Zero,
            $OffscreenX,
            $OffscreenY,
            0,
            0,
            [uint32](0x0001 -bor 0x0004 -bor 0x0010)
        ) | Out-Null
    }

    function Ensure-FarmWindowVisible {
        param($Proc)
        if (-not $Proc) { return }
        $handle = [IntPtr]$Proc.MainWindowHandle
        if ($handle -eq [IntPtr]::Zero) { return }

        $key = $handle.ToInt64().ToString()
        $rect = Get-WindowRectSnapshot -Handle $handle
        $offscreen = $rect -and ($rect.Left -le -10000 -or $rect.Top -le -10000)

        if ($offscreen) {
            $targetX = 80
            $targetY = 80
            if ($originalRects.ContainsKey($key)) {
                $saved = $originalRects[$key]
                if ($saved.Left -gt -10000 -and $saved.Top -gt -10000) {
                    $targetX = [int]$saved.Left
                    $targetY = [int]$saved.Top
                }
            }

            [Far2WindowApi]::SetWindowPos(
                $handle,
                [IntPtr]::Zero,
                $targetX,
                $targetY,
                0,
                0,
                [uint32](0x0001 -bor 0x0004 -bor 0x0010 -bor 0x0040)
            ) | Out-Null
        }

        # Once visible, forget the old position. The next hide operation captures
        # the user's latest on-screen position so repeated hide/show cycles restore naturally.
        if ($originalRects.ContainsKey($key)) { $originalRects.Remove($key) }
    }

    function Apply-FarmWindowState {
        param($Proc)
        if ($script:hideFarmWindows) {
            Hide-FarmWindow -Proc $Proc
        }
        else {
            Ensure-FarmWindowVisible -Proc $Proc
        }
    }

    function Refresh-FarmPidSet {
        $farmPids.Clear()
        $rows = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { [int]$_.SessionId -eq [int]$selfSession })
        if (-not $rows.Count) { return }

        $children = @{}
        foreach ($row in $rows) {
            $ppid = [int]$row.ParentProcessId
            if (-not $children.ContainsKey($ppid)) {
                $children[$ppid] = New-Object System.Collections.ArrayList
            }
            [void]$children[$ppid].Add($row)
        }

        foreach ($root in $rows) {
            $cmd = [string]$root.CommandLine
            if ($cmd -notmatch '--loadapp=mini-app' -or $cmd -notmatch '--exApp=QQEXMiniProgram') { continue }

            $tree = New-Object System.Collections.ArrayList
            $queue = New-Object System.Collections.Queue
            $queue.Enqueue($root)
            $isFarm = $false

            while ($queue.Count -gt 0) {
                $item = $queue.Dequeue()
                [void]$tree.Add($item)
                if ([string]$item.CommandLine -match "appIdOrLink=$appId") { $isFarm = $true }
                $pidKey = [int]$item.ProcessId
                if ($children.ContainsKey($pidKey)) {
                    foreach ($child in $children[$pidKey]) { $queue.Enqueue($child) }
                }
            }

            if ($isFarm) {
                foreach ($item in $tree) { [void]$farmPids.Add([int]$item.ProcessId) }
            }
        }
    }

    while ($true) {
        Update-ControlState

        $qq = @(Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $selfSession })
        $needRefresh = $false
        $current = New-Object 'System.Collections.Generic.HashSet[int]'

        foreach ($proc in $qq) {
            [void]$current.Add([int]$proc.Id)
            if (-not $knownPids.Contains([int]$proc.Id)) { $needRefresh = $true }

            # Fast path: identify a Farm window by title before the slower CIM
            # process-tree refresh completes. In hidden mode this reduces flashes;
            # in visible mode it also restores a window left offscreen by an older build.
            $title = [string]$proc.MainWindowTitle
            if ($title -and $title.Contains($farmTitleToken)) {
                [void]$farmPids.Add([int]$proc.Id)
                Apply-FarmWindowState -Proc $proc
            }
        }
        if ($current.Count -ne $knownPids.Count) { $needRefresh = $true }

        if ($needRefresh) {
            Refresh-FarmPidSet
            $knownPids.Clear()
            foreach ($id in $current) { [void]$knownPids.Add($id) }
        }

        foreach ($proc in $qq) {
            if (-not $farmPids.Contains([int]$proc.Id)) { continue }
            Apply-FarmWindowState -Proc $proc
        }

        Write-ControllerStatus
        Start-Sleep -Milliseconds ([Math]::Max(30, $IntervalMs))
    }
}
finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
