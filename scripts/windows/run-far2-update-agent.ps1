[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$GitDir,
    [Parameter(Mandatory = $true)][string]$PnpmDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$worker = Join-Path $root 'core\scripts\release-update-worker.js'
$dataDir = Join-Path $root 'core\data'
$logPath = Join-Path $dataDir 'update-agent.log'

if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
    throw "FAR2 update worker not found: $worker"
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Node executable not found: $NodePath"
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$env:PATH = "$PnpmDir;$GitDir;$([System.IO.Path]::GetDirectoryName($NodePath));$env:PATH"
$env:GIT_TERMINAL_PROMPT = '0'
Set-Location -LiteralPath $root

$stamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
"[$stamp] FAR2 Update Agent start user=$([Security.Principal.WindowsIdentity]::GetCurrent().Name)" | Out-File -LiteralPath $logPath -Append -Encoding utf8

try {
    & $NodePath $worker '--scheduled-task' *>> $logPath
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "FAR2 Update Agent exited with code $code"
    }
    $stamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
    "[$stamp] FAR2 Update Agent completed" | Out-File -LiteralPath $logPath -Append -Encoding utf8
    exit 0
} catch {
    $stamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
    "[$stamp] FAR2 Update Agent failed: $($_.Exception.Message)" | Out-File -LiteralPath $logPath -Append -Encoding utf8
    exit 1
}
