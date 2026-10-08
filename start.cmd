@echo off
rem Claude Code Control Panel - startet den Server fensterlos im Hintergrund + oeffnet den Browser.
rem Idempotent: laeuft er schon, wird nur der Browser geoeffnet. Stoppen: stop.cmd
rem Die geoeffnete URL traegt das API-Token (?t=...) aus %LOCALAPPDATA%\claude-code-ui\api-token -
rem ohne Token antwortet jeder /api/-Aufruf mit 401. Dieser Weg ist daher der normale Start.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
