# FR3GB Code Supervisor account scope

A machine can retain several saved accounts even if only one is currently
intended for automatic recovery. Don't delete the other accounts.

Set `FAR2_CODE_SUPERVISOR_UINS` in the local launcher environment:

```powershell
$env:FAR2_CODE_SUPERVISOR_UINS = '<active-QQ-UIN>'
node tools/code-supervisor.js --once
```

When unset, all saved QQ accounts are monitored (historical behavior).
When set, only the listed numeric UINs are monitored (comma, semicolon, or space
separated). Explicit empty or invalid values fail closed with zero refreshes.
Other platforms are never monitored.

The presently running supervisor may still point at
`D:\project2\far2\tools\code-supervisor.js` rather than the new
`D:\project2\fr3gb\tools\code-supervisor.js`. Updating the environment alone
will not change that old code. Verify the new script with `--once`, stop the
old supervisor, then update the local launch chain and start exactly one
supervisor process. The Farm server does not need restarting.
