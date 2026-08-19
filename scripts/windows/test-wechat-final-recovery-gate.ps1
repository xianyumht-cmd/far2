param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreRoot = Join-Path $projectRoot 'core'
$gateScript = Join-Path $coreRoot 'scripts\wechat-final-recovery-gate.js'
$childScript = Join-Path $coreRoot 'scripts\wechat-native-unattended-capture-child.js'
$adapterScript = Join-Path $coreRoot 'src\services\wechat-unattended-capture-adapter.js'
$tempRoot = Join-Path $env:TEMP 'FAR2-WeChat-Native'
$depsRoot = Join-Path $tempRoot 'node-deps'
$launchProfilePath = Join-Path $env:LOCALAPPDATA 'FAR2\wechat-launch-profile.json'
$expectedAppId = 'wx5306c5978fdb76e4'
$launchPathSource = ''

function Get-NodePath {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        try {
            $version = (& $node.Source -p "process.versions.node").Trim()
            if ([int]$version.Split('.')[0] -ge 22) { return [string]$node.Source }
        }
        catch {}
    }

    $oldRoot = Join-Path $env:TEMP 'FAR2-WeChat-CDP\node22'
    if (Test-Path -LiteralPath $oldRoot) {
        $cached = Get-ChildItem -LiteralPath $oldRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cached) {
            try {
                $version = (& $cached.FullName -p "process.versions.node").Trim()
                if ([int]$version.Split('.')[0] -ge 22) { return [string]$cached.FullName }
            }
            catch {}
        }
    }
    throw 'Node.js 22+ was not found. Run the earlier WeChat gate once.'
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
        'install',
        '--prefix', $depsRoot,
        '--no-audit',
        '--no-fund',
        '--no-save',
        'frida@17.3.2',
        'ws@8.19.0',
        'long@5.3.2',
        'protobufjs@8.0.0',
        'node-fetch@2.7.0'
    )

    if (Test-Path -LiteralPath $npmCli) {
        & $NodePath $npmCli @args
        if ($LASTEXITCODE -ne 0) { throw "P7 dependency install failed with exit code $LASTEXITCODE." }
        return
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm.exe -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm was not found.' }
    & $npm.Source @args
    if ($LASTEXITCODE -ne 0) { throw "P7 dependency install failed with exit code $LASTEXITCODE." }
}

function Test-JavascriptSyntax {
    param([string]$NodePath)
    foreach ($file in @($gateScript, $childScript, $adapterScript)) {
        & $NodePath --check $file
        if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $file" }
    }
}

function Import-LearnedLaunchPath {
    if (-not [string]::IsNullOrWhiteSpace($env:FARM_WECHAT_LAUNCH_PATH)) {
        $candidate = [string]$env:FARM_WECHAT_LAUNCH_PATH
        if ($candidate -match '^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)+$' -and -not $candidate.Contains('..')) {
            $script:launchPathSource = 'environment override'
            return
        }
        throw 'FARM_WECHAT_LAUNCH_PATH is present but invalid.'
    }

    if (-not (Test-Path -LiteralPath $launchProfilePath)) {
        throw 'No proven WeChat farm launch path is available. Run .\learn-wechat-farm-launch-path.cmd once, then rerun P7.'
    }

    try {
        $profile = Get-Content -LiteralPath $launchProfilePath -Raw | ConvertFrom-Json
    }
    catch {
        throw 'The learned WeChat launch profile is invalid. Run .\learn-wechat-farm-launch-path.cmd again.'
    }

    $appId = [string]$profile.appId
    $candidate = [string]$profile.path
    if ($appId -ne $expectedAppId) {
        throw 'The learned WeChat launch profile belongs to a different AppId.'
    }
    if ([string]::IsNullOrWhiteSpace($candidate) -or
        $candidate -notmatch '^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)+$' -or
        $candidate.Contains('..')) {
        throw 'The learned WeChat farm launch path is invalid. Run .\learn-wechat-farm-launch-path.cmd again.'
    }

    $env:FARM_WECHAT_LAUNCH_PATH = $candidate
    $script:launchPathSource = 'locally learned exact path'
}

foreach ($file in @($gateScript, $childScript, $adapterScript)) {
    if (-not (Test-Path -LiteralPath $file)) { throw "P7 file not found: $file" }
}

Import-LearnedLaunchPath

$nodePath = Get-NodePath
$nodeModules = Join-Path $depsRoot 'node_modules'
Add-NodePath -NodeModulesPath $nodeModules

if (-not (Test-Dependencies -NodePath $nodePath)) {
    Write-Host 'Preparing isolated FAR2-native WMPF dependencies...' -ForegroundColor Yellow
    Install-Dependencies -NodePath $nodePath
    Add-NodePath -NodeModulesPath $nodeModules
    if (-not (Test-Dependencies -NodePath $nodePath)) {
        throw 'P7 dependencies are unavailable after isolated install.'
    }
}

Test-JavascriptSyntax -NodePath $nodePath

Write-Host ''
Write-Host 'FAR2 WeChat P7 final unattended recovery runner' -ForegroundColor Cyan
Write-Host ("Node: {0}" -f $nodePath)
Write-Host 'JavaScript preflight: PASS' -ForegroundColor Green
Write-Host 'WMPFDebugger checkout: NOT USED' -ForegroundColor Green
Write-Host ("Farm launch path: {0}" -f $launchPathSource) -ForegroundColor Green
Write-Host 'Farm launch: exact published path through Windows WeChat protocol handler' -ForegroundColor Green
Write-Host 'Recovery trigger: scoped ws_400 event' -ForegroundColor DarkGray
Write-Host 'QQ control account/worker: must remain untouched' -ForegroundColor DarkGray
Write-Host 'Raw Code logging: disabled' -ForegroundColor DarkGray
Write-Host ''

Push-Location -LiteralPath $coreRoot
try {
    & $nodePath $gateScript
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $exitCode
