[CmdletBinding()]
param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$TaskName = 'FAR2UpdateAgent'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    & $File @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "Command failed (exit=$code): $File $($Arguments -join ' ')"
    }
    return $code
}

function Get-NativeOutput {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $output = & $File @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "Command failed (exit=$code): $File $($Arguments -join ' ')`n$($output -join "`n")"
    }
    return (($output | ForEach-Object { "$_" }) -join "`n").Trim()
}

function Assert-SafeName {
    param([string]$Name, [string]$Label)
    if ($Name -notmatch '^[A-Za-z0-9_.-]{1,64}$') {
        throw "$Label contains unsupported characters: $Name"
    }
}

function Assert-CanonicalOrigin {
    param([string]$Origin)
    $value = $Origin.Trim()
    $allowed = @(
        '^https://github\.com/xianyumht-cmd/far2(?:\.git)?/?$',
        '^git@github\.com:xianyumht-cmd/far2(?:\.git)?$',
        '^ssh://git@github\.com/xianyumht-cmd/far2(?:\.git)?/?$'
    )
    if (-not ($allowed | Where-Object { $value -match $_ })) {
        throw "Unexpected FAR2 origin: $value"
    }
}

function Wait-Far2Health {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [int]$TimeoutSeconds = 45
    )

    $uri = "http://127.0.0.1:$Port/api/ping"
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = ''
    do {
        try {
            $response = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 3 -ErrorAction Stop
            $actualVersion = [string]$response.data.version
            if ($response.ok -eq $true -and $response.data.ok -eq $true -and $actualVersion -eq $ExpectedVersion) {
                return $true
            }
            $lastError = "Unexpected health response/version: expected=$ExpectedVersion actual=$actualVersion"
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 750
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "FAR2 HTTP health check failed at $uri after $TimeoutSeconds seconds. Last error: $lastError"
}

function Get-ServiceEnvironmentEntries {
    param([string]$Name)
    $parametersKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (-not (Test-Path -LiteralPath $parametersKey)) {
        throw "NSSM service parameters key not found: $parametersKey"
    }
    try {
        return @((Get-ItemProperty -Path $parametersKey -Name 'AppEnvironmentExtra' -ErrorAction Stop).AppEnvironmentExtra)
    } catch {
        return @()
    }
}

function Convert-EntriesToMap {
    param([string[]]$Entries)
    $map = [ordered]@{}
    foreach ($entry in @($Entries)) {
        $text = [string]$entry
        $idx = $text.IndexOf('=')
        if ($idx -le 0) { continue }
        $map[$text.Substring(0, $idx)] = $text.Substring($idx + 1)
    }
    return $map
}

function Set-ServiceEnvironmentMap {
    param([string]$Name, $Map)
    $parametersKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    $entries = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Map.Keys) {
        $entries.Add("$key=$($Map[$key])")
    }
    New-ItemProperty -Path $parametersKey -Name 'AppEnvironmentExtra' -PropertyType MultiString -Value @($entries) -Force | Out-Null
    $written = @((Get-ItemProperty -Path $parametersKey -Name 'AppEnvironmentExtra' -ErrorAction Stop).AppEnvironmentExtra)
    foreach ($entry in @($entries)) {
        if ($written -notcontains $entry) {
            throw "Service environment verification failed for: $($entry.Split('=')[0])"
        }
    }
}

if (-not (Test-Admin)) {
    throw 'Run install-webui-update.cmd as Administrator.'
}
Assert-SafeName -Name $ServiceName -Label 'ServiceName'
Assert-SafeName -Name $TaskName -Label 'TaskName'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreDir = Join-Path $projectRoot 'core'
$workerPath = Join-Path $coreDir 'scripts\release-update-worker.js'
$runnerPath = Join-Path $PSScriptRoot 'run-far2-update-agent.ps1'
$packagePath = Join-Path $coreDir 'package.json'

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.git') -PathType Container)) {
    throw "FAR2 must be a Git checkout: $projectRoot"
}
if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
    throw "Update worker not found: $workerPath"
}
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "FAR2 package.json not found: $packagePath"
}
$expectedVersion = [string]((Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json).version)
if ([string]::IsNullOrWhiteSpace($expectedVersion)) {
    throw 'FAR2 package version is empty.'
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Update Agent runner not found: $runnerPath"
}
if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    throw "FAR2 NSSM service not found: $ServiceName"
}

$gitPath = (Get-Command git.exe -ErrorAction Stop).Source
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$pnpmPath = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$gitDir = [System.IO.Path]::GetDirectoryName($gitPath)
$pnpmDir = [System.IO.Path]::GetDirectoryName($pnpmPath)

$branch = Get-NativeOutput -File $gitPath -Arguments @('-C', $projectRoot, 'branch', '--show-current')
if ($branch -ne 'main') {
    throw "FAR2 WebUI one-click update requires the local checkout to be on main. Current: $branch"
}
$origin = Get-NativeOutput -File $gitPath -Arguments @('-C', $projectRoot, 'remote', 'get-url', 'origin')
Assert-CanonicalOrigin -Origin $origin
$dirty = Get-NativeOutput -File $gitPath -Arguments @('-C', $projectRoot, 'status', '--porcelain', '--untracked-files=no')
if ($dirty) {
    throw 'Tracked local changes exist. Commit, back up, or discard them before enabling one-click update.'
}

$oldPrompt = $env:GIT_TERMINAL_PROMPT
$env:GIT_TERMINAL_PROMPT = '0'
try {
    Write-Host '[FAR2] Verifying current Windows user can read private origin/main...'
    Invoke-Native -File $gitPath -Arguments @('-C', $projectRoot, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main') | Out-Null
} finally {
    $env:GIT_TERMINAL_PROMPT = $oldPrompt
}

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($currentUser -match '(?i)\\SYSTEM$') {
    throw 'Update Agent must be installed from the interactive Windows user, not LocalSystem.'
}

Write-Host '[FAR2] Installing locked dependencies for the first WebUI update bootstrap...'
Push-Location -LiteralPath $projectRoot
try {
    Invoke-Native -File $pnpmPath -Arguments @('install', '--frozen-lockfile') | Out-Null
    Write-Host '[FAR2] Running the canonical verification gate (includes WebUI production build)...'
    Invoke-Native -File $pnpmPath -Arguments @('verify') | Out-Null
} finally {
    Pop-Location
}

$dirtyAfterVerify = Get-NativeOutput -File $gitPath -Arguments @('-C', $projectRoot, 'status', '--porcelain', '--untracked-files=no')
if ($dirtyAfterVerify) {
    Write-Host $dirtyAfterVerify -ForegroundColor Yellow
    throw 'Verification changed tracked files. Update Agent installation stopped before modifying Windows task/service configuration.'
}

$oldTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($oldTask) {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
}

$taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerPath`" -ProjectRoot `"$projectRoot`" -NodePath `"$nodePath`" -GitDir `"$gitDir`" -PnpmDir `"$pnpmDir`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs -WorkingDirectory $projectRoot
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Description 'FAR2 WebUI one-click update agent. Runs Git/update verification as the interactive Windows user.' -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ([string]$task.Principal.UserId -ne $currentUser) {
    throw "Update task principal mismatch: $($task.Principal.UserId) != $currentUser"
}

$environmentMap = Convert-EntriesToMap -Entries (Get-ServiceEnvironmentEntries -Name $ServiceName)
$environmentMap['FAR2_UPDATE_TASK_NAME'] = $TaskName
$environmentMap['FAR2_SERVICE_NAME'] = $ServiceName
Set-ServiceEnvironmentMap -Name $ServiceName -Map $environmentMap

$adminPort = 3007
if ($environmentMap.Contains('ADMIN_PORT')) {
    $configuredPort = 0
    if ([int]::TryParse([string]$environmentMap['ADMIN_PORT'], [ref]$configuredPort) -and $configuredPort -ge 1 -and $configuredPort -le 65535) {
        $adminPort = $configuredPort
    }
}

Write-Host '[FAR2] Restarting service so the WebUI receives Update Agent configuration...'
Restart-Service -Name $ServiceName -Force -ErrorAction Stop
Start-Sleep -Seconds 3
$service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($service.Status -ne 'Running') {
    throw "FAR2 service did not return to Running state: $($service.Status)"
}
Write-Host "[FAR2] Waiting for HTTP health: http://127.0.0.1:$adminPort/api/ping expectedVersion=$expectedVersion"
Wait-Far2Health -Port $adminPort -ExpectedVersion $expectedVersion | Out-Null
Write-Host '[FAR2] HTTP health verified.'

Write-Host ''
Write-Host '=== FAR2 WebUI one-click update enabled ===' -ForegroundColor Green
Write-Host "Service: $ServiceName (LocalSystem)"
Write-Host "Update Agent: $TaskName user=$currentUser"
Write-Host "Origin: $origin"
Write-Host 'Private-repository Git runs in the interactive user context; no PAT is stored in the FAR2 service.'
Write-Host 'Dependencies, regression gate, and WebUI production build were verified before service restart.'
Write-Host 'Open WebUI -> 升级. The page should show “可一键升级”.'
