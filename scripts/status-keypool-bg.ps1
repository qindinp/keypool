$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RepoRoot '.keypool-bg.pid'
$OutLog = Join-Path $RepoRoot '.keypool-bg.out.log'
$ErrLog = Join-Path $RepoRoot '.keypool-bg.err.log'
$HealthUrl = 'http://127.0.0.1:9300/health'

function Get-ProcessCommandLine($ProcessId) {
  if (-not $ProcessId) { return $null }
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return $p.CommandLine
  } catch {
    return $null
  }
}

$pidValue = $null
$procAlive = $false
$pidCommandLine = $null

if (Test-Path $PidFile) {
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed)) {
    $pidValue = $parsed
    try {
      Get-Process -Id $pidValue -ErrorAction Stop | Out-Null
      $procAlive = $true
      $pidCommandLine = Get-ProcessCommandLine $pidValue
    } catch {}
  }
}

$listen = Get-NetTCPConnection -LocalPort 9300 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$portOwner = if ($listen) { [int]$listen.OwningProcess } else { $null }
$portOwnerCommandLine = Get-ProcessCommandLine $portOwner

$health = $null
try {
  $health = (Invoke-WebRequest -UseBasicParsing $HealthUrl -TimeoutSec 3).Content
} catch {
  $health = $_.Exception.Message
}

$stalePidFile = $false
if ($pidValue -and $portOwner -and $pidValue -ne $portOwner) {
  $stalePidFile = $true
} elseif ($pidValue -and -not $procAlive) {
  $stalePidFile = $true
}

$recommendation = $null
if ($stalePidFile -and $portOwner) {
  $recommendation = "PID file is stale. Port 9300 is owned by PID $portOwner. Consider refreshing .keypool-bg.pid or restarting with scripts/start-keypool-bg.ps1 -ForceRestart."
} elseif ($stalePidFile) {
  $recommendation = "PID file is stale and port 9300 is not listening. Consider removing .keypool-bg.pid and starting KeyPool."
} elseif (-not $portOwner) {
  $recommendation = "Port 9300 is not listening. KeyPool appears stopped."
} else {
  $recommendation = "KeyPool listener detected on port 9300."
}

[pscustomobject]@{
  pidFile = $PidFile
  pid = $pidValue
  processAlive = $procAlive
  pidCommandLine = $pidCommandLine
  port9300Listening = [bool]$listen
  port9300Owner = $portOwner
  port9300OwnerCommandLine = $portOwnerCommandLine
  authoritativePid = $portOwner
  stalePidFile = $stalePidFile
  health = $health
  recommendation = $recommendation
  outLog = $OutLog
  errLog = $ErrLog
} | ConvertTo-Json -Depth 4
