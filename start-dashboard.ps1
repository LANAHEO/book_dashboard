$ErrorActionPreference = "Stop"

$workspace = "C:\Users\fksgm\Documents\Codex\2026-04-21-24-https-store-kyobobook-co-kr"
$serverScript = Join-Path $workspace "server.js"
$healthUrl = "http://127.0.0.1:3000/api/health"

try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
  if ($health.StatusCode -ge 200 -and $health.StatusCode -lt 400) {
    $listenerLine = netstat -ano -p tcp |
      Select-String -Pattern ":3000\s+.*LISTENING" |
      Select-Object -First 1

    if ($listenerLine) {
      $serverProcessId = [int](($listenerLine.ToString().Trim() -split "\s+")[-1])
      $runningProcess = Get-Process -Id $serverProcessId -ErrorAction SilentlyContinue
      $serverUpdatedAt = (Get-Item $serverScript).LastWriteTime

      if ($runningProcess -and $runningProcess.StartTime -ge $serverUpdatedAt) {
        exit 0
      }

      if ($runningProcess -and $runningProcess.ProcessName -eq "node") {
        Stop-Process -Id $serverProcessId -Force
        Start-Sleep -Seconds 1
      }
    }
  }
} catch {
  # If the local server is not reachable, we start it below.
}

$node = (Get-Command node -ErrorAction Stop).Source

$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = $node
$processInfo.Arguments = "server.js"
$processInfo.WorkingDirectory = $workspace
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true

[System.Diagnostics.Process]::Start($processInfo) | Out-Null

Start-Sleep -Seconds 4

try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5
  if ($health.StatusCode -ge 200 -and $health.StatusCode -lt 400) {
    exit 0
  }
} catch {
  exit 1
}
