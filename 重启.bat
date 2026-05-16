@echo off
chcp 65001 >nul
title KeyPool - 重启
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\scripts\stop-keypool.ps1"
powershell -ExecutionPolicy Bypass -File ".\scripts\start-keypool-bg.ps1"
pause
