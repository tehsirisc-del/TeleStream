@echo off
echo [Build] Generating config.js from .env...
node scripts\generate-config.js
if %ERRORLEVEL% NEQ 0 (
    echo [Build] ERROR: Failed to generate config.js. Check your .env file.
    pause
    exit /b 1
)

set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.10.7-hotspot"
npx cap copy android
cd android
call gradlew.bat assembleDebug
echo [Build] Done! APK is at: android\app\build\outputs\apk\debug\app-debug.apk
