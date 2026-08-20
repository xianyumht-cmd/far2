param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreRoot = Join-Path $projectRoot 'core'
$gateScript = Join-Path $coreRoot 'scripts\wechat-agent-native-gate.js'
$tempRoot = Join-Path $env:TEMP 'FAR2-WeChat-Native'
$depsRoot = Join-Path $tempRoot 'node-deps'

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
        if ($LASTEXITCODE -ne 0) { throw "P6 native gate dependency install failed with exit code $LASTEXITCODE." }
        return
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm.exe -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm was not found.' }
    & $npm.Source @args
    if ($LASTEXITCODE -ne 0) { throw "P6 native gate dependency install failed with exit code $LASTEXITCODE." }
}

function Test-NativeModulePreflight {
    param([string]$NodePath)
    $script = @"
const m=require('./src/services/wechat-wmpf-native-capture');
new Function(m.buildFridaSource());
const outer=m.encodeDebugMessage(7,'chromeDevtools',Buffer.from([1,2,3]));
const decoded=m.decodeDebugMessage(outer);
if(decoded.seq!==7||decoded.category!=='chromeDevtools'||decoded.data.length!==3)process.exit(2);
const inner=m.encodeChromeDevtools('{\"id\":1}',9);
const innerDecoded=m.decodeChromeDevtoolsResult(inner);
if(String(innerDecoded.payload)!=='{\"id\":1}')process.exit(3);
"@
    Push-Location -LiteralPath $coreRoot
    try {
        & $NodePath -e $script
        if ($LASTEXITCODE -ne 0) { throw "Native WMPF module preflight failed with exit code $LASTEXITCODE." }
    }
    finally { Pop-Location }
}

if (-not (Test-Path -LiteralPath $gateScript)) { throw "P6 native gate script not found: $gateScript" }

$nodePath = Get-NodePath
$nodeModules = Join-Path $depsRoot 'node_modules'
Add-NodePath -NodeModulesPath $nodeModules

if (-not (Test-Dependencies -NodePath $nodePath)) {
    Write-Host 'Preparing isolated FAR2-native WMPF dependencies...' -ForegroundColor Yellow
    Install-Dependencies -NodePath $nodePath
    Add-NodePath -NodeModulesPath $nodeModules
    if (-not (Test-Dependencies -NodePath $nodePath)) {
        throw 'P6 native gate dependencies are unavailable after isolated install.'
    }
}

Test-NativeModulePreflight -NodePath $nodePath

Write-Host ''
Write-Host 'FAR2 WeChat P6 native WMPF Agent runner' -ForegroundColor Cyan
Write-Host ("Node: {0}" -f $nodePath)
Write-Host 'Native module preflight: PASS' -ForegroundColor Green
Write-Host 'WMPFDebugger checkout: NOT USED' -ForegroundColor Green
Write-Host 'Transport owner: FAR2 (Frida instrumentation runtime only)' -ForegroundColor DarkGray
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
