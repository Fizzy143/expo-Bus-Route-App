$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot

Set-Location $projectRoot

$env:CI = "1"
$env:EXPO_NO_TELEMETRY = "1"
$env:HOME = $projectRoot
$env:USERPROFILE = $projectRoot

npm run web:local
