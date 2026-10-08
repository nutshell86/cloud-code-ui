@echo off
rem Claude Code Control Panel - stoppt den laufenden Server (127.0.0.1:8787).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
