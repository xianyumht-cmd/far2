/**
 * ⚠️ 已作废（2026-11-14 实测）：本机 QQ 的「选择账号」是主窗口内的 Chromium 弹层，
 * EnumWindows 找不到独立 HWND，UIA 子树里也没有对应节点（dump=picker=not-found）。
 * 因此 pick 子命令在真机上不可用；保留下来的只有 close-farm / list 这两个窗口工具。
 * 多号取码的兜底改为 capture-code.js 的「按实际 UIN 绑定」+ --require-uin 严格模式。
 *
 * QQ 账号选择弹窗工具（窗口枚举 / 关闭农场窗口）
 *
 * 关键修复（2026-11-14 实测）：
 *   1. 之前用 -Command 传中文，控制台代码页会把 "选择账号" 变成乱码，永远匹配不到 →
 *      改用 -EncodedCommand（UTF-16LE Base64），中文原样送达。
 *   2. 弹窗不一定是 RootElement 的直接子窗口，可能是 QQ 主窗口的模态子窗 →
 *      先查根窗口，再退化为「在 QQ 进程窗口的整棵子树里找」。
 *
 * 命令:
 *   node tools/qq-account-picker.js list
 *   node tools/qq-account-picker.js pick   --uin 2320006072 --wait 90
 *   node tools/qq-account-picker.js dump   --title 选择账号
 *   node tools/qq-account-picker.js close  --title 选择账号
 *   node tools/qq-account-picker.js close-farm [--proc QQ]
 */

const { execFileSync } = require('node:child_process');

function ps(script, timeout) {
    // UTF-16LE + Base64：中文不会在命令行里被代码页吃掉
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], { encoding: 'utf8', windowsHide: true, timeout: timeout || 60000, maxBuffer: 8 * 1024 * 1024 });
    return String(out).trim();
}

const PRELUDE = [
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes -ErrorAction SilentlyContinue',
    'Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue',
    '$root = [System.Windows.Automation.AutomationElement]::RootElement',
    '$cond = [System.Windows.Automation.Condition]::TrueCondition',
].join('; ');

function listScript() {
    return PRELUDE + '; '
        + '$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond); '
        + 'foreach ($w in $wins) { $n = [string]$w.Current.Name; if (-not $n) { continue }; '
        + '$pn = ""; try { $pn = (Get-Process -Id $w.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}; '
        + 'Write-Output ("{0} | {1} | {2}" -f $w.Current.ProcessId, $pn, $n) }';
}

function findPickerSnippet(titleNeedle, procName) {
    // 返回一段把弹窗元素放进 $picker 的脚本；找不到时 $picker 为 $null
    return '$picker = $null; '
        + '$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond); '
        + 'foreach ($w in $wins) { $n = [string]$w.Current.Name; if ($n -and $n.Contains("' + titleNeedle + '")) { $picker = $w; break } }; '
        + 'if (-not $picker) { '
        + '  foreach ($w in $wins) { '
        + '    $pn = ""; try { $pn = (Get-Process -Id $w.Current.ProcessId -ErrorAction Stop).ProcessName } catch { continue }; '
        + '    if ($pn -ne "' + procName + '") { continue }; '
        + '    $hit = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, '
        + '      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "' + titleNeedle + '"))); '
        + '    if ($hit) { $picker = $hit; break } '
        + '  } }; ';
}

function pickScript(uin, waitSec, titleNeedle, procName) {
    return PRELUDE + '; '
        + '$deadline = (Get-Date).AddSeconds(' + waitSec + '); $result = "no-picker"; '
        + 'while ((Get-Date) -lt $deadline) { '
        + findPickerSnippet(titleNeedle, procName)
        + '  if ($picker) { '
        + '    $all = $picker.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond); '
        + '    $target = $null; '
        + '    foreach ($e in $all) { $nm = [string]$e.Current.Name; if ($nm -and $nm.Contains("' + uin + '")) { $target = $e; break } }; '
        + '    if (-not $target) { $result = "target-not-found"; break }; '
        + '    $clickable = $target; $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker; $cur = $target; '
        + '    for ($i = 0; $i -lt 5; $i++) { if ($null -eq $cur) { break }; '
        + '      $ct = $cur.Current.ControlType.ProgrammaticName; '
        + '      if ($ct -match "RadioButton|ListItem|Button|Group") { $clickable = $cur; break }; '
        + '      $cur = $walker.GetParent($cur) }; '
        + '    $inv = $null; '
        + '    if ($clickable.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $inv.Invoke() } '
        + '    elseif ($clickable.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$inv)) { $inv.Select() } '
        + '    elseif ($clickable.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$inv)) { $inv.Toggle() } '
        + '    elseif ($clickable.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$inv)) { try { $inv.DoDefaultAction() } catch {} } '
        + '    else { try { $clickable.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait(" ") } catch {} }; '
        + '    Start-Sleep -Milliseconds 500; '
        + '    $ok = $null; $all2 = $picker.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond); '
        + '    foreach ($e in $all2) { $nm = [string]$e.Current.Name; if ($nm -eq "确定" -or $nm -eq "OK") { '
        + '      $b = $null; if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$b)) { $ok = $e; break } } }; '
        + '    if ($ok) { $b2 = $null; [void]$ok.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$b2); $b2.Invoke(); $result = "clicked-target-and-ok" } '
        + '    else { try { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") } catch {}; $result = "selected-then-enter" }; '
        + '    break }; '
        + '  Start-Sleep -Milliseconds 400 }; '
        + 'Write-Output ("result=" + $result)';
}

function dumpScript(titleNeedle, procName, limit) {
    return PRELUDE + '; '
        + findPickerSnippet(titleNeedle, procName)
        + 'if (-not $picker) { Write-Output "picker=not-found"; exit 0 }; '
        + 'Write-Output ("picker=" + $picker.Current.Name + " | class=" + $picker.Current.ClassName); '
        + '$all = $picker.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond); $i = 0; '
        + 'foreach ($e in $all) { if ($i -ge ' + limit + ') { break }; $i++; '
        + '  Write-Output ("  [{0}] {1} | {2} | {3}" -f $i, $e.Current.ControlType.ProgrammaticName, $e.Current.ClassName, [string]$e.Current.Name) }';
}

function closeScript(title) {
    return PRELUDE + '; '
        + findPickerSnippet(title, 'QQ')
        + 'if ($picker) { $p = $null; if ($picker.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$p)) { $p.Close(); Write-Output "closed=1" } else { Write-Output "closed=0-no-window-pattern" } } '
        + 'else { Write-Output "closed=0" }';
}

function closeFarmScript(procName) {
    return PRELUDE + '; '
        + '$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond); $closed = 0; '
        + 'foreach ($w in $wins) { $n = [string]$w.Current.Name; if (-not $n) { continue }; '
        + 'if ($n -notmatch "农场") { continue }; '
        + '$pn = ""; try { $pn = (Get-Process -Id $w.Current.ProcessId -ErrorAction Stop).ProcessName } catch { continue }; '
        + 'if ($pn -ne "' + procName + '") { continue }; '
        + '$p = $null; if ($w.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$p)) { $p.Close(); $closed++ } }; '
        + 'Write-Output ("closed=" + $closed)';
}

function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0] || 'list';
    const arg = (name, fallback = '') => {
        const i = argv.indexOf('--' + name);
        return i >= 0 ? argv[i + 1] : fallback;
    };
    const title = arg('title', '选择账号');
    const proc = arg('proc', 'QQ');

    if (cmd === 'list') return console.log(ps(listScript()));
    if (cmd === 'close') return console.log(ps(closeScript(title)));
    if (cmd === 'close-farm') return console.log(ps(closeFarmScript(proc)));
    if (cmd === 'dump') return console.log(ps(dumpScript(title, proc, Number(arg('limit', '60')))));
    if (cmd === 'pick') {
        const uin = arg('uin');
        if (!uin) throw new Error('缺少 --uin');
        const wait = Number(arg('wait', '60'));
        return console.log(ps(pickScript(uin, wait, title, proc), (wait + 40) * 1000));
    }
    throw new Error('未知命令: ' + cmd);
}

try {
    main();
} catch (error) {
    console.error('FAILED', error && error.message);
    process.exitCode = 1;
}
