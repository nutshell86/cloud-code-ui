# Claude Code Control Panel - idempotent, windowless launcher.
# Starts the server DETACHED via WMI (no console window; survives closing this launcher) and opens
# the browser. If it is already running, it just opens the browser. Stop it with stop.cmd / stop.ps1.
#
# N9: the browser is opened with the API token in the URL (http://127.0.0.1:8787/?t=<token>). The server
# creates that token on its first start and keeps it - this script only READS the file, it never generates
# one, so there is exactly one place the token comes from (lib/core.js ensureApiToken). Order matters: the
# server writes the file before it listens, so by the time Test-Up answers $true the file is there. If it
# is not (the start timed out), the bare URL is opened and the panel shows its own "Zugangstoken fehlt"
# screen instead of a silent wall of 401s.
$ErrorActionPreference = 'SilentlyContinue'
Set-Location $PSScriptRoot
$port = 8787
# One per-user directory for both files the panel keeps outside its checkout: the log and the token.
# (Must stay in step with USER_STATE_DIR / API_TOKEN_FILE in lib/paths.js.)
$dataDir = Join-Path $env:LOCALAPPDATA 'claude-code-ui'
$tokenFile = Join-Path $dataDir 'api-token'
function Test-Up { param($p) try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); $true } catch { $false } }

if (Test-Up $port) {
  Write-Host "Control Panel laeuft bereits auf http://127.0.0.1:$port"
} else {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Host 'FEHLER: node.exe nicht im PATH gefunden. Bitte Node.js installieren / PATH pruefen.'; Start-Sleep 3; exit 1 }
  Write-Host 'Starte Control Panel (fensterlos, im Hintergrund)...'
  # WMI Win32_Process.Create detaches the server (survives closing this launcher), but gives it NO console,
  # so node's stdout/stderr (banner + any crash trace) would hit an invalid handle and be lost. Wrap it in
  # cmd so output is redirected to a logfile - diagnosable, and no invalid-handle writes. cmd /c stays alive
  # until node exits; both run detached under WmiPrvSE.
  if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force $dataDir | Out-Null }
  $logFile = Join-Path $dataDir 'server.log'
  $cmdline = 'cmd.exe /c ""{0}" server.js > "{1}" 2>&1"' -f $node, $logFile
  Write-Host "  (Log: $logFile)"
  [void] ([wmiclass]'Win32_Process').Create($cmdline, $PSScriptRoot)
  for ($i = 0; $i -lt 30 -and -not (Test-Up $port); $i++) { Start-Sleep -Milliseconds 500 }
  if (Test-Up $port) { Write-Host "Laeuft: http://127.0.0.1:$port" }
  else { Write-Host 'Start dauert noch - bitte kurz warten und den Browser neu laden.' }
}
$token = ''
if (Test-Path $tokenFile) { $token = (Get-Content -Raw -LiteralPath $tokenFile).Trim() }
if ($token) {
  Start-Process "http://127.0.0.1:$port/?t=$token"
} else {
  Write-Host "Hinweis: keine Token-Datei gefunden ($tokenFile) - das Panel zeigt den Hinweisbildschirm."
  Start-Process "http://127.0.0.1:$port"
}
