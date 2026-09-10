# Register the AgentHubRemote Scheduled Task.
# Run from a normal user PowerShell:
#   .\register-task.ps1
#
# Remove:
#   Unregister-ScheduledTask -TaskName AgentHubRemote -Confirm:$false

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSCommandPath
$wrapper = Join-Path $root 'ahr_wrapper.ps1'
$launcher = Join-Path $root 'run-wrapper-hidden.vbs'
if (-not (Test-Path $wrapper)) { throw "Missing wrapper: $wrapper" }
if (-not (Test-Path $launcher)) { throw "Missing launcher: $launcher" }

$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content -Encoding UTF8 $envFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
      $name = $matches[1]; $value = $matches[2] -replace '^["'']|["'']$',''
      if (-not (Test-Path "env:$name")) { Set-Item "env:$name" $value }
    }
  }
}

$taskName = if ($env:AHR_TASK_NAME) { $env:AHR_TASK_NAME } else { 'AgentHubRemote' }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument "`"$launcher`"" `
  -WorkingDirectory $root

$trigLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigPoll  = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 9999)

$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -Hidden `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName `
  -Action $action -Trigger @($trigLogon, $trigPoll) `
  -Settings $settings -Principal $principal -Force

Write-Host "Registered $taskName (At Logon + 5min watchdog + 12-hourly background restart + restart-on-failure)." -ForegroundColor Green
Write-Host "Start: Start-ScheduledTask -TaskName $taskName" -ForegroundColor Cyan
