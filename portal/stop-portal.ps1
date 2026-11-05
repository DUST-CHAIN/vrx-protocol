# Stop whatever is serving the VRX portal on :3011.
# Finds the process LISTENING on the port and stops just that one (and any child node it spawned) —
# it does NOT kill every node on the machine. Safe to run even if nothing is running.
$ErrorActionPreference = "SilentlyContinue"
$PORT = 3011

Write-Host "Looking for a process on port $PORT..." -ForegroundColor Cyan
$conns = Get-NetTCPConnection -LocalPort $PORT -State Listen
if (-not $conns) {
    Write-Host "Nothing is listening on :$PORT. Already stopped." -ForegroundColor Green
    return
}

$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $pids) {
    $p = Get-Process -Id $procId
    if ($p) {
        Write-Host ("Stopping {0} (PID {1})..." -f $p.ProcessName, $procId) -ForegroundColor Yellow
        # Kill the whole tree so `next dev`'s child workers go too.
        Stop-Process -Id $procId -Force
    }
}
Start-Sleep -Milliseconds 400

if (Get-NetTCPConnection -LocalPort $PORT -State Listen) {
    Write-Host "WARNING: something is still on :$PORT." -ForegroundColor Red
} else {
    Write-Host "Port $PORT is free." -ForegroundColor Green
}
