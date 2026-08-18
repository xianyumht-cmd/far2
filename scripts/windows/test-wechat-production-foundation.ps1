param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreRoot = Join-Path $projectRoot 'core'
$testScript = Join-Path $coreRoot 'scripts\wechat-production-foundation-selftest.js'
$tempRoot = Join-Path $env:TEMP 'FAR2-WeChat-CDP'
$p4DepsRoot = Join-Path $tempRoot 'p4-node-deps\node_modules'

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
    throw 'Node.js 22+ was not found.'
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

if (-not (Test-Path -LiteralPath $testScript)) {
    throw "WeChat production selftest not found: $testScript"
}

$nodePath = Get-NodePath
Add-NodePath -NodeModulesPath $p4DepsRoot

Push-Location -LiteralPath $coreRoot
try {
    & $nodePath -e "require('ws')" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'ws dependency is unavailable. Run the P4 E2E probe once to prepare the isolated cache.'
    }

    Write-Host ''
    Write-Host 'FAR2 WeChat production foundation selftest' -ForegroundColor Cyan
    Write-Host ("Node: {0}" -f $nodePath)
    Write-Host ''

    & $nodePath $testScript
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $exitCode
