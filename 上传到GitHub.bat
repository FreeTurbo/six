@echo off
chcp 65001 >nul
title Upload to GitHub
setlocal

set "SCRIPT=%~dp0tools\push.ps1"

if not exist "%SCRIPT%" (
  echo.
  echo   [ERROR] tools\push.ps1 not found.
  echo   Looked in: %SCRIPT%
  echo.
  pause
  exit /b 1
)

set "PSEXE=pwsh"
where pwsh >nul 2>nul || set "PSEXE=powershell"

"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
exit /b %ERRORLEVEL%
