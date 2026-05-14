@echo off
setlocal
cd /d "C:\Users\Administrator\.openclaw\workspace\keypool"
powershell -ExecutionPolicy Bypass -File ".\scripts\start-keypool-bg.ps1" -ForceRestart
pause
