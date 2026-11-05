@echo off
chcp 65001 > nul
title AUTOHANDS - Appium (앱 테스트 실행기)
cd /d "%~dp0"
where appium > nul 2>&1
if errorlevel 1 (
  echo [안내] Appium 이 설치되어 있지 않습니다. 아래 명령을 한 번 실행한 뒤 다시 실행하세요.
  echo   npm install -g appium
  echo   appium driver install uiautomator2
  echo.
  echo Android 기기/에뮬레이터 연결 확인: adb devices
  pause
  exit /b 1
)
where adb > nul 2>&1 && adb devices
echo.
echo Appium 서버를 시작합니다: http://127.0.0.1:4723  (이 창을 닫으면 앱 테스트가 멈춥니다)
appium --address 127.0.0.1 --port 4723
pause
