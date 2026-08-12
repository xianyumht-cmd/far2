param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$TaskPrefix = 'FAR2CodeAgent-'
)

$ErrorActionPreference = 'Stop'

function Find-Nssm {
    param([string]$ProjectRoot)
    $candidates = @(
        $env:NSSM_EXE,
        (Join-Path $ProjectRoot 'tools\nssm-2.24\win64\nssm.exe'),
        'D:\project2\lolapisevers\tools\nssm-2.24\win64\nssm.exe',
        'C:\tools\nssm\win64\nssm.exe'
    )
    try {
        $cmd = Get-Command nssm.exe -ErrorAction Stop
        $candidates = @($cmd.Source) + $candidates
    } catch {}
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return ''
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nssm = Find-Nssm -ProjectRoot $projectRoot

Get-ScheduledTask -TaskName "$TaskPrefix*" -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue } catch {}
    try { Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
    if ($nssm) {
        & $nssm remove $ServiceName confirm | Out-Null
    } else {
        sc.exe delete $ServiceName | Out-Null
    }
}

Write-Host 'FAR2 后台自启已移除。账号数据、Code、Web 配置均未删除。' -ForegroundColor Green
