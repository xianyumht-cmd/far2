@echo off
setlocal
set "FAR2_ADMIN_PASS=Far2Local-Admin-2026"
set "FAR2_BASE=http://127.0.0.1:3007"
"D:\project2\far2\.toolchain\node20\node.exe" "D:\project2\far2\tools\code-supervisor.js" --interval 30 >> "D:\project2\far2\data\code-supervisor.log" 2>&1
endlocal
