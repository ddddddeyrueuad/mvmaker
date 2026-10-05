@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

rem ============================================================
rem  MV-Maker Backend restart + cache clean (manual tool)
rem  - stops the node process listening on port 3001
rem  - removes job cache (uploads), python __pycache__, vite cache
rem  - starts backend (managed node) in a new window
rem  NOTE: client/dist is a build artifact, NOT cleared (deleting it
rem        would break the SPA until rebuilt). Rebuild with npm run build.
rem  Run as Administrator (right-click -> Run as administrator).
rem ============================================================

set "ROOT=D:\TEST\workbuddy mvmaker"
set "SERVER=%ROOT%\server"
set "NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe"
set "UPLOADS=%SERVER%\uploads"

if not exist "%NODE%" set "NODE=node"

echo ============================================
echo  MV-Maker Backend: stop + clean cache + start
echo ============================================

rem --- 1. Stop backend listening on port 3001 ---
echo [1/3] Stopping backend on port 3001 ...
set "KILLED=0"
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /i "LISTENING" ^| findstr /i ":3001"') do (
  echo      killing PID %%a
  taskkill /PID %%a /F >nul 2>&1
  set "KILLED=1"
)
if "%KILLED%"=="0" echo      (no process found on port 3001)
timeout /t 1 >nul

rem --- 2. Clear caches ---
echo [2/3] Clearing caches ...
if exist "%UPLOADS%" (
  echo      removing job files in %UPLOADS%
  for /d %%d in ("%UPLOADS%\*") do rmdir /s /q "%%d" 2>nul
  del /q "%UPLOADS%\*" >nul 2>&1
)
if exist "%SERVER%\__pycache__" (
  echo      removing %SERVER%\__pycache__
  rmdir /s /q "%SERVER%\__pycache__" 2>nul
)
if exist "%ROOT%\client\node_modules\.vite" (
  echo      removing vite dev cache
  rmdir /s /q "%ROOT%\client\node_modules\.vite" 2>nul
)
echo      cache cleared.

rem --- 3. Start backend in a new window ---
echo [3/3] Starting backend ...
cd /d "%SERVER%"
start "MV-Maker Backend" "%NODE%" src/index.js

rem --- health check ---
timeout /t 3 >nul
echo      health:
curl -s http://localhost:3001/api/health
echo.
echo Backend window "MV-Maker Backend" is now open.
echo Close that window to stop the server.
echo ============================================
pause
