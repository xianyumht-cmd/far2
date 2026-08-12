$ErrorActionPreference = 'SilentlyContinue'

# 只允许当前 Windows 登录 Session 一个窗口隐藏器实例。
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

    function Refresh-FarmPidSet {
        $farmPids.Clear()
        $rows = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { [int]$_.SessionId -eq [int]$selfSession })
        if (-not $rows.Count) { return }

        $children = @{}
        foreach ($row in $rows) {
            $ppid = [int]$row.ParentProcessId
            if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.ArrayList }
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
        }
        if ($current.Count -ne $knownPids.Count) { $needRefresh = $true }

        if ($needRefresh) {
            Refresh-FarmPidSet
            $knownPids.Clear()
            foreach ($id in $current) { [void]$knownPids.Add($id) }
        }

        foreach ($proc in $qq) {
            $handle = $proc.MainWindowHandle
            if ($handle -eq 0) { continue }
            $looksLikeFarm = $farmPids.Contains([int]$proc.Id) -or ([string]$proc.MainWindowTitle -match '经典农场|QQ农场|农场')
            if (-not $looksLikeFarm) { continue }

            # 不真正“无头”运行 QQ，而是把临时小程序窗口移出可见桌面并禁止抢焦点。
            # QQ/QQEX 仍处于当前交互式 Session，因此 qq.login() 和 UIN 校验保持原样。
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

        Start-Sleep -Milliseconds 120
    }
}
finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
