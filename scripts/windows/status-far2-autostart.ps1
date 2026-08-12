param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$TaskPrefix = 'FAR2CodeAgent-'
)

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "NSSM service: $ServiceName  status=$($svc.Status)"
} else {
    Write-Host "NSSM service: $ServiceName  NOT INSTALLED"
}

$tasks = @(Get-ScheduledTask -TaskName "$TaskPrefix*" -ErrorAction SilentlyContinue)
if ($tasks.Count) {
    foreach ($task in $tasks) {
        $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -ErrorAction SilentlyContinue
        Write-Host "Code Agent task: $($task.TaskName)  state=$($task.State)  lastResult=$($info.LastTaskResult)"
    }
} else {
    Write-Host 'Code Agent task: NOT INSTALLED'
}

try {
    $web = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3007/' -TimeoutSec 3
    Write-Host "WebUI: READY http=$($web.StatusCode)"
} catch {
    Write-Host "WebUI: NOT READY ($($_.Exception.Message))"
}

try {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 43101 -ErrorAction Stop | Select-Object -First 1
    Write-Host "Code Agent port 43101: LISTEN pid=$($listener.OwningProcess)"
} catch {
    Write-Host 'Code Agent port 43101: NOT LISTENING'
}
