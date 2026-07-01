$ForceRestart = $false
if ($args -contains "-ForceRestart") {
  $ForceRestart = $true
}

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

function Test-AppCompatibility {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$url/api/purchase-products" -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 401) {
      return $true
    }
    return $false
  }
}

function Stop-AppProcesses {
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "server.js" } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      } catch {
      }
    }
}

if ($ForceRestart) {
  Stop-AppProcesses
  Start-Sleep -Milliseconds 800
}

if ((Test-AppHealth) -and (-not (Test-AppCompatibility))) {
  Stop-AppProcesses
  Start-Sleep -Milliseconds 800
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
