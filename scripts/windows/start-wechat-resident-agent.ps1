param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreRoot = Join-Path $projectRoot 'core'
$agentScript = Join-Path $coreRoot 'scripts\wechat-resident-agent.js'
$stateRoot = Join-Path $env:LOCALAPPDATA 'FAR2\wechat-agent'
$depsRoot = Join-Path $stateRoot 'node-deps'
$providerUrl = 'http://127.0.0.1:43201/'

function Get-NodePath {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        try {
            $version = (& $node.Source -p "process.versions.node").Trim()
            if ([int]$version.Split('.')[0] -ge 22) { return [string]$node.Source }
        }
        catch {}
    }

    $knownRoots = @(
        (Join-Path $env:TEMP 'FAR2-WeChat-CDP\node22'),
        'D:\project2\napcatplugin'
    )
    foreach ($root in $knownRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $cached = Get-ChildItem -LiteralPath $root -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cached) { continue }
        try {
            $version = (& $cached.FullName -p "process.versions.node").Trim()
            if ([int]$version.Split('.')[0] -ge 22) { return [string]$cached.FullName }
        }
        catch {}
    }
    throw 'Node.js 22+ was not found. Run the earlier WeChat native gate once.'
}

function Add-NodePath {
    param([string]$NodeModulesPath)
    if (-not (Test-Path -LiteralPath $NodeModulesPath)) { return }
    if ([string]::IsNullOrWhiteSpace($env:NODE_PATH)) {
        $env:NODE_PATH = $NodeModulesPath
        return
    }
    $parts = @($env:NODE_PATH -split [regex]::Escape([string][IO.Path]::PathSeparator))
    if ($parts -notcontains $NodeModulesPath) {
        $env:NODE_PATH = $NodeModulesPath + [IO.Path]::PathSeparator + $env:NODE_PATH
    }
}

function Test-Dependencies {
    param([string]$NodePath)
    Push-Location -LiteralPath $coreRoot
    try {
        & $NodePath -e "require('frida');require('ws');require('long');require('protobufjs');require('node-fetch');" *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch { return $false }
    finally { Pop-Location }
}

function Install-Dependencies {
    param([string]$NodePath)
    New-Item -ItemType Directory -Force -Path $depsRoot | Out-Null
    $nodeDir = Split-Path -Parent $NodePath
    $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    $args = @(
        'install', '--prefix', $depsRoot, '--no-audit', '--no-fund', '--no-save',
        'frida@17.3.2', 'ws@8.19.0', 'long@5.3.2', 'protobufjs@8.0.0', 'node-fetch@2.7.0'
    )
    if (Test-Path -LiteralPath $npmCli) {
        & $NodePath $npmCli @args
        if ($LASTEXITCODE -ne 0) { throw "Resident agent dependency install failed with exit code $LASTEXITCODE." }
        return
    }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm.exe -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm was not found.' }
    & $npm.Source @args
    if ($LASTEXITCODE -ne 0) { throw "Resident agent dependency install failed with exit code $LASTEXITCODE." }
}

function Get-OrCreateAgentToken {
    $token = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
    if (-not [string]::IsNullOrWhiteSpace($token) -and $token.Length -ge 24) { return $token }

    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })

    try {
        [Environment]::SetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', $token, 'Machine')
        [Environment]::SetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_URL', $providerUrl, 'Machine')
        [Environment]::SetEnvironmentVariable('FAR2_WECHAT_AGENT_TOKEN', $token, 'Machine')
        [Environment]::SetEnvironmentVariable('FAR2_WECHAT_AGENT_PORT', '43201', 'Machine')
        Write-Host 'Created persistent FAR2 WeChat Agent/Provider authentication configuration.' -ForegroundColor Green
    }
    catch {
        Write-Warning 'Could not persist machine-level provider configuration. The agent can still run in this console, but FAR2Farm will not inherit it until configured as Administrator.'
    }
    return $token
}

if (-not (Test-Path -LiteralPath $agentScript)) { throw "Resident agent file not found: $agentScript" }
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null

$nodePath = Get-NodePath
$nodeModules = Join-Path $depsRoot 'node_modules'
Add-NodePath -NodeModulesPath $nodeModules
if (-not (Test-Dependencies -NodePath $nodePath)) {
    Write-Host 'Preparing persistent FAR2 WeChat resident-agent dependencies...' -ForegroundColor Yellow
    Install-Dependencies -NodePath $nodePath
    Add-NodePath -NodeModulesPath $nodeModules
    if (-not (Test-Dependencies -NodePath $nodePath)) {
        throw 'Resident agent dependencies are unavailable after install.'
    }
}

& $nodePath --check $agentScript
if ($LASTEXITCODE -ne 0) { throw 'Resident agent JavaScript syntax check failed.' }

$token = Get-OrCreateAgentToken
$env:FAR2_WECHAT_AGENT_TOKEN = $token
$env:FARM_WECHAT_CODE_PROVIDER_TOKEN = $token
$env:FARM_WECHAT_CODE_PROVIDER_URL = $providerUrl
$env:FAR2_WECHAT_AGENT_PORT = '43201'

Write-Host ''
Write-Host 'FAR2 Windows WeChat Resident Agent' -ForegroundColor Cyan
Write-Host ("Node: {0}" -f $nodePath)
Write-Host 'Production backend: FAR2-native resident WMPF' -ForegroundColor Green
Write-Host 'WMPFDebugger checkout: NOT USED' -ForegroundColor Green
Write-Host 'Provider endpoint: 127.0.0.1:43201' -ForegroundColor DarkGray
Write-Host 'Raw Code logging: disabled' -ForegroundColor DarkGray
Write-Host ''
Write-Host 'After the agent is armed, open QQ Classic Farm once from desktop WeChat.' -ForegroundColor Yellow
Write-Host 'Keep this window running. Ctrl+C stops only FAR2WeChatAgent.' -ForegroundColor DarkGray
Write-Host ''

Push-Location -LiteralPath $coreRoot
try {
    & $nodePath $agentScript
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    $env:FAR2_WECHAT_AGENT_TOKEN = $null
}

exit $exitCode
