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
$dataDir = Join-Path $coreDir 'data'
$logFile = Join-Path $dataDir ("code-agent-{0}.log" -f $Port)

if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node not found: $NodePath" }
if (-not (Test-Path -LiteralPath $agentScript)) { throw "Code Agent script not found: $agentScript" }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$token = [Environment]::GetEnvironmentVariable($TokenEnv, 'User')
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
    throw "User environment variable $TokenEnv is missing or too short."
}

$env:FAR2_CODE_AGENT_UIN = $Uin
$env:FAR2_CODE_AGENT_TOKEN = $token
$env:FAR2_CODE_AGENT_HOST = '127.0.0.1'
$env:FAR2_CODE_AGENT_PORT = [string]$Port

# The Code Agent task itself stays hidden so no console window is left open.
# Farm/QQ windows are intentionally NOT hidden or moved anymore.
Remove-Item Env:FAR2_CODE_AGENT_HIDE_FARM_WINDOW -ErrorAction SilentlyContinue
Remove-Item Env:FAR2_FARM_WINDOW_CONTROL_FILE -ErrorAction SilentlyContinue

Set-Location -LiteralPath $coreDir
& $NodePath $agentScript >> $logFile 2>&1
exit $LASTEXITCODE
