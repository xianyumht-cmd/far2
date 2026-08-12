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

if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node 不存在: $NodePath" }
if (-not (Test-Path -LiteralPath $agentScript)) { throw "Code Agent 脚本不存在: $agentScript" }
if (-not (Test-Path -LiteralPath $cloakScript)) { throw "农场窗口隐藏器不存在: $cloakScript" }
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

# Agent 必须留在交互式 Windows Session；不能改成 LocalSystem/NSSM Session 0，
# 否则无法安全绑定当前登录用户的 QQ/QQEX 运行时。
# 窗口隐藏器也运行在同一 Session，只把临时 QQ 农场窗口移出可见桌面，
# 不改变 QQ/QQEX 进程归属，也不绕过 UIN/SessionId 校验。
$cloak = $null
try {
    $quotedCloak = '"' + $cloakScript + '"'
    $cloakArgs = @(
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', $quotedCloak
    ) -join ' '
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
