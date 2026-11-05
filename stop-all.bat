@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo AUTOHANDS 서버, 로컬 DB, 외부 접속 터널을 모두 종료합니다...
node scripts\stop-local.mjs
echo.
echo 완료되었습니다.
timeout /t 5
