param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreRoot = Join-Path $projectRoot 'core'
$probeScript = Join-Path $coreRoot 'scripts\wechat-p4b-handshake-metadata.js'
$armScript = Join-Path $coreRoot 'scripts\wechat-p4b-network-arm.js'
$tempRoot = Join-Path $env:TEMP 'FAR2-WeChat-CDP'
$p4DepsRoot = Join-Path $tempRoot 'p4-node-deps'

function Get-NodePath {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        try {
            $version = (& $node.Source -p "process.versions.node").Trim()
            if ([int]$version.Split('.')[0] -ge 22) { return [string]$node.Source }
        }
        catch {}
    }
    $cacheRoot = Join-Path $tempRoot 'node22'
    if (Test-Path -LiteralPath $cacheRoot) {
        $cached = Get-ChildItem -LiteralPath $cacheRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cached) { return [string]$cached.FullName }
    }
    throw 'Node.js 22+ was not found. Run P3/P4 first.'
}

function Add-NodePath {
    param([string]$NodeModulesPath)
    if (-not (Test-Path -LiteralPath $NodeModulesPath)) { return }
    if ([string]::IsNullOrWhiteSpace($env:NODE_PATH)) {
        $env:NODE_PATH = $NodeModulesPath
    }
    elseif (-not (@($env:NODE_PATH -split [regex]::Escape([string][IO.Path]::PathSeparator)) -contains $NodeModulesPath)) {
        $env:NODE_PATH = $NodeModulesPath + [IO.Path]::PathSeparator + $env:NODE_PATH
    }
}

if (-not (Test-Path -LiteralPath $probeScript)) { throw "P4B probe script not found: $probeScript" }
if (-not (Test-Path -LiteralPath $armScript)) { throw "P4B Network arm script not found: $armScript" }

$nodePath = Get-NodePath
Add-NodePath -NodeModulesPath (Join-Path $p4DepsRoot 'node_modules')

Push-Location -LiteralPath $coreRoot
try {
    & $nodePath -e "require('ws')" *> $null
    if ($LASTEXITCODE -ne 0) { throw 'ws dependency is unavailable. Run the P4 E2E probe once to prepare the isolated dependency cache.' }

    Write-Host ''
    Write-Host 'FAR2 WeChat P4B official handshake metadata runner' -ForegroundColor Cyan
    Write-Host ("Node: {0}" -f $nodePath)
    Write-Host 'Payload capture: disabled' -ForegroundColor DarkGray
    Write-Host 'Network arm: enabled before miniapp connect' -ForegroundColor DarkGray
    Write-Host ''

    & $nodePath --require $armScript $probeScript
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $exitCode
