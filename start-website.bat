@echo off
title Cardiac Monitoring System
echo ============================================
echo   IoT Cardiac Patient Monitoring System
echo ============================================
echo.

:: Kill any process using port 4000 first
echo Freeing port 4000 if in use...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4000 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo Starting website...
echo.
echo   Frontend: http://localhost:5173/
echo   Backend:  http://localhost:4000
echo.
echo Press Ctrl+C to stop.
echo ============================================
echo.

npm run dev

pause
