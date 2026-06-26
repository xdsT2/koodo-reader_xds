@echo off
cd /d "%~dp0"
echo ===========================
echo Koodo Reader TTS Debug
echo ===========================
echo.
echo Step 1: Close portable Koodo Reader first
echo.
pause
echo.
echo Step 2: Copy config...
if exist "%APPDATA%\koodo-reader" (
    if not exist ".dev-user-data" mkdir ".dev-user-data"
    xcopy "%APPDATA%\koodo-reader\*" ".dev-user-data\" /E /I /Y >nul
    echo Done
)
echo.
pause
echo.
echo Step 3: Rebuilding renderer...
call npm run build
echo.
echo Build complete!
echo.
pause
echo.
echo Step 4: Launching Koodo Reader...
echo Log: tts-debug.log
echo.
set ELECTRON_IS_DEV=0
npx electron . --user-data-dir=".dev-user-data"
echo.
echo Done.
pause
