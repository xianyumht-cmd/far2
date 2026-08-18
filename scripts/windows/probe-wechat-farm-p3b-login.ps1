param(
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ExpectedWmpfVersion = 25297
$ExpectedMiniAppId = 'wx5306c5978fdb76e4'
$DebuggerCommit = '2b90b77fc6f13dd18480cd07d7dd9c052cc26c9d'
$DebugPort = 9421
$CdpPort = 62000
$FarmWindowTitle = 'QQ' + [char]0x7ECF + [char]0x5178 + [char]0x519C + [char]0x573A
$TempRoot = Join-Path $env:TEMP 'FAR2-WeChat-CDP'
$ReportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$DebuggerDir = Join-Path $TempRoot 'WMPFDebugger-25297'

function Test-PortListening {
    param([int]$Port)
    try { return @((Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)).Count -gt 0 }
    catch { return $false }
}

function Get-WmpfVersion {
    $versions = @()
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '(?i)^WeChatAppEx\.exe$' -and -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath)
    } | ForEach-Object {
        $m = [regex]::Match([string]$_.ExecutablePath, '(?i)RadiumWMPF[\\/](\d+)[\\/]extracted')
        if ($m.Success) { $versions += [int]$m.Groups[1].Value }
    }
    if ($versions.Count -eq 0) { return $null }
    return [int]($versions | Sort-Object -Unique -Descending | Select-Object -First 1)
}

function Test-FarmWindowOpen {
    try {
        return @(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object {
            [string]$_.MainWindowTitle -eq $FarmWindowTitle
        }).Count -gt 0
    }
    catch { return $false }
}

function Get-NodePath {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        $version = (& $node.Source -p "process.versions.node").Trim()
        $major = [int]$version.Split('.')[0]
        if ($major -ge 22) { return [string]$node.Source }
    }
    $cached = Get-ChildItem -LiteralPath (Join-Path $TempRoot 'node22') -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cached) { return [string]$cached.FullName }
    throw 'Node.js 22+ was not found. Run the P3 CDP probe first.'
}

function Assert-DebuggerReady {
    param([string]$NodePath)
    if (-not (Test-Path -LiteralPath (Join-Path $DebuggerDir '.git'))) {
        throw 'Pinned WMPFDebugger checkout is missing. Run the P3 CDP probe first.'
    }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { throw 'git.exe is required to verify the pinned debugger checkout.' }
    $head = (& $git.Source -C $DebuggerDir rev-parse HEAD).Trim()
    if ($head -ne $DebuggerCommit) { throw 'WMPFDebugger checkout is not at the pinned 25297 commit. Run P3 again.' }
    foreach ($path in @(
        (Join-Path $DebuggerDir 'node_modules\frida'),
        (Join-Path $DebuggerDir 'node_modules\ts-node\dist\bin.js'),
        (Join-Path $DebuggerDir 'src\index.ts')
    )) {
        if (-not (Test-Path -LiteralPath $path)) { throw 'P3 debugger dependencies are incomplete. Run P3 again.' }
    }
}

function Send-CdpMessage {
    param([System.Net.WebSockets.ClientWebSocket]$Socket, [hashtable]$Message)
    $json = $Message | ConvertTo-Json -Depth 12 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $segment = [ArraySegment[byte]]::new($bytes)
    [void]$Socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Receive-CdpMessage {
    param([System.Net.WebSockets.ClientWebSocket]$Socket, [int]$TimeoutMs = 1200)
    if ($Socket.State -ne [Net.WebSockets.WebSocketState]::Open) {
        throw ("CDP WebSocket is not open (state={0})." -f $Socket.State)
    }
    if (-not (Get-Variable -Name Far2P3bReceiveStream -Scope Script -ErrorAction SilentlyContinue)) {
        $script:Far2P3bReceiveStream = [IO.MemoryStream]::new()
        $script:Far2P3bPendingReceive = $null
        $script:Far2P3bReceiveBuffer = $null
    }
    $deadline = [Environment]::TickCount64 + [int64]$TimeoutMs
    while ([Environment]::TickCount64 -lt $deadline) {
        if ($null -eq $script:Far2P3bPendingReceive) {
            $script:Far2P3bReceiveBuffer = New-Object byte[] 262144
            $segment = [ArraySegment[byte]]::new($script:Far2P3bReceiveBuffer)
            $script:Far2P3bPendingReceive = $Socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
        }
        $remaining64 = $deadline - [Environment]::TickCount64
        if ($remaining64 -le 0) { return $null }
        $remaining = [int][Math]::Min([int64][int]::MaxValue, $remaining64)
        if (-not $script:Far2P3bPendingReceive.Wait($remaining)) { return $null }
        $result = $script:Far2P3bPendingReceive.GetAwaiter().GetResult()
        $script:Far2P3bPendingReceive = $null
        if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
            $script:Far2P3bReceiveStream.SetLength(0)
            return $null
        }
        if ($result.Count -gt 0) {
            $script:Far2P3bReceiveStream.Write($script:Far2P3bReceiveBuffer, 0, $result.Count)
        }
        if ($result.EndOfMessage) {
            $payload = [Text.Encoding]::UTF8.GetString($script:Far2P3bReceiveStream.ToArray())
            $script:Far2P3bReceiveStream.SetLength(0)
            return $payload
        }
    }
    return $null
}

function Wait-CdpResponse {
    param([System.Net.WebSockets.ClientWebSocket]$Socket, [int]$Id, [int]$TimeoutMs = 8000)
    $deadline = [Environment]::TickCount64 + [int64]$TimeoutMs
    while ([Environment]::TickCount64 -lt $deadline) {
        $remaining = [int][Math]::Min([int64]1200, ($deadline - [Environment]::TickCount64))
        if ($remaining -le 0) { break }
        $raw = Receive-CdpMessage -Socket $Socket -TimeoutMs $remaining
        if ([string]::IsNullOrWhiteSpace([string]$raw)) { continue }
        try { $msg = $raw | ConvertFrom-Json } catch { continue }
        if ($msg.PSObject.Properties['id'] -and [int]$msg.id -eq $Id) { return $msg }
    }
    return $null
}

function Get-ResultValue {
    param($Response)
    if ($null -eq $Response) { return $null }
    if (-not $Response.PSObject.Properties['result'] -or -not $Response.result) { return $null }
    if (-not $Response.result.PSObject.Properties['result'] -or -not $Response.result.result) { return $null }
    if (-not $Response.result.result.PSObject.Properties['value']) { return $null }
    return $Response.result.result.value
}

$debuggerProcess = $null
$socket = $null
$loginCode = $null
try {
    Write-Host ''
    Write-Host 'FAR2 WeChat Farm P3B wx.login Proof' -ForegroundColor Cyan
    Write-Host '===================================='
    Write-Host 'P3 already proved that the farm runtime exposes wx.login.'
    Write-Host 'P3B identifies the farm AppId with wx.getAccountInfoSync(), then calls wx.login ONCE.'
    Write-Host 'The raw login Code is never printed or written to the JSON report.'
    Write-Host ''

    $wmpfVersion = Get-WmpfVersion
    if ($null -eq $wmpfVersion) { throw 'No running WeChat WMPF runtime was found.' }
    if ([int]$wmpfVersion -ne $ExpectedWmpfVersion) { throw ("Unsupported WMPF version: {0}. Expected {1}." -f $wmpfVersion, $ExpectedWmpfVersion) }

    if (Test-FarmWindowOpen) {
        Write-Host 'QQ Classic Farm is currently open.' -ForegroundColor Yellow
        Write-Host 'Close ONLY the farm mini-program window. Keep desktop WeChat logged in.'
        [void](Read-Host 'After the farm window is closed, press Enter')
        Start-Sleep -Milliseconds 700
        if (Test-FarmWindowOpen) { throw 'Farm window is still open.' }
    }

    if (Test-PortListening -Port $DebugPort) { throw ("Local port {0} is already in use." -f $DebugPort) }
    if (Test-PortListening -Port $CdpPort) { throw ("Local port {0} is already in use." -f $CdpPort) }

    $nodePath = Get-NodePath
    $nodeVersion = (& $nodePath -p "process.versions.node").Trim()
    Assert-DebuggerReady -NodePath $nodePath

    $tsNodeBin = Join-Path $DebuggerDir 'node_modules\ts-node\dist\bin.js'
    $entry = Join-Path $DebuggerDir 'src\index.ts'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $TempRoot ("wmpf-debugger-p3b-{0}.out.log" -f $stamp)
    $stderrLog = Join-Path $TempRoot ("wmpf-debugger-p3b-{0}.err.log" -f $stamp)

    Write-Host 'Starting isolated WMPF CDP bridge...' -ForegroundColor Yellow
    $debuggerProcess = Start-Process -FilePath $nodePath -ArgumentList @(
        $tsNodeBin, $entry, '--debug-port', [string]$DebugPort, '--cdp-port', [string]$CdpPort
    ) -WorkingDirectory $DebuggerDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        if ($debuggerProcess.HasExited) { break }
        if ((Test-PortListening -Port $DebugPort) -and (Test-PortListening -Port $CdpPort)) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'WMPF CDP bridge did not become ready.' }

    Write-Host ''
    Write-Host 'CDP bridge is ready.' -ForegroundColor Green
    Write-Host 'Now open QQ Classic Farm from desktop WeChat.' -ForegroundColor Green
    Write-Host 'Wait until the farm home screen is fully loaded.'
    [void](Read-Host 'Then return here and press Enter')
    Start-Sleep -Seconds 2

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    [void]$socket.ConnectAsync([Uri]("ws://127.0.0.1:{0}" -f $CdpPort), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    Send-CdpMessage -Socket $socket -Message @{ id = 1; method = 'Runtime.enable'; params = @{} }

    $contexts = @{}
    $deadline = [Environment]::TickCount64 + 5000
    while ([Environment]::TickCount64 -lt $deadline) {
        $raw = Receive-CdpMessage -Socket $socket -TimeoutMs 800
        if ([string]::IsNullOrWhiteSpace([string]$raw)) { continue }
        try { $msg = $raw | ConvertFrom-Json } catch { continue }
        if ($msg.PSObject.Properties['method'] -and [string]$msg.method -eq 'Runtime.executionContextCreated' -and $msg.PSObject.Properties['params'] -and $msg.params -and $msg.params.PSObject.Properties['context']) {
            $ctx = $msg.params.context
            $contexts[[int]$ctx.id] = [pscustomobject][ordered]@{
                id = [int]$ctx.id
                name = if ($ctx.PSObject.Properties['name']) { [string]$ctx.name } else { '' }
                origin = if ($ctx.PSObject.Properties['origin']) { [string]$ctx.origin } else { '' }
            }
        }
    }
    $contextList = @($contexts.Values | Sort-Object id | Select-Object -First 48)
    if ($contextList.Count -eq 0) { throw 'No CDP Runtime execution contexts were reported.' }

    $accountInfoExpr = "(() => { const out={hasWx:false,hasLogin:false,hasAccountInfo:false,appId:'',envVersion:'',version:'',error:''}; try { out.hasWx=(typeof globalThis.wx==='object'&&globalThis.wx!==null); out.hasLogin=(out.hasWx&&typeof globalThis.wx.login==='function'); out.hasAccountInfo=(out.hasWx&&typeof globalThis.wx.getAccountInfoSync==='function'); if(out.hasAccountInfo){ const i=globalThis.wx.getAccountInfoSync(); const m=(i&&i.miniProgram)?i.miniProgram:{}; out.appId=(typeof m.appId==='string'?m.appId:''); out.envVersion=(typeof m.envVersion==='string'?m.envVersion:''); out.version=(typeof m.version==='string'?m.version:''); } } catch(e) { out.error=String(e&&e.message?e.message:e).slice(0,160); } return out; })()"

    $contextRows = @()
    $requestId = 100
    foreach ($ctx in $contextList) {
        Send-CdpMessage -Socket $socket -Message @{
            id = $requestId
            method = 'Runtime.evaluate'
            params = @{ expression = $accountInfoExpr; contextId = [int]$ctx.id; returnByValue = $true; awaitPromise = $false; silent = $true }
        }
        $response = Wait-CdpResponse -Socket $socket -Id $requestId -TimeoutMs 5000
        $value = Get-ResultValue -Response $response
        $contextRows += [pscustomobject][ordered]@{
            contextId = [int]$ctx.id
            origin = [string]$ctx.origin
            evaluationOk = ($null -ne $value)
            hasWx = if ($null -ne $value -and $value.PSObject.Properties['hasWx']) { [bool]$value.hasWx } else { $false }
            hasWxLogin = if ($null -ne $value -and $value.PSObject.Properties['hasLogin']) { [bool]$value.hasLogin } else { $false }
            hasAccountInfo = if ($null -ne $value -and $value.PSObject.Properties['hasAccountInfo']) { [bool]$value.hasAccountInfo } else { $false }
            appId = if ($null -ne $value -and $value.PSObject.Properties['appId']) { [string]$value.appId } else { '' }
            envVersion = if ($null -ne $value -and $value.PSObject.Properties['envVersion']) { [string]$value.envVersion } else { '' }
            version = if ($null -ne $value -and $value.PSObject.Properties['version']) { [string]$value.version } else { '' }
            error = if ($null -ne $value -and $value.PSObject.Properties['error']) { [string]$value.error } else { '' }
        }
        $requestId++
    }

    $targetRows = @($contextRows | Where-Object { $_.hasWxLogin -and $_.appId -eq $ExpectedMiniAppId } | Sort-Object contextId)
    $selectedContextId = $null
    $loginAttempted = $false
    $loginSuccess = $false
    $codeLength = 0
    $loginErrMsg = ''

    if ($targetRows.Count -gt 0) {
        $selectedContextId = [int]$targetRows[0].contextId
        $loginAttempted = $true
        $loginExpr = "new Promise((resolve)=>{let done=false; const finish=(v)=>{if(done)return;done=true;resolve(v)}; const timer=setTimeout(()=>finish({ok:false,code:'',errMsg:'timeout'}),10000); try{globalThis.wx.login({success:(r)=>{clearTimeout(timer); const c=(r&&typeof r.code==='string')?r.code:''; finish({ok:c.length>0,code:c,errMsg:(r&&typeof r.errMsg==='string')?r.errMsg:''})},fail:(e)=>{clearTimeout(timer); finish({ok:false,code:'',errMsg:String(e&&e.errMsg?e.errMsg:'wx.login fail').slice(0,200)})}})}catch(e){clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.message?e.message:e).slice(0,200)})}})"
        $loginRequestId = 500
        Send-CdpMessage -Socket $socket -Message @{
            id = $loginRequestId
            method = 'Runtime.evaluate'
            params = @{ expression = $loginExpr; contextId = $selectedContextId; returnByValue = $true; awaitPromise = $true; silent = $true }
        }
        $loginResponse = Wait-CdpResponse -Socket $socket -Id $loginRequestId -TimeoutMs 15000
        $loginValue = Get-ResultValue -Response $loginResponse
        if ($null -ne $loginValue) {
            if ($loginValue.PSObject.Properties['code']) { $loginCode = [string]$loginValue.code }
            if ($loginValue.PSObject.Properties['errMsg']) { $loginErrMsg = [string]$loginValue.errMsg }
            $codeLength = if ([string]::IsNullOrEmpty([string]$loginCode)) { 0 } else { ([string]$loginCode).Length }
            $loginSuccess = ($loginValue.PSObject.Properties['ok'] -and [bool]$loginValue.ok -and $codeLength -gt 0)
        }
    }

    $report = [ordered]@{
        version = 1
        phase = 'wechat-farm-p3b-wx-login-proof'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        safety = [ordered]@{
            wxLoginCalled = $loginAttempted
            rawLoginCodePersisted = $false
            rawLoginCodePrinted = $false
            tokenOrCookieCaptured = $false
            chatDatabaseRead = $false
            networkPayloadCaptured = $false
        }
        environment = [ordered]@{
            wmpfVersion = $wmpfVersion
            nodeVersion = $nodeVersion
            debuggerCommit = $DebuggerCommit
            expectedMiniAppId = $ExpectedMiniAppId
        }
        summary = [ordered]@{
            executionContextCount = @($contextRows).Count
            targetAppContextCount = @($targetRows).Count
            selectedContextId = $selectedContextId
            loginAttempted = $loginAttempted
            loginSuccess = $loginSuccess
            codeLength = $codeLength
            gatePassed = $loginSuccess
            loginErrMsg = if ($loginSuccess) { '' } else { $loginErrMsg }
        }
        contexts = $contextRows
    }

    New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $OutputPath = Join-Path $ReportRoot ("wechat-farm-p3b-login-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($OutputPath, ($report | ConvertTo-Json -Depth 12), $utf8NoBom)

    $loginCode = $null
    $loginValue = $null
    $loginResponse = $null

    Write-Host ''
    Write-Host 'P3B capture completed.' -ForegroundColor Green
    Write-Host ("Target AppId contexts: {0}" -f $report.summary.targetAppContextCount)
    Write-Host ("Selected context: {0}" -f $report.summary.selectedContextId)
    Write-Host ("wx.login attempted: {0}" -f $report.summary.loginAttempted)
    Write-Host ("wx.login success: {0}" -f $report.summary.loginSuccess)
    Write-Host ("Code length: {0}" -f $report.summary.codeLength)
    Write-Host ("P3B Gate passed: {0}" -f $report.summary.gatePassed)
    Write-Host ''
    Write-Host 'Report path:' -ForegroundColor Cyan
    Write-Host $OutputPath
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'P3B probe failed.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
finally {
    $loginCode = $null
    if ($null -ne $socket) {
        try { $socket.Abort() } catch {}
        try { $socket.Dispose() } catch {}
    }
    if ($null -ne $debuggerProcess) {
        try { if (-not $debuggerProcess.HasExited) { Stop-Process -Id $debuggerProcess.Id -Force -ErrorAction SilentlyContinue } } catch {}
    }
}
