@echo off
rem ---------------------------------------------------------------
rem  Codex Atlas launcher.
rem  Keep this file pure ASCII: cmd.exe parses .bat with the system
rem  ANSI code page (936 on zh-CN Windows), so UTF-8 Chinese comments
rem  and messages break the script. Chinese output comes from serve.py,
rem  after "chcp 65001" below has switched the console to UTF-8.
rem ---------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"
title Codex Atlas - Local Server

set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py"
)

if not defined PY (
  echo.
  echo   [x] Python not found.
  echo.
  echo   Install Python 3.10+ from python.org and tick
  echo   "Add Python to PATH", or reuse the Python bundled with ComfyUI.
  echo.
  pause
  exit /b 1
)

%PY% "%~dp0serve.py" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   [x] Failed to start ^(exit code %CODE%^). See the lines above.
  echo.
  pause
)
exit /b %CODE%
