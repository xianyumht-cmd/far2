param(
    [Parameter(Mandatory = $true)][string]$Uin,
    [int]$Port = 43101,
    [string]$TokenEnv = 'FAR2_CODE_PROVIDER_TOKEN_A',
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'

$project = [System.IO.Path]::GetFullPath($ProjectRoot)
$coreDir = Join-Path $project 'core'
$agentScript = Join-Path $coreDir 'scripts\qq-isolated-code-agent.js'
$cloakScript = Join-Path $project 'scripts\windows\farm-window-cloak.ps1'
$dataDir = Join-Path $coreDir 'data'
$logFile = Join-Path $dataDir ("code-agent-{0}.log" -f $Port)

if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node not found: $NodePath" }
if (-not (Test-Path -LiteralPath $agentScript)) { throw "Code Agent script not found: $agentScript" }
if (-not (Test-Path -LiteralPath $cloakScript)) { throw "Farm window cloak not found: $cloakScript" }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$token = [Environment]::GetEnvironmentVariable($TokenEnv, 'User')
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
    throw "User environment variable $TokenEnv is missing or too short."
}

$env:FAR2_CODE_AGENT_UIN = $Uin
$env:FAR2_CODE_AGENT_TOKEN = $token
$env:FAR2_CODE_AGENT_HOST = '127.0.0.1'
$env:FAR2_CODE_AGENT_PORT = [string]$Port
$env:FAR2_CODE_AGENT_HIDE_FARM_WINDOW = '1'

Set-Location -LiteralPath $coreDir

$cloak = $null
try {
    $cloakArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$cloakScript`""
    $cloak = Start-Process -FilePath 'powershell.exe' -ArgumentList $cloakArgs -WindowStyle Hidden -PassThru

    & $NodePath $agentScript >> $logFile 2>&1
    $exitCode = $LASTEXITCODE
}
finally {
    if ($cloak -and -not $cloak.HasExited) {
        try { Stop-Process -Id $cloak.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
}

exit $exitCode
