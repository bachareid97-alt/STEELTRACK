@echo off
cd /d "%~dp0"
echo Starting SteelTrack Server...
echo.
python server.py
if errorlevel 1 (
    echo.
    echo ============================================
    echo  server.py failed to start - see error above.
    echo  Copy this text and send it back for help.
    echo ============================================
)
echo.
pause
