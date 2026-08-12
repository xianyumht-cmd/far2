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

if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node 不存在: $NodePath" }
if (-not (Test-Path -LiteralPath $agentScript)) { throw "Code Agent 脚本不存在: $agentScript" }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$token = [Environment]::GetEnvironmentVariable($TokenEnv, 'User')
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
    throw "用户环境变量 $TokenEnv 缺失或长度不足"
}

$env:FAR2_CODE_AGENT_UIN = $Uin
$env:FAR2_CODE_AGENT_TOKEN = $token
$env:FAR2_CODE_AGENT_HOST = '127.0.0.1'
$env:FAR2_CODE_AGENT_PORT = [string]$Port
$env:FAR2_CODE_AGENT_HIDE_FARM_WINDOW = '1'

Set-Location -LiteralPath $coreDir

# 此脚本由“仅在用户登录时运行”的计划任务启动，并使用 -WindowStyle Hidden。
# Agent 必须留在交互式 Windows Session；不能改成 LocalSystem/NSSM Session 0，
# 否则无法安全绑定当前登录用户的 QQ/QQEX 运行时。
& $NodePath $agentScript >> $logFile 2>&1
exit $LASTEXITCODE
