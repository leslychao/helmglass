param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('dev')]
    [string] $EnvironmentName
)

$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'up.mjs') $EnvironmentName
exit $LASTEXITCODE
