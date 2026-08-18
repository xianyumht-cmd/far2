param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreRoot = Join-Path $projectRoot 'core'
$probeScript = Join-Path $coreRoot 'scripts\wechat-p4-e2e-login.js'
$tempRoot = Join-Path $env:TEMP 'FAR2-WeChat-CDP'
$p4DepsRoot = Join-Path $tempRoot 'p4-node-deps'

function Get-Node22Path {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        try {
            $version = (& $node.Source -p "process.versions.node").Trim()
            $major = [int]$version.Split('.')[0]
            if ($major -ge 22) { return [string]$node.Source }
        }
        catch {}
    }

    $cacheRoot = Join-Path $tempRoot 'node22'
    if (Test-Path -LiteralPath $cacheRoot) {
        $cached = Get-ChildItem -LiteralPath $cacheRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cached) {
            try {
                $version = (& $cached.FullName -p "process.versions.node").Trim()
                $major = [int]$version.Split('.')[0]
                if ($major -ge 22) { return [string]$cached.FullName }
            }
            catch {}
        }
    }

    throw 'Node.js 22+ was not found. Run the P3 CDP probe first.'
}

function Test-P4NodeDependencies {
    param([string]$NodePath)

    Push-Location -LiteralPath $coreRoot
    try {
        & $NodePath -e "require('ws');require('long');require('protobufjs');" *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
    finally {
        Pop-Location
    }
}

function Add-P4NodePath {
    param([string]$NodeModulesPath)

    if ([string]::IsNullOrWhiteSpace($env:NODE_PATH)) {
        $env:NODE_PATH = $NodeModulesPath
        return
    }
    $parts = @($env:NODE_PATH -split [regex]::Escape([string][IO.Path]::PathSeparator))
    if ($parts -notcontains $NodeModulesPath) {
        $env:NODE_PATH = $NodeModulesPath + [IO.Path]::PathSeparator + $env:NODE_PATH
    }
}

function Invoke-P4NpmInstall {
    param([string]$NodePath)

    New-Item -ItemType Directory -Force -Path $p4DepsRoot | Out-Null
    $nodeDir = Split-Path -Parent $NodePath
    $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'

    $args = @(
        'install',
        '--prefix', $p4DepsRoot,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--no-save',
        'ws@8.19.0',
        'long@5.3.2',
        'protobufjs@8.0.0'
    )

    if (Test-Path -LiteralPath $npmCli) {
        & $NodePath $npmCli @args
        if ($LASTEXITCODE -ne 0) { throw "P4 dependency install failed with exit code $LASTEXITCODE." }
        return
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm.exe -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'npm was not found. P4 needs npm once to install isolated probe dependencies.' }

    & $npm.Source @args
    if ($LASTEXITCODE -ne 0) { throw "P4 dependency install failed with exit code $LASTEXITCODE." }
}

function Ensure-P4NodeDependencies {
    param([string]$NodePath)

    if (Test-P4NodeDependencies -NodePath $NodePath) {
        Write-Host 'P4 Node dependencies: project-local ready' -ForegroundColor DarkGray
        return
    }

    $depsNodeModules = Join-Path $p4DepsRoot 'node_modules'
    if (Test-Path -LiteralPath $depsNodeModules) {
        Add-P4NodePath -NodeModulesPath $depsNodeModules
        if (Test-P4NodeDependencies -NodePath $NodePath) {
            Write-Host 'P4 Node dependencies: isolated cache ready' -ForegroundColor DarkGray
            return
        }
    }

    Write-Host 'Installing isolated P4 Node dependencies once...' -ForegroundColor Yellow
    Invoke-P4NpmInstall -NodePath $NodePath

    $depsNodeModules = Join-Path $p4DepsRoot 'node_modules'
    if (-not (Test-Path -LiteralPath $depsNodeModules)) {
        throw 'P4 dependency node_modules directory was not created.'
    }

    Add-P4NodePath -NodeModulesPath $depsNodeModules
    if (-not (Test-P4NodeDependencies -NodePath $NodePath)) {
        throw 'P4 Node dependencies are still unavailable after isolated install.'
    }
    Write-Host 'P4 Node dependencies: isolated install ready' -ForegroundColor Green
}

if (-not (Test-Path -LiteralPath $probeScript)) {
    throw "P4 probe script not found: $probeScript"
}

$nodePath = Get-Node22Path
Write-Host ''
Write-Host 'FAR2 WeChat P4 E2E runner' -ForegroundColor Cyan
Write-Host ("Node: {0}" -f $nodePath)

Ensure-P4NodeDependencies -NodePath $nodePath
Write-Host ''

Push-Location -LiteralPath $coreRoot
try {
    & $nodePath $probeScript
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $exitCode
