$ErrorActionPreference = 'SilentlyContinue'

$mutex = New-Object System.Threading.Mutex($false, 'Local\FAR2FarmWindowCloak')
if (-not $mutex.WaitOne(0, $false)) { exit 0 }

try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Far2WindowApi {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);
}
'@

    $selfSession = (Get-Process -Id $PID).SessionId
    $knownPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $farmPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $appId = '1112386029'
    # ASCII-safe construction of the Chinese word for "farm" to avoid WinPS 5.1 encoding issues.
    $farmTitleToken = ([string][char]0x519C) + ([string][char]0x573A)

    function Move-Offscreen {
        param($Proc)
        if (-not $Proc) { return }
        $handle = $Proc.MainWindowHandle
        if ($handle -eq 0) { return }
        [Far2WindowApi]::SetWindowPos(
            $handle,
            [IntPtr]::Zero,
            -32000,
            -32000,
            0,
            0,
            [uint32](0x0001 -bor 0x0004 -bor 0x0010)
        ) | Out-Null
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
        $qq = @(Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $selfSession })
        $needRefresh = $false
        $current = New-Object 'System.Collections.Generic.HashSet[int]'

        foreach ($proc in $qq) {
            [void]$current.Add([int]$proc.Id)
            if (-not $knownPids.Contains([int]$proc.Id)) { $needRefresh = $true }

            # Fast path: once a QQ window title contains the Farm token, move it before
            # the slower CIM process-tree refresh completes. This reduces visible flashes.
            $title = [string]$proc.MainWindowTitle
            if ($title -and $title.Contains($farmTitleToken)) {
                Move-Offscreen -Proc $proc
                [void]$farmPids.Add([int]$proc.Id)
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
            Move-Offscreen -Proc $proc
        }

        Start-Sleep -Milliseconds 60
    }
}
finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
