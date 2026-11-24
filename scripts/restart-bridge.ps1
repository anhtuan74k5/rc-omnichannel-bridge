# Restart the bridge cleanly: stop whatever listens on the bridge port, then start
# ONE new instance in the background and wait until /health answers.
#   powershell -File scripts\restart-bridge.ps1
# Log files: %TEMP%\bridge.log (stdout) and %TEMP%\bridge.err (stderr).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 3001
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
  if ($line) { $port = [int](($line -split '=', 2)[1].Trim()) }
}

# Stop old instances: the listener and any `npm run dev` / `node --watch` wrappers.
$ids = @((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'npm-cli.js" run dev|--watch index.js' } |
  ForEach-Object { $ids += $_.ProcessId }
$ids | Where-Object { $_ } | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$out = Join-Path $env:TEMP 'bridge.log'
$err = Join-Path $env:TEMP 'bridge.err'
Remove-Item $out, $err -ErrorAction SilentlyContinue
Start-Process -FilePath 'node' -ArgumentList 'index.js' -WorkingDirectory $root `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod "http://localhost:$port/health" -TimeoutSec 2
    "Bridge is up on port $port (active rooms: $($health.activeRooms))."
    exit 0
  } catch { }
}
"Bridge did not answer on port $port; see $err"
Get-Content $err -Tail 10 -ErrorAction SilentlyContinue
exit 1
