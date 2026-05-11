$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RepoRoot '.keypool-bg.pid'
$OutLog = Join-Path $RepoRoot '.keypool-bg.out.log'
$ErrLog = Join-Path $RepoRoot '.keypool-bg.err.log'
$HealthUrl = 'http://127.0.0.1:9300/health'

$pidValue = $null
$procAlive = $false

if (Test-Path $PidFile) {
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed)) {
    $pidValue = $parsed
    try {
      Get-Process -Id $pidValue -ErrorAction Stop | Out-Null
      $procAlive = $true
    } catch {}
  }
}

$listen = Get-NetTCPConnection -LocalPort 9300 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$health = $null
try {
  $health = (Invoke-WebRequest -UseBasicParsing $HealthUrl -TimeoutSec 3).Content
} catch {
  $health = $_.Exception.Message
}

[pscustomobject]@{
  pidFile = $PidFile
  pid = $pidValue
  processAlive = $procAlive
  port9300Listening = [bool]$listen
  port9300Owner = if ($listen) { $listen.OwningProcess } else { $null }
  health = $health
  outLog = $OutLog
  errLog = $ErrLog
} | ConvertTo-Json -Depth 3
