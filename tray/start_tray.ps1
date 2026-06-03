# start_tray.ps1 — install deps if missing, then launch tray icon hidden.
# Run once: .\start_tray.ps1
# For auto-start at logon: see comment below.

$script = Join-Path $PSScriptRoot "usage_tray.py"

# Check / install pystray + pillow
$missing = @()
python -c "import pystray" 2>$null; if (-not $?) { $missing += "pystray" }
python -c "import PIL"     2>$null; if (-not $?) { $missing += "pillow"  }

if ($missing.Count -gt 0) {
    Write-Host "Installing: $($missing -join ', ')"
    python -m pip install @missing --quiet
}

# Kill existing tray process if running. Get-Process does not expose
# CommandLine reliably on Windows PowerShell, so use CIM for the filter.
Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -match '^(python|pythonw)\.exe$' -and
        $_.CommandLine -like "*usage_tray.py*"
    } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

# Launch hidden (no console window). pythonw.exe is the console-less interpreter;
# python.exe + -WindowStyle Hidden can still flash a console briefly at start.
$proc = Start-Process pythonw -ArgumentList "`"$script`"" `
    -WindowStyle Hidden -PassThru
Write-Host "Usage tray started (PID $($proc.Id))"

# ── auto-start at logon ──────────────────────────────────────────────────────
# Already registered via HKCU Run key (no admin required):
#   HKCU:\Software\Microsoft\Windows\CurrentVersion\Run  "AHR-UsageTray"
#
# To remove auto-start:
#   Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
#     -Name "AHR-UsageTray"
