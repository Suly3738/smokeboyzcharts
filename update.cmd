@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
"C:\Program Files\nodejs\node.exe" update.mjs > "logs\last-run.log" 2>&1
echo Zaktualizowano. Log: logs\last-run.log
