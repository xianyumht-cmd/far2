param(
    [string]$ServiceName = 'FAR2Farm',
    [int]$AgentPort = 43101
)

$ErrorActionPreference = 'SilentlyContinue'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dataDir = Join-Path $projectRoot 'core\data'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $dataDir ("code-refresh-diagnostic-$stamp.txt")
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Add-Line {
    param([string]$Text = '')
    $Text | Out-File -LiteralPath $outFile -Append -Encoding utf8
}

function Mask-UinText {
    param([string]$Text)
    if (-not $Text) { return $Text }
    return [regex]::Replace($Text, '(?<!\d)(\d{2})\d{3,8}(\d{2})(?!\d)', '$1****$2')
}

Add-Line '=== FAR2 Code Refresh Diagnostic ==='
Add-Line ("Created: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
Add-Line ("Computer: {0}" -f $env:COMPUTERNAME)
Add-Line ("User: {0}" -f [Security.Principal.WindowsIdentity]::GetCurrent().Name)
Add-Line ''

Add-Line '=== System load now ==='
try {
    $cpu = @(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    Add-Line ("CPU load: {0}%" -f [math]::Round([double]$cpu, 1))
} catch { Add-Line 'CPU load: unavailable' }
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $totalMb = [math]::Round([double]$os.TotalVisibleMemorySize / 1024, 0)
    $freeMb = [math]::Round([double]$os.FreePhysicalMemory / 1024, 0)
    Add-Line ("Memory: free={0}MB total={1}MB" -f $freeMb, $totalMb)
} catch { Add-Line 'Memory: unavailable' }
Add-Line ''

Add-Line '=== Service / task ==='
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) { Add-Line ("Service {0}: {1}" -f $ServiceName, $svc.Status) }
else { Add-Line ("Service {0}: missing" -f $ServiceName) }
$tasks = @(Get-ScheduledTask -TaskName 'FAR2CodeAgent-*' -ErrorAction SilentlyContinue)
foreach ($task in $tasks) {
    $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -ErrorAction SilentlyContinue
    Add-Line (Mask-UinText ("Task {0}: state={1} lastResult={2}" -f $task.TaskName, $task.State, $info.LastTaskResult))
}
try {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $AgentPort -ErrorAction Stop | Select-Object -First 1
    Add-Line ("Agent port {0}: LISTEN pid={1}" -f $AgentPort, $listener.OwningProcess)
} catch { Add-Line ("Agent port {0}: NOT LISTENING" -f $AgentPort) }
Add-Line ''

Add-Line '=== QQ processes in current machine ==='
try {
    $qqRows = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Select-Object ProcessId,ParentProcessId,SessionId,CommandLine)
    Add-Line ("QQ process count: {0}" -f $qqRows.Count)
    foreach ($row in $qqRows) {
        $cmd = [string]$row.CommandLine
        $kind = if ($cmd -match '--loadapp=mini-app' -and $cmd -match '--exApp=QQEXMiniProgram') { 'miniapp-root' }
            elseif ($cmd -match '--type=') { 'child' }
            else { 'main-or-other' }
        $farm = if ($cmd -match 'appIdOrLink=1112386029') { ' farm-appid' } else { '' }
        Add-Line (Mask-UinText ("pid={0} ppid={1} session={2} kind={3}{4}" -f $row.ProcessId, $row.ParentProcessId, $row.SessionId, $kind, $farm))
    }
} catch { Add-Line 'QQ process scan failed' }
Add-Line ''

$agentLog = Join-Path $dataDir ("code-agent-{0}.log" -f $AgentPort)
Add-Line '=== Agent log tail ==='
if (Test-Path -LiteralPath $agentLog) {
    Get-Content -LiteralPath $agentLog -Tail 220 -Encoding UTF8 | ForEach-Object { Add-Line (Mask-UinText $_) }
} else { Add-Line 'Agent log missing' }
Add-Line ''

$stdout = Join-Path $dataDir 'service.stdout.log'
Add-Line '=== FAR2 relevant log tail ==='
if (Test-Path -LiteralPath $stdout) {
    Get-Content -LiteralPath $stdout -Tail 500 -Encoding UTF8 | Where-Object {
        $_ -match 'CodeManager|WS.*400|kickout|踢|登录成功|账号.*进程退出|isolated QQ runtime Code Provider|Provider'
    } | Select-Object -Last 220 | ForEach-Object { Add-Line (Mask-UinText $_) }
} else { Add-Line 'service.stdout.log missing' }
Add-Line ''

$stderr = Join-Path $dataDir 'service.stderr.log'
Add-Line '=== FAR2 stderr tail ==='
if (Test-Path -LiteralPath $stderr) {
    Get-Content -LiteralPath $stderr -Tail 100 -Encoding UTF8 | ForEach-Object { Add-Line (Mask-UinText $_) }
} else { Add-Line 'service.stderr.log missing' }

Write-Host 'Diagnostic created:'
Write-Host $outFile
Write-Host 'Upload this txt after the next repeated Farm popup / refresh failure.'
