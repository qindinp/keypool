# stop-keypool.ps1 — 一键停止 KeyPool
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RepoRoot '.keypool-bg.pid'

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

# 1. 尝试通过 PID 文件停止
$runningPid = Get-RunningPid
if ($runningPid) {
  Stop-Process -Id $runningPid -Force -ErrorAction SilentlyContinue
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "已停止 KeyPool (PID=$runningPid)"
  exit 0
}

# 2. PID 文件不存在或进程已退出，检查 9300 端口
$portProc = Get-NetTCPConnection -LocalPort 9300 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portProc) {
  Stop-Process -Id $portProc.OwningProcess -Force -ErrorAction SilentlyContinue
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "已停止占用 9300 端口的进程 (PID=$($portProc.OwningProcess))"
  exit 0
}

Remove-Item $PidFile -ErrorAction SilentlyContinue
Write-Host "KeyPool 未在运行"
exit 0
