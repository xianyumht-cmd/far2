param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$stateRoot = Join-Path $env:LOCALAPPDATA 'FAR2\wechat-agent'
$logRoot = Join-Path $stateRoot 'logs'
$launcher = Join-Path $PSScriptRoot 'start-wechat-resident-agent.ps1'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$logPath = Join-Path $logRoot ("resident-agent-autostart-{0}.log" -f $stamp)

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Get-ChildItem -LiteralPath $logRoot -Filter 'resident-agent-autostart-*.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 10 |
    Remove-Item -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    "[$([DateTime]::Now.ToString('o'))] launcher missing: $launcher" | Set-Content -LiteralPath $logPath -Encoding UTF8
    exit 2
}

"[$([DateTime]::Now.ToString('o'))] FAR2 WeChat Resident Agent autostart begin" | Set-Content -LiteralPath $logPath -Encoding UTF8
try {
    & $launcher *>> $logPath
    exit $LASTEXITCODE
}
catch {
    $_ | Out-String | Add-Content -LiteralPath $logPath -Encoding UTF8
    exit 1
}
