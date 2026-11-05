@echo off
chcp 65001 > nul
cd /d "%~dp0"
set "CI=true"
set "LOG=%~dp0_run-main.log"
echo ===== AUTOHANDS RUN %date% %time% > "%LOG%"
set "PNPM=pnpm"
where pnpm > nul 2>&1 || set "PNPM=npx -y pnpm@10.11.0"
if not exist ".env" copy .env.example .env > nul

echo ===== STEP stop-previous ===== >> "%LOG%"
node scripts\stop-local.mjs >> "%LOG%" 2>&1
timeout /t 2 /nobreak > nul

echo ===== STEP db ===== >> "%LOG%"
netstat -aon | findstr /r /c:":5432 .*LISTENING" > nul || start "AUTOHANDS DB" /min cmd /c "%PNPM% db:local > _run-db.log 2>&1"
node scripts\wait-port.mjs 5432 300 >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP db-push ===== >> "%LOG%"
call %PNPM% db:push --skip-generate >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP playwright ===== >> "%LOG%"
call %PNPM% playwright:install >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP servers ===== >> "%LOG%"
start "AUTOHANDS API" /min cmd /c "%PNPM% --filter @autohands/api dev > _run-api.log 2>&1"
start "AUTOHANDS WEB" /min cmd /c "%PNPM% --filter @autohands/web dev > _run-web.log 2>&1"
node scripts\wait-port.mjs 4000 180 >> "%LOG%" 2>&1
node scripts\wait-port.mjs 3000 240 >> "%LOG%" 2>&1
curl -s http://localhost:4000/health >> "%LOG%" 2>&1
echo. >> "%LOG%"
echo ===== READY %date% %time% >> "%LOG%"
