$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $projectRoot "launch-app.ps1"

if (-not (Test-Path $launcher)) {
  Write-Error "Missing launch-app.ps1"
  exit 1
}

powershell -ExecutionPolicy Bypass -File $launcher -ForceRestart
