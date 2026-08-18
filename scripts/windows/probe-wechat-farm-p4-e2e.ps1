param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$probeScript = Join-Path $projectRoot 'core\scripts\wechat-p4-e2e-login.js'
$tempRoot = Join-Path $env:TEMP 'FAR2-WeChat-CDP'

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

if (-not (Test-Path -LiteralPath $probeScript)) {
    throw "P4 probe script not found: $probeScript"
}

$nodePath = Get-Node22Path
Write-Host ''
Write-Host 'FAR2 WeChat P4 E2E runner' -ForegroundColor Cyan
Write-Host ("Node: {0}" -f $nodePath)
Write-Host ''

Push-Location -LiteralPath (Join-Path $projectRoot 'core')
try {
    & $nodePath $probeScript
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $exitCode
