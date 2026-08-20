param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$legacy = Join-Path $PSScriptRoot 'apply-wechat-on-invalid-refresh-policy.ps1'
if (-not (Test-Path -LiteralPath $legacy -PathType Leaf)) {
    throw "Legacy on-invalid policy apply script not found: $legacy"
}

$text = Get-Content -LiteralPath $legacy -Raw -Encoding UTF8

$helperAnchor = "function SecureString-ToPlain {"
if (-not $text.Contains($helperAnchor)) {
    throw 'Unable to patch Agent readiness wait: helper anchor not found.'
}

$waitHelper = @'
function Wait-AgentReady {
    param([int]$TimeoutSec = 60)
    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSec))
    $last = Test-AgentHealth
    while ((Get-Date) -lt $deadline) {
        if ($last.Available -and $last.AppId -eq $expectedAppId) { return $last }
        Write-Host ("Waiting Resident Agent to settle: {0} ..." -f $last.Reason) -ForegroundColor Yellow
        Start-Sleep -Seconds 2
        $last = Test-AgentHealth
    }
    return $last
}

'@
$text = $text.Replace($helperAnchor, $waitHelper + $helperAnchor)

$oldPre = @'
$agent = Test-AgentHealth
if (-not $agent.Available -or $agent.AppId -ne $expectedAppId) {
    throw "Resident Agent must be resident_connected before policy deployment ($($agent.Reason)). No production files were modified."
}
'@
$newPre = @'
$agent = Wait-AgentReady -TimeoutSec 60
if (-not $agent.Available -or $agent.AppId -ne $expectedAppId) {
    throw "Resident Agent did not become resident_connected within 60s ($($agent.Reason)). No production files were modified."
}
'@
if (-not $text.Contains($oldPre)) {
    throw 'Unable to patch Agent readiness wait: preflight block not found.'
}
$text = $text.Replace($oldPre, $newPre)

$oldPost = @'
    $agentAfter = Test-AgentHealth
    if (-not $agentAfter.Available -or $agentAfter.AppId -ne $expectedAppId) { throw 'Resident Agent is not ready after policy restart.' }
'@
$newPost = @'
    $agentAfter = Wait-AgentReady -TimeoutSec 60
    if (-not $agentAfter.Available -or $agentAfter.AppId -ne $expectedAppId) { throw "Resident Agent did not return to resident_connected within 60s after policy restart ($($agentAfter.Reason))." }
'@
if (-not $text.Contains($oldPost)) {
    throw 'Unable to patch Agent readiness wait: post-restart block not found.'
}
$text = $text.Replace($oldPost, $newPost)

$temp = Join-Path $PSScriptRoot ('.apply-wechat-on-invalid-refresh-policy-fixed-{0}-{1}.ps1' -f $PID, (Get-Date).ToString('yyyyMMddHHmmssfff'))
try {
    [IO.File]::WriteAllText($temp, $text, (New-Object Text.UTF8Encoding($false)))

    $hostExe = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
        $hostExe = Join-Path $PSHOME 'powershell.exe'
    }
    if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
        $resolved = Get-Command pwsh.exe -ErrorAction SilentlyContinue
        if (-not $resolved) { $resolved = Get-Command powershell.exe -ErrorAction SilentlyContinue }
        if (-not $resolved) { throw 'PowerShell executable not found.' }
        $hostExe = [string]$resolved.Source
    }

    & $hostExe -NoProfile -ExecutionPolicy Bypass -File $temp
    $rc = $LASTEXITCODE
    if ($null -eq $rc) { $rc = 1 }
    exit $rc
}
finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}
