param(
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RepoRoot '.keypool-bg.pid'
$OutLog = Join-Path $RepoRoot '.keypool-bg.out.log'
$ErrLog = Join-Path $RepoRoot '.keypool-bg.err.log'
$NodeExe = 'node'
$AppPath = Join-Path $RepoRoot 'bin\app.mjs'
$HealthUrl = 'http://127.0.0.1:9300/health'

function Test-KeyPoolHealthy {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing $HealthUrl -TimeoutSec 3
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Get-RunningPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $raw) { return $null }
  $procId = 0
  if (-not [int]::TryParse($raw, [ref]$procId)) { return $null }
  try {
    $proc = Get-Process -Id $procId -ErrorAction Stop
    return $proc.Id
  } catch {
    return $null
  }
}

$runningPid = Get-RunningPid
if ($runningPid -and -not $ForceRestart) {
  Write-Host "KeyPool 已在后台运行，PID=$runningPid"
  exit 0
}

if ($runningPid -and $ForceRestart) {
  Stop-Process -Id $runningPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

$existing9300 = Get-NetTCPConnection -LocalPort 9300 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing9300 -and -not $ForceRestart) {
  Write-Host "9300 已被 PID=$($existing9300.OwningProcess) 占用；如确认是旧 KeyPool，可带 -ForceRestart 重启"
  exit 1
}

if ($existing9300 -and $ForceRestart) {
  Stop-Process -Id $existing9300.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

if (-not (Test-Path $OutLog)) { New-Item -ItemType File -Path $OutLog -Force | Out-Null }
if (-not (Test-Path $ErrLog)) { New-Item -ItemType File -Path $ErrLog -Force | Out-Null }

$proc = Start-Process -FilePath $NodeExe -ArgumentList @($AppPath) -WorkingDirectory $RepoRoot -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru -WindowStyle Hidden
Set-Content -Path $PidFile -Value $proc.Id

Start-Sleep -Seconds 4

if (Test-KeyPoolHealthy) {
  Write-Host "KeyPool 后台启动成功，PID=$($proc.Id)"
  Write-Host "Health: $HealthUrl"
  exit 0
}

Write-Host "KeyPool 已启动进程，PID=$($proc.Id)，但 health 尚未就绪"
Write-Host "OUT: $OutLog"
Write-Host "ERR: $ErrLog"
exit 0
