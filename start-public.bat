@echo off
chcp 65001 > nul
title AUTOHANDS - 외부 접속 모드
cd /d "%~dp0"
set "CI=true"
set "LOG=%~dp0_public-run.log"
set "PNPM=pnpm"
where pnpm > nul 2>&1 || set "PNPM=npx -y pnpm@10.11.0"
echo ===== AUTOHANDS PUBLIC %date% %time% > "%LOG%"
echo.
echo  AUTOHANDS 외부 접속 모드를 시작합니다. (몇 분 걸릴 수 있습니다)
echo  진행 기록: _public-run.log
echo.

echo [1/8] 이전 실행 정리...
echo ===== STEP stop ===== >> "%LOG%"
node scripts\stop-local.mjs >> "%LOG%" 2>&1
timeout /t 2 /nobreak > nul

echo [2/8] 의존성 확인...
echo ===== STEP deps ===== >> "%LOG%"
if not exist "node_modules\.modules.yaml" (
  call %PNPM% install --config.confirmModulesPurge=false >> "%LOG%" 2>&1
  if errorlevel 1 goto :fail
)

echo [3/8] 로컬 DB 실행...
echo ===== STEP db ===== >> "%LOG%"
netstat -aon | findstr /r /c:":5432 .*LISTENING" > nul || start "AUTOHANDS DB" /min cmd /c "%PNPM% db:local > _run-db.log 2>&1"
node scripts\wait-port.mjs 5432 300 >> "%LOG%" 2>&1
if errorlevel 1 goto :fail
call %PNPM% db:push --skip-generate >> "%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [4/8] 보안 설정 점검 (접속 토큰, 암호화 키)...
echo ===== STEP prepare ===== >> "%LOG%"
call %PNPM% --filter @autohands/api exec tsx scripts/prepare-public.ts >> "%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [5/8] 테스트 브라우저 준비...
echo ===== STEP playwright ===== >> "%LOG%"
call %PNPM% playwright:install >> "%LOG%" 2>&1

echo [6/8] 대시보드 운영용 빌드...
echo ===== STEP build ===== >> "%LOG%"
call %PNPM% --filter @autohands/web build >> "%LOG%" 2>&1
if errorlevel 1 goto :fail
if exist "apps\web\.next\standalone\apps\web\server.js" (
  xcopy /e /i /y /q "apps\web\.next\static" "apps\web\.next\standalone\apps\web\.next\static" >> "%LOG%" 2>&1
)

echo [7/8] 서버 시작 (이 PC 에서만 수신, 외부는 터널로만 접속)...
echo ===== STEP servers ===== >> "%LOG%"
set "NODE_ENV=production"
set "API_HOST=127.0.0.1"
set "TARGET_BLOCK_PRIVATE=true"
set "TRUST_CF_CONNECTING_IP=true"
start "AUTOHANDS API" /min cmd /c "%PNPM% --filter @autohands/api start > _run-api.log 2>&1"
node scripts\wait-port.mjs 4000 180 >> "%LOG%" 2>&1
if errorlevel 1 goto :fail
set "HOSTNAME=127.0.0.1"
set "PORT=3000"
if exist "apps\web\.next\standalone\apps\web\server.js" (
  start "AUTOHANDS WEB" /min cmd /c "node apps\web\.next\standalone\apps\web\server.js > _run-web.log 2>&1"
) else (
  start "AUTOHANDS WEB" /min cmd /c "%PNPM% --filter @autohands/web start -H 127.0.0.1 -p 3000 > _run-web.log 2>&1"
)
node scripts\wait-port.mjs 3000 180 >> "%LOG%" 2>&1
if errorlevel 1 goto :fail

echo [8/8] 외부 접속 주소 만들기 (Cloudflare Tunnel)...
echo ===== STEP tunnel ===== >> "%LOG%"
set "CF="
for /f "delims=" %%i in ('where cloudflared 2^>nul') do if not defined CF set "CF=%%i"
if not defined CF set "CF=%~dp0.local\bin\cloudflared.exe"
if not exist "%CF%" (
  echo   cloudflared 를 Cloudflare 공식 배포처^(GitHub^)에서 받습니다...
  if not exist ".local\bin" mkdir ".local\bin"
  curl.exe -fsSL -o "%CF%" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe >> "%LOG%" 2>&1
  if errorlevel 1 goto :fail
)
"%CF%" --version >> "%LOG%" 2>&1
if exist "_run-tunnel.log" del /q "_run-tunnel.log"
start "AUTOHANDS TUNNEL" /min cmd /c ""%CF%" tunnel --no-autoupdate --url http://127.0.0.1:3000 > _run-tunnel.log 2>&1"
node scripts\wait-tunnel.mjs _run-tunnel.log 120 >> "%LOG%" 2>&1
if errorlevel 2 (
  echo   [주의] 주소는 만들었지만 이 PC 에서 접속 확인을 못 했습니다. 휴대폰 등으로 직접 열어 보세요.
) else if errorlevel 1 goto :fail

set /p PUBLIC_URL=<_public-url.txt
echo ===== READY %date% %time% >> "%LOG%"
echo.
echo  ================================================================
echo   외부 접속 주소 : %PUBLIC_URL%
echo   접속 토큰      : _public-token.txt 파일을 열어 확인하세요
echo  ================================================================
echo   - 이 PC 가 켜져 있고 절전 모드가 아니어야 접속됩니다.
echo   - 다시 실행하면 주소가 바뀝니다. (무료 임시 주소)
echo   - 종료: stop-all.bat 실행
echo.
start "" "%PUBLIC_URL%"
pause
goto :eof

:fail
echo ===== FAILED %date% %time% >> "%LOG%"
echo.
echo [오류] 진행 중 문제가 생겼습니다. _public-run.log 를 확인하세요.
pause
exit /b 1
