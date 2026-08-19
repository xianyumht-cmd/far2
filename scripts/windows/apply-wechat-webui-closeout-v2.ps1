$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$legacyPath = Join-Path $PSScriptRoot 'apply-wechat-webui-closeout.ps1'
if (-not (Test-Path -LiteralPath $legacyPath -PathType Leaf)) {
    throw "Legacy closeout apply script not found: $legacyPath"
}

$text = Get-Content -LiteralPath $legacyPath -Raw -Encoding UTF8
$needle = 'New-Item -ItemType Directory -Force -Path $workRoot,$stageWeb,$backupRoot | Out-Null'
$count = ([regex]::Matches($text, [regex]::Escape($needle))).Count
if ($count -ne 1) {
    throw "Closeout apply compatibility anchor mismatch: stage directory anchor count=$count"
}

$replacement = @'
New-Item -ItemType Directory -Force -Path $workRoot,$stageWeb,$backupRoot | Out-Null

# vite.config.ts reads ../core/package.json to expose the app version.
# The isolated build stage contains only web/ by default, so provide exactly
# that read-only metadata file beside it. This is staging-only and never writes
# to the production core directory.
$stageCore = Join-Path (Split-Path -Parent $stageWeb) 'core'
$prodCorePackage = Join-Path $productionCore 'package.json'
$stageCorePackage = Join-Path $stageCore 'package.json'
if (-not (Test-Path -LiteralPath $prodCorePackage -PathType Leaf)) {
    throw "Production core package metadata missing: $prodCorePackage. No production files were modified."
}
New-Item -ItemType Directory -Force -Path $stageCore | Out-Null
Copy-Item -LiteralPath $prodCorePackage -Destination $stageCorePackage -Force
'@

$text = $text.Replace($needle, $replacement)
$tempPath = Join-Path $PSScriptRoot ('.apply-wechat-webui-closeout-fixed-{0}-{1}.ps1' -f $PID, (Get-Date).ToString('yyyyMMddHHmmssfff'))
$enc = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($tempPath, $text, $enc)

if ($PSVersionTable.PSEdition -eq 'Core') {
    $engine = Join-Path $PSHOME 'pwsh.exe'
} else {
    $engine = Join-Path $PSHOME 'powershell.exe'
}
if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) {
    throw "PowerShell engine not found: $engine"
}

try {
    & $engine -NoProfile -ExecutionPolicy Bypass -File $tempPath
    $rc = $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
}

exit $rc
