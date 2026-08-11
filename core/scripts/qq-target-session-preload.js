const childProcess = require('node:child_process');

const originalExecSync = childProcess.execSync.bind(childProcess);
const execFileSync = childProcess.execFileSync.bind(childProcess);

function reloadTargetFarmWindow() {
  const targetPid = Number(process.env.FAR2_TARGET_FARM_PID || 0);
  if (!Number.isInteger(targetPid) || targetPid <= 0) {
    throw new Error('FAR2_TARGET_FARM_PID missing');
  }

  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Far2TargetWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$targetPid = ${targetPid}
$script:targetHwnd = [IntPtr]::Zero
[Far2TargetWindow]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $pidValue = [uint32]0
  [void][Far2TargetWindow]::GetWindowThreadProcessId($hWnd, [ref]$pidValue)
  if ($pidValue -eq $targetPid -and [Far2TargetWindow]::IsWindowVisible($hWnd)) {
    $script:targetHwnd = $hWnd
    return $false
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:targetHwnd -eq [IntPtr]::Zero) {
  throw "未找到 farmRootPid=$targetPid 的可见窗口"
}
[void][Far2TargetWindow]::SetForegroundWindow($script:targetHwnd)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('^r')
Write-Output "reloaded:$targetPid"
`;

  const out = execFileSync('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-Command', ps,
  ], {
    windowsHide: false,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  return out;
}

childProcess.execSync = function patchedExecSync(command, options) {
  const text = String(command || '');
  if (process.env.FAR2_TARGET_FARM_PID && /tencent:\/\/ntqq-open|openQQMiniApp|FileProtocolHandler/i.test(text)) {
    return reloadTargetFarmWindow();
  }
  return originalExecSync(command, options);
};
