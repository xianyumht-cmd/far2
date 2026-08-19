param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$AccountName = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ([string]::IsNullOrWhiteSpace($AccountName)) {
    # Build the default Chinese display name from Unicode code points so future
    # cmd/console code-page differences cannot persist mojibake into accounts.json.
    $AccountName = [string]([char[]]@(0x5FAE, 0x4FE1, 0x519C, 0x573A))
}
