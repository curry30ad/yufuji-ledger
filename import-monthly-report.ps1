param(
  [string]$ReportPath
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dbPath = Join-Path $projectRoot "data\ledger.sqlite"
$scriptPath = Join-Path $projectRoot "scripts\import-monthly-report.js"
$backupDir = Join-Path $projectRoot "backup"
$archiveRoot = Join-Path $projectRoot "archive\reports"
$serverJs = Join-Path $projectRoot "server.js"
$logOut = Join-Path $projectRoot "server.log"
$logErr = Join-Path $projectRoot "server-error.log"
$url = "http://127.0.0.1:3000"

function Show-Info($message, $title = "Yufuji") {
  [System.Windows.Forms.MessageBox]::Show($message, $title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}

function Show-Error($message, $title = "Yufuji") {
  [System.Windows.Forms.MessageBox]::Show($message, $title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}

function Stop-AppServer {
  $nodeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
  foreach ($proc in $nodeProcesses) {
    if ($proc.CommandLine -and $proc.CommandLine.Contains($serverJs)) {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-AppServer {
  Start-Process -FilePath "node" `
    -ArgumentList "`"$serverJs`"" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr | Out-Null
}

function Select-ReportFile {
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = "Select monthly report"
  $dialog.Filter = "Excel files (*.xlsx)|*.xlsx"
  $dialog.InitialDirectory = [Environment]::GetFolderPath("UserProfile") + "\Downloads"
  $dialog.Multiselect = $false
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    return $null
  }
  return $dialog.FileName
}

function Resolve-ReportPath($candidatePath) {
  if ($candidatePath -and (Test-Path -LiteralPath $candidatePath)) {
    return $candidatePath
  }
  return Select-ReportFile
}

try {
  if (-not (Test-Path $dbPath)) {
    throw "Database file not found: $dbPath"
  }
  if (-not (Test-Path $scriptPath)) {
    throw "Import script not found: $scriptPath"
  }

  $ReportPath = Resolve-ReportPath $ReportPath
  if (-not $ReportPath) {
    exit 0
  }
  if (-not (Test-Path -LiteralPath $ReportPath)) {
    throw "Report file not found: $ReportPath"
  }

  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null

  Stop-AppServer

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = Join-Path $backupDir ("ledger-before-monthly-import-" + $timestamp + ".sqlite")
  Copy-Item -LiteralPath $dbPath -Destination $backupPath -Force

  $resultJson = & node $scriptPath $ReportPath $dbPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($resultJson | Out-String).Trim()
  }

  $result = ($resultJson | Out-String | ConvertFrom-Json)
  $monthLabel = [string]$result.months[0]
  $archiveYearDir = Join-Path $archiveRoot $monthLabel.Substring(0, 4)
  New-Item -ItemType Directory -Force -Path $archiveYearDir | Out-Null
  $archivePath = Join-Path $archiveYearDir ([System.IO.Path]::GetFileName($ReportPath))
  Copy-Item -LiteralPath $ReportPath -Destination $archivePath -Force

  Start-AppServer
  Start-Sleep -Seconds 2
  Start-Process $url

  $storesText = ($result.stores -join ", ")
  $message = @"
Import complete.

Month: $monthLabel
Store: $storesText
Days imported: $($result.importedRows)
Sales total: $($result.totalSales)
Actual received: $($result.totalActualReceived)
Expense total: $($result.totalExpense)

Database backup:
$backupPath

Archived report:
$archivePath
"@
  Show-Info $message "Monthly report imported"
} catch {
  Start-AppServer
  $errorMessage = $_.Exception.Message
  if (-not $errorMessage) {
    $errorMessage = $_ | Out-String
  }
  Show-Error $errorMessage "Monthly report import failed"
  exit 1
}
