# Claude Code Control Panel - stops the running server on 127.0.0.1:8787 (language-independent:
# parses the netstat listening line for the owning PID, works on German Windows too).
$ErrorActionPreference = 'SilentlyContinue'
$port = 8787
$serverPids = @()
(netstat -ano) | ForEach-Object {
  if ($_ -match "127\.0\.0\.1:$port\s+0\.0\.0\.0:0\s+\S+\s+(\d+)") { $serverPids += $Matches[1] }
}
$serverPids = $serverPids | Sort-Object -Unique
if (-not $serverPids) { Write-Host "Kein Control Panel auf 127.0.0.1:$port aktiv."; Start-Sleep 2; exit 0 }
foreach ($processId in $serverPids) { Write-Host "Beende Server (PID $processId)..."; taskkill /PID $processId /T /F 2>&1 | Out-Null }
Write-Host 'Control Panel gestoppt.'
Start-Sleep 2
