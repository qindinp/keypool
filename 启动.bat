@echo off
chcp 65001 >nul
title KeyPool - 启动
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\scripts\start-keypool-bg.ps1"
pause
