param(
  [string]$BaseUrl = 'http://127.0.0.1:9300',
  [string]$Model = 'mimo-v2.5-pro',
  [int]$TimeoutSec = 30,
  [switch]$SkipChat
)

$ErrorActionPreference = 'Stop'

function Write-Step($Name) {
  Write-Host "\n=== $Name ===" -ForegroundColor Cyan
}

function Invoke-JsonGet($Path, [int]$Timeout = 5) {
  $url = "$BaseUrl$Path"
  Invoke-RestMethod -Method Get -Uri $url -TimeoutSec $Timeout
}

function Invoke-JsonPost($Path, $Body, [int]$Timeout = 30) {
  $url = "$BaseUrl$Path"
  $json = $Body | ConvertTo-Json -Depth 20
  Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json' -Body $json -TimeoutSec $Timeout
}

$results = [ordered]@{
  baseUrl = $BaseUrl
  model = $Model
  startedAt = (Get-Date).ToString('o')
  checks = @()
}

function Add-Check($Name, $Ok, $Details) {
  $script:results.checks += [ordered]@{
    name = $Name
    ok = [bool]$Ok
    details = $Details
  }
}

try {
  Write-Step 'Port 9300 listener'
  $baseUri = [Uri]$BaseUrl
  $port = $baseUri.Port
  $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listen) {
    $owner = $listen.OwningProcess
    Write-Host "LISTEN port=$port pid=$owner"
    Add-Check 'port-listener' $true @{ port = $port; pid = $owner }
  } else {
    Write-Host "NO LISTENER port=$port" -ForegroundColor Yellow
    Add-Check 'port-listener' $false @{ port = $port }
  }

  Write-Step 'GET /health'
  $health = Invoke-JsonGet '/health' 5
  $health | ConvertTo-Json -Depth 10
  Add-Check 'health' ($health.status -eq 'ok') $health

  Write-Step 'GET /v1/models'
  $models = Invoke-JsonGet '/v1/models' 5
  $modelCount = @($models.data).Count
  Write-Host "models=$modelCount"
  $models.data | Select-Object -First 20 | ConvertTo-Json -Depth 10
  Add-Check 'models' ($modelCount -gt 0) @{ count = $modelCount; ids = @($models.data | ForEach-Object { $_.id }) }

  if (-not $SkipChat) {
    Write-Step 'POST /v1/chat/completions non-stream'
    $chatBody = @{
      model = $Model
      messages = @(@{ role = 'user'; content = 'keypool smoke ping' })
      stream = $false
      max_tokens = 32
    }
    $chat = Invoke-JsonPost '/v1/chat/completions' $chatBody $TimeoutSec
    $choice = @($chat.choices)[0]
    $hasResponse = $null -ne $choice
    $summary = [ordered]@{
      id = $chat.id
      model = $chat.model
      finish_reason = $choice.finish_reason
      has_content = [bool]$choice.message.content
      has_reasoning_content = [bool]$choice.message.reasoning_content
      usage = $chat.usage
    }
    $summary | ConvertTo-Json -Depth 10
    Add-Check 'openai-chat-non-stream' $hasResponse $summary

    Write-Step 'POST /v1/messages non-stream'
    $anthropicBody = @{
      model = $Model
      max_tokens = 32
      messages = @(@{ role = 'user'; content = 'keypool anthropic smoke ping' })
      stream = $false
    }
    try {
      $anthropic = Invoke-JsonPost '/v1/messages' $anthropicBody $TimeoutSec
      $anthropicSummary = [ordered]@{
        id = $anthropic.id
        type = $anthropic.type
        role = $anthropic.role
        stop_reason = $anthropic.stop_reason
        content_count = @($anthropic.content).Count
      }
      $anthropicSummary | ConvertTo-Json -Depth 10
      Add-Check 'anthropic-messages-non-stream' $true $anthropicSummary
    } catch {
      $message = $_.Exception.Message
      Write-Host "Anthropic non-stream failed: $message" -ForegroundColor Yellow
      Add-Check 'anthropic-messages-non-stream' $false @{ error = $message; body = $_.ErrorDetails.Message }
    }
  }

  $failed = @($results.checks | Where-Object { -not $_.ok })
  Write-Step 'Summary'
  $results.finishedAt = (Get-Date).ToString('o')
  $results.ok = ($failed.Count -eq 0)
  $results | ConvertTo-Json -Depth 20

  if ($failed.Count -gt 0) {
    exit 1
  }
  exit 0
} catch {
  Write-Step 'Fatal error'
  Write-Host $_.Exception.Message -ForegroundColor Red
  $results.finishedAt = (Get-Date).ToString('o')
  $results.ok = $false
  $results.error = $_.Exception.Message
  $results | ConvertTo-Json -Depth 20
  exit 1
}
