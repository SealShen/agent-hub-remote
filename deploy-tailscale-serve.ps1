$ErrorActionPreference = 'Stop'

$root = Split-Path $PSCommandPath
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
      $name = $matches[1]; $value = $matches[2] -replace '^["'']|["'']$',''
      if (-not (Test-Path "env:$name")) { Set-Item "env:$name" $value }
    }
  }
}

$httpPort = if ($env:AHR_HTTP_PORT) { $env:AHR_HTTP_PORT } elseif ($env:AHR_PORT) { $env:AHR_PORT } else { '3334' }
$tcpPort  = if ($env:AHR_TCP_PORT)  { $env:AHR_TCP_PORT }  else { '3335' }
$tailnetDomain   = if ($env:AHR_TAILNET_DOMAIN)   { $env:AHR_TAILNET_DOMAIN }   else { 'your-tailnet.ts.net' }
$tailnetHostname = if ($env:AHR_TAILNET_HOSTNAME) { $env:AHR_TAILNET_HOSTNAME } else { 'your-hostname' }
$tailnetIp       = if ($env:AHR_TAILNET_IP)       { $env:AHR_TAILNET_IP }       else { '100.x.x.x' }

$target = "http://127.0.0.1:$httpPort"
$tcpTarget = "tcp://127.0.0.1:$httpPort"

function Invoke-Tailscale {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
  & tailscale @Rest
  if ($LASTEXITCODE -ne 0) {
    throw "tailscale $($Rest -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Stop-ForegroundServeTcp {
  param([Parameter(Mandatory = $true)][string]$Port)

  $statusRaw = & tailscale serve status --json 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($statusRaw)) { return }

  $status = $statusRaw | ConvertFrom-Json
  if (-not $status.Foreground) { return }

  $hasForeground = $false
  foreach ($prop in $status.Foreground.PSObject.Properties) {
    $tcp = $prop.Value.TCP
    if ($tcp -and $tcp.PSObject.Properties.Name -contains $Port) {
      $hasForeground = $true
      break
    }
  }
  if (-not $hasForeground) { return }

  Get-CimInstance Win32_Process -Filter "name='tailscale.exe'" |
    Where-Object { $_.CommandLine -match 'serve\s' -and $_.CommandLine -match "--tcp=$Port" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

  Start-Sleep -Seconds 2
}

Write-Host 'Configuring AHR Tailscale Serve entries...' -ForegroundColor Cyan
Stop-ForegroundServeTcp -Port $tcpPort

Invoke-Tailscale serve --bg $target
Invoke-Tailscale serve "--http=$httpPort" --bg $target
Invoke-Tailscale serve "--tcp=$tcpPort" --bg $tcpTarget

Write-Host ''
Invoke-Tailscale serve status
Write-Host ''
Write-Host "Primary iOS fallback URL: http://${tailnetIp}:${tcpPort}/" -ForegroundColor Green
Write-Host "MagicDNS HTTP URL:       http://${tailnetHostname}:${httpPort}/" -ForegroundColor Green
Write-Host "Tailnet HTTPS URL:      https://${tailnetHostname}.${tailnetDomain}/" -ForegroundColor Green
