@echo off
REM ============================================================
REM  MV-Maker: restart backend ONLY (keep all caches / uploads)
REM  Right-click -> Run as administrator
REM ============================================================
SETLOCAL
SET PORT=3001
SET NODE_EXE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe
SET SERVER_DIR=D:\TEST\workbuddy mvmaker\server
SET LOG_FILE=%TEMP%\mv-maker-backend.log

echo.
echo [1/2] Stopping backend on port %PORT% ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr :%PORT%') do (
    if not "%%a"=="" (
        echo   killing PID %%a
        taskkill /F /PID %%a >nul 2>&1
    )
)
timeout /t 1 >nul

echo.
echo [2/2] Starting backend (caches kept)...
if not exist "%NODE_EXE%" (
    echo   ERROR: node not found at %NODE_EXE%
    goto :end
)
start "MV-Maker Backend" cmd /k "cd /d "%SERVER_DIR%" && "%NODE_EXE%" src/index.js > "%LOG_FILE%" 2>&1"

timeout /t 3 >nul
echo.
echo [health] self-check:
curl -s http://localhost:%PORT%/api/health
echo.

:end
echo.
echo Done. Close the "MV-Maker Backend" window to stop the server.
pause
