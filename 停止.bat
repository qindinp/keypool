@echo off
chcp 65001 >nul
title KeyPool - 停止
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\scripts\stop-keypool.ps1"
pause
