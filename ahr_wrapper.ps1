# agent-hub-remote supervisor wrapper.
# Launched by the AgentHubRemote Scheduled Task registered by register-task.ps1.

Set-Location (Split-Path $PSCommandPath)
$ErrorActionPreference = 'Continue'

$envFile = Join-Path (Get-Location) '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content -Encoding UTF8 $envFile) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
      $name = $matches[1]; $value = $matches[2] -replace '^["'']|["'']$',''
      if (-not (Test-Path "env:$name")) { Set-Item "env:$name" $value }
    }
  }
}

if (-not $env:AHR_HTTP_PORT) {
  if ($env:AHR_PORT) {
    $env:AHR_HTTP_PORT = $env:AHR_PORT
  } else {
    $env:AHR_HTTP_PORT = '3334'
  }
}

$restartAfter = New-TimeSpan -Hours 12
$restartDelay = New-TimeSpan -Seconds 5
# Graceful recycle: when maxRuntime is reached, only restart once no session is
# running/starting. Re-check on this interval; force the restart if still busy
# after the cap so a stuck session can't defer the recycle forever.
$graceCheckInterval = New-TimeSpan -Seconds 60
$graceMaxDefer = New-TimeSpan -Hours 2
$logPath = Join-Path (Get-Location) 'ahr.log'
$deathLogPath = Join-Path (Get-Location) 'ahr_wrapper.death.log'
$script:activeNodeProcessId = $null

function Write-AhrLog {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Message
  )
  Add-Content -Path $Path -Value $Message -Encoding UTF8
}

function Get-AhrActiveSessionCount {
  # Returns the number of sessions currently running/starting via the server's
  # loopback supervisor endpoint. Returns -1 if the server is unreachable, which
  # the caller treats as "recycle now" (an unresponsive server should be killed).
  $port = $env:AHR_HTTP_PORT
  try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/supervisor/active-sessions" -TimeoutSec 5 -ErrorAction Stop
    return [int]$resp.activeCount
  } catch {
    return -1
  }
}

function Stop-ProcessTree {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }

  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    $process.WaitForExit(10000) | Out-Null
  } catch {
    # Process may already be gone.
  }
}

function Start-AhrServerProcess {
  param([Parameter(Mandatory = $true)][string]$LogPath)

  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodePath
  $startInfo.Arguments = 'server.js'
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo

  $stdoutEvent = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData $LogPath -Action {
    if ($null -ne $EventArgs.Data) {
      Add-Content -Path $Event.MessageData -Value $EventArgs.Data -Encoding UTF8
    }
  }
  $stderrEvent = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData $LogPath -Action {
    if ($null -ne $EventArgs.Data) {
      Add-Content -Path $Event.MessageData -Value $EventArgs.Data -Encoding UTF8
    }
  }

  try {
    if (-not $process.Start()) {
      throw 'node process did not start'
    }
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
  } catch {
    foreach ($subscription in @($stdoutEvent, $stderrEvent)) {
      if ($null -ne $subscription) {
        Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
        Remove-Job -Id $subscription.Id -Force -ErrorAction SilentlyContinue
      }
    }
    $process.Dispose()
    throw
  }

  [PSCustomObject]@{
    Process = $process
    Events = @($stdoutEvent, $stderrEvent)
  }
}

function Stop-EventSubscriptions {
  param([object[]]$Subscriptions)

  foreach ($subscription in $Subscriptions) {
    if ($null -eq $subscription) { continue }
    Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
    Remove-Job -Id $subscription.Id -Force -ErrorAction SilentlyContinue
  }
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\AgentHubRemoteWrapper', [ref]$createdNew)
if (-not $createdNew) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-AhrLog -Path $deathLogPath -Message "[$ts] DUPLICATE_EXIT pid=$PID host=$env:COMPUTERNAME"
  exit 0
}

trap {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-AhrLog -Path $deathLogPath -Message "[$ts] TRAP pid=$PID msg=$($_.Exception.Message)"
  Start-Sleep -Seconds 5
  exit 1
}

Register-EngineEvent PowerShell.Exiting -Action {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path 'ahr_wrapper.death.log' -Value "[$ts] EXITING pid=$PID" -Encoding UTF8
  if ($null -ne $script:activeNodeProcessId) {
    Add-Content -Path 'ahr_wrapper.death.log' -Value "[$ts] EXITING_STOP_TREE nodePid=$script:activeNodeProcessId" -Encoding UTF8
    function Stop-TreeOnExit {
      param([Parameter(Mandatory = $true)][int]$TargetProcessId)

      $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetProcessId" -ErrorAction SilentlyContinue)
      foreach ($child in $children) {
        Stop-TreeOnExit -TargetProcessId ([int]$child.ProcessId)
      }

      Stop-Process -Id $TargetProcessId -Force -ErrorAction SilentlyContinue
    }
    Stop-TreeOnExit -TargetProcessId ([int]$script:activeNodeProcessId)
  }
} | Out-Null

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-AhrLog -Path $deathLogPath -Message "[$ts] WRAPPER_START pid=$PID host=$env:COMPUTERNAME restartAfter=$($restartAfter.ToString()) hiddenNode=true"

while ($true) {
  $run = $null
  $reason = 'unknown'
  $exitCode = 'unknown'

  try {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-AhrLog -Path $logPath -Message "`n[$ts] === agent-hub-remote starting maxRuntime=$($restartAfter.ToString()) hiddenNode=true ==="

    $run = Start-AhrServerProcess -LogPath $logPath
    $nodeProcessId = [int]$run.Process.Id
    $script:activeNodeProcessId = $nodeProcessId

    $tsStarted = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-AhrLog -Path $logPath -Message "[$tsStarted] === node started pid=$nodeProcessId ==="

    $exited = $run.Process.WaitForExit([int]$restartAfter.TotalMilliseconds)
    if ($exited) {
      $run.Process.WaitForExit()
      $reason = 'process-exit'
      $exitCode = $run.Process.ExitCode
    } else {
      # maxRuntime reached, process still alive. Graceful recycle: defer the
      # restart while any session is running/starting; bail early if the process
      # exits on its own; force the restart only after the grace cap.
      $deferStart = Get-Date
      while ($true) {
        if ($run.Process.HasExited) {
          $reason = 'process-exit'
          $exitCode = $run.Process.ExitCode
          break
        }
        $activeCount = Get-AhrActiveSessionCount
        $deferred = (Get-Date) - $deferStart

        if ($activeCount -eq 0) {
          $reason = 'graceful-restart'
          break
        }
        if ($activeCount -lt 0) {
          $reason = 'graceful-restart-unreachable'
          break
        }
        if ($deferred -ge $graceMaxDefer) {
          $reason = 'graceful-restart-forced'
          $tsForce = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
          Write-AhrLog -Path $logPath -Message "[$tsForce] === graceful defer cap $($graceMaxDefer.ToString()) reached with $activeCount active session(s); forcing restart ==="
          break
        }

        $tsDefer = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Write-AhrLog -Path $logPath -Message "[$tsDefer] === restart deferred: $activeCount active session(s); re-checking in $([int]$graceCheckInterval.TotalSeconds)s (deferred $([int]$deferred.TotalMinutes)m) ==="
        # Wait the grace interval, but wake immediately if the process exits.
        if ($run.Process.WaitForExit([int]$graceCheckInterval.TotalMilliseconds)) {
          $reason = 'process-exit'
          $exitCode = $run.Process.ExitCode
          break
        }
      }

      if ($reason -like 'graceful-restart*') {
        $tsTimeout = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Write-AhrLog -Path $logPath -Message "[$tsTimeout] === $reason pid=$nodeProcessId; stopping process tree ==="
        Stop-ProcessTree -ProcessId $nodeProcessId
        $run.Process.WaitForExit(10000) | Out-Null
        if ($run.Process.HasExited) {
          $exitCode = $run.Process.ExitCode
        } else {
          $exitCode = 'not-exited'
        }
      }
    }
  } catch {
    $reason = 'wrapper-error'
    $exitCode = 'exception'
    $tsError = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-AhrLog -Path $deathLogPath -Message "[$tsError] WRAPPER_ERROR pid=$PID msg=$($_.Exception.Message)"
  } finally {
    if ($null -ne $run) {
      if ($script:activeNodeProcessId -eq [int]$run.Process.Id) {
        $script:activeNodeProcessId = $null
      }
      Stop-EventSubscriptions -Subscriptions $run.Events
      $run.Process.Dispose()
    }
  }

  $ts2 = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-AhrLog -Path $logPath -Message "[$ts2] === server stopped reason=$reason code=$exitCode, restarting in $([int]$restartDelay.TotalSeconds)s ==="
  Start-Sleep -Seconds ([int]$restartDelay.TotalSeconds)
}
