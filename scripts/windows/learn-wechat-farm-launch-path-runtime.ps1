param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreRoot = Join-Path $projectRoot 'core'
$learnerScript = Join-Path $coreRoot 'scripts\wechat-runtime-launch-path-learner.js'
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
    throw 'Node.js 22+ was not found. Run the earlier native WeChat gate once.'
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
        & $NodePath -e "require('frida');require('ws');require('protobufjs');" *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch { return $false }
    finally { Pop-Location }
}

if (-not (Test-Path -LiteralPath $learnerScript)) {
    throw "Runtime launch-path learner not found: $learnerScript"
}

$nodePath = Get-NodePath
$nodeModules = Join-Path $depsRoot 'node_modules'
Add-NodePath -NodeModulesPath $nodeModules

if (-not (Test-Dependencies -NodePath $nodePath)) {
    throw 'FAR2-native dependencies are unavailable. Run .\test-wechat-native-agent-gate.cmd once first.'
}

& $nodePath --check $learnerScript
if ($LASTEXITCODE -ne 0) { throw 'Runtime launch-path learner JavaScript syntax check failed.' }

Write-Host ''
Write-Host 'FAR2 WeChat runtime launch-path learner' -ForegroundColor Cyan
Write-Host ("Node: {0}" -f $nodePath)
Write-Host 'Transport: FAR2-native WMPF' -ForegroundColor Green
Write-Host 'wx.login: NOT CALLED' -ForegroundColor Green
Write-Host 'Persisted runtime data: exact AppId + route only' -ForegroundColor DarkGray
Write-Host ''

Push-Location -LiteralPath $coreRoot
try {
    & $nodePath $learnerScript
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $exitCode
