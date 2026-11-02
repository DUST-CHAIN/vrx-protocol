# Start (or restart) the VRX portal dev server cleanly on :3011.
# 1) frees the port (stops any old server), 2) clears the .next cache (kills the known
#    "chunks 404 / dead inputs" corruption trap), 3) starts `npm run dev`.
# Double-click START-PORTAL.cmd to run this; the window stays open showing the dev log.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$PORT = 3011

# --- 1. free the port -----------------------------------------------------------------
$conns = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p) {
            Write-Host ("Stopping old server {0} (PID {1})..." -f $p.ProcessName, $procId) -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 500
}

# --- 2. clear the .next cache ---------------------------------------------------------
if (Test-Path ".next") {
    Write-Host "Clearing .next cache..." -ForegroundColor Cyan
    Remove-Item -Recurse -Force ".next" -ErrorAction SilentlyContinue
}

# --- 3. start dev ---------------------------------------------------------------------
Write-Host "Starting VRX portal on http://localhost:$PORT ..." -ForegroundColor Green
Write-Host "(leave this window open; close it or press Ctrl+C to stop the server)" -ForegroundColor DarkGray
npm run dev
