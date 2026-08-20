# FAR2 P0-002 Runtime Shell Audit — 2026-08-20

## Scope

Classify production runtime paths that can create child processes, PowerShell, CIM process scans, or external shell commands. The target is not "zero child processes"; the target is "no unexplained recurring shell creation while FAR2 is healthy and idle".

## Classification

### `desktop-session-registry.js`

Live Session discovery executes a hidden `powershell.exe` and runs `Get-CimInstance Win32_Process` to build the QQ/Farm process tree.

Disposition:

- this was the source used by P0-001 every 10 seconds;
- PR #58 moves healthy event-only CodeManager ticks and status reads off this live-scan path;
- startup, actual recovery events, explicit Session refresh/bind operations, and isolated-agent identity checks may still request live process evidence.

### `windows-runtime-code.js`

Fresh Code capture uses external commands for three bounded purposes:

- clear the clipboard once at capture start;
- open the QQ mini app once (with a command fallback);
- read the clipboard as a fallback if the injected `_code.txt` artifact is not available.

The previous fallback read ran on every 250 ms wait loop iteration. Because `readClipboard()` itself starts `powershell.exe`, one Code-refresh event could create roughly four PowerShell processes per second until capture completed or timed out.

This is not an idle periodic bug, but it is unnecessary shell churn during recovery.

Fix in this branch:

- `_code.txt` remains the 250 ms fast path;
- clipboard fallback is delayed for 1 second and then limited to once every 2 seconds;
- the fallback is preserved for compatibility if file output is unavailable;
- the wait loop gained dependency-injection seams so the cadence can be regression-tested without touching QQ, the clipboard, or PowerShell.

### `worker-manager.js`

Worker process creation is tied to account start/restart. Thread runtime is preferred when available; fork runtime is used where required. Stop/restart includes bounded force-kill/restart fallbacks. No healthy-idle periodic child creation was found in this path.

### `isolated-code-agent.js`

The Agent itself does not run a recurring shell timer. It calls the desktop Session registry for live identity evidence during health/preflight or post-capture identity verification. After P0-001, the production CodeManager no longer invokes Provider health on idle ticks, so these scans are event/diagnostic driven rather than an autonomous 10-second loop.

### startup friend import / Farm/Friend business loops

The startup friend importer polls persisted artifacts only and stops after import completion or its startup timeout. Farm/Friend schedulers operate inside Node and do not create recurring PowerShell processes.

## Regression

Added `core/scripts/qq-runtime-code-throttle-selftest.js`.

It verifies:

- a 4.5 second no-result wait performs only two clipboard fallback reads at the configured 2 second cadence;
- a valid clipboard Code is still returned when file output is absent;
- an available `_code.txt` artifact wins immediately without invoking the clipboard fallback.

## Result

P0-002 source audit found no second healthy-idle shell loop after P0-001. It did find excessive event-time PowerShell churn in the clipboard fallback, which is bounded by this branch.

Production deployment is intentionally separate from this source audit.
