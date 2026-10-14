$ErrorActionPreference = "Stop"

$workspace = "C:\Users\fksgm\Documents\Codex\2026-04-21-24-https-store-kyobobook-co-kr"
$serverScript = Join-Path $workspace "server.js"
$healthUrl = "http://127.0.0.1:3000/api/health"

# 이 스크립트의 한 가지 임무: 3000번 포트에 떠 있는 서버가 지금 코드로 돌게 한다.
#
# 돌고 있는 서버는 뜰 때 읽은 server.js 를 기억한 채로 계속 돈다. 그래서 코드를
# 고쳐도 그 서버만은 옛 내용으로 수집하고, 그 결과를 클라우드 저장소에 덮어쓴다.
# 공개 대시보드가 읽는 곳이 그 저장소라, 옛 서버 하나가 살아 있으면 배포가
# 멀쩡해도 화면이 조용히 옛날로 돌아간다. 실제로 그 일이 있었다 — 고정해 둔
# 주요 도서가 한 시간 뒤에 풀렸다.
#
# 예전에는 맨 앞에서 /api/health 를 3초 안에 받아 보고, 받아지면 그때만 기동
# 시각을 견줘 재시작했다. 그 확인은 클라우드 저장소까지 다녀오므로 3초를 자주
# 넘긴다. 넘기면 catch 로 빠져 재시작 단계를 통째로 건너뛰고, 그 아래에서 새
# 프로세스를 띄우지만 포트가 이미 잡혀 있어 그 새것이 죽는다. 옛 서버는 그대로
# 남고 스크립트는 0 을 내고 끝난다 — 고쳤다고 믿게 만드는 실패였다.
#
# 그래서 판단을 health 에 걸지 않는다. 포트를 잡고 있는 프로세스를 먼저 찾아
# 기동 시각만 본다. 서버가 응답하든 말든 상관없이 옛것이면 반드시 내린다.

function Get-ListenerProcessId {
  $line = netstat -ano -p tcp |
    Select-String -Pattern ":3000\s+.*LISTENING" |
    Select-Object -First 1

  if (-not $line) {
    return 0
  }

  return [int](($line.ToString().Trim() -split "\s+")[-1])
}

$serverUpdatedAt = (Get-Item $serverScript).LastWriteTime
$listenerProcessId = Get-ListenerProcessId

if ($listenerProcessId -gt 0) {
  $runningProcess = Get-Process -Id $listenerProcessId -ErrorAction SilentlyContinue

  # 기동 시각을 못 읽는 경우가 있다(권한·종료 직전). 그때는 "최신이다"라고
  # 봐주지 않는다 — 옛 서버를 살려 두는 쪽이 늘 더 비싸다.
  $startedAt = $null
  if ($runningProcess) {
    try { $startedAt = $runningProcess.StartTime } catch { $startedAt = $null }
  }

  if ($runningProcess -and $startedAt -and $startedAt -ge $serverUpdatedAt) {
    # 지금 코드로 돌고 있다. 건드리지 않는다.
    exit 0
  }

  if ($runningProcess) {
    try {
      Stop-Process -Id $listenerProcessId -Force
    } catch {
      Write-Output "3000번 포트를 쓰는 프로세스를 내리지 못했습니다: $($_.Exception.Message)"
      exit 1
    }

    # 포트가 실제로 풀릴 때까지 기다린다. 바로 띄우면 새 프로세스가
    # 포트 충돌로 조용히 죽고, 화면은 옛 서버가 없는 채로 멈춘다.
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if ((Get-ListenerProcessId) -eq 0) { break }
    }
  }
}

if ((Get-ListenerProcessId) -ne 0) {
  Write-Output "3000번 포트가 아직 잡혀 있습니다. 다시 실행해 주세요."
  exit 1
}

$node = (Get-Command node -ErrorAction Stop).Source

$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = $node
$processInfo.Arguments = "server.js"
$processInfo.WorkingDirectory = $workspace
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true

[System.Diagnostics.Process]::Start($processInfo) | Out-Null

# 뜨는 데 걸리는 시간은 그때그때 다르다. 한 번 보고 판정하지 않고 30초까지
# 기다린다 — 여기서 1 을 내면 사람이 "안 떴다"고 읽는데, 실은 늦게 뜬 것이다.
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 10
    if ($health.StatusCode -ge 200 -and $health.StatusCode -lt 400) {
      exit 0
    }
  } catch {
    # 아직 안 떴다. 다음 차례에 다시 본다.
  }
}

Write-Output "서버를 띄웠지만 30초 안에 응답하지 않았습니다."
exit 1
