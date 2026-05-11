$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RepoRoot '.keypool-bg.pid'

if (-not (Test-Path $PidFile)) {
  Write-Host '未找到 PID 文件，KeyPool 可能未通过后台脚本启动'
  exit 0
}

$raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
$procId = 0
if (-not [int]::TryParse($raw, [ref]$procId)) {
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'PID 文件损坏，已清理'
  exit 0
}

try {
  Stop-Process -Id $procId -Force -ErrorAction Stop
  Start-Sleep -Seconds 2
  Write-Host "已停止 KeyPool，PID=$procId"
} catch {
  Write-Host "进程 PID=$procId 不存在或已退出"
}

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
