@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0release\SciPlot-Windows-v2\SciPlot.exe" (
  start "" "%~dp0release\SciPlot-Windows-v2\SciPlot.exe"
  exit /b 0
)
if exist "%~dp0release\SciPlot-Windows\SciPlot.exe" (
  start "" "%~dp0release\SciPlot-Windows\SciPlot.exe"
  exit /b 0
)
if exist "%~dp0简图-SciPlot.html" (
  start "" "%~dp0简图-SciPlot.html"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到独立版“简图-SciPlot.html”。请将独立版 HTML 放回本文件所在目录后重试。
  echo 开发者也可以安装 Node.js 20 或更新版本，使用本地服务器启动。
  pause
  exit /b 1
)
title 简图 SciPlot 本地服务
node server.mjs --open
if errorlevel 1 pause
