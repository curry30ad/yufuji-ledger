$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs = Join-Path $projectRoot "server.js"
$logOut = Join-Path $projectRoot "server.log"
$logErr = Join-Path $projectRoot "server-error.log"
$url = "http://127.0.0.1:3000"

function Test-AppHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-AppHealth)) {
  Start-Process -FilePath "node" `
    -ArgumentList "`"$serverJs`"" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr | Out-Null

  Start-Sleep -Seconds 2
}

Start-Process $url
