@echo off
chcp 65001 > nul
title AUTOHANDS AI QA SYSTEM - Dev Server
cd /d "%~dp0"
set "CI=true"

set "PNPM=pnpm"
where pnpm > nul 2>&1 || set "PNPM=npx -y pnpm@10.11.0"

echo [1/6] 이전 실행 정리...
node scripts\stop-local.mjs

echo [2/6] .env 확인...
if not exist ".env" copy .env.example .env > nul

echo [3/6] 의존성 확인...
if not exist "node_modules\.modules.yaml" (
  call %PNPM% install --config.confirmModulesPurge=false
  if errorlevel 1 goto :fail
)

echo [4/6] PostgreSQL / Redis 준비...
where docker > nul 2>&1
if %errorlevel% equ 0 (
  docker compose up -d postgres redis
) else (
  echo   Docker 가 없어 로컬 PostgreSQL 을 실행합니다. ^(별도 창 "AUTOHANDS DB"^)
  netstat -aon | findstr /r /c:":5432 .*LISTENING" > nul || start "AUTOHANDS DB" /min cmd /k "%PNPM% db:local"
  echo   Redis 없이 실행합니다. ^(분석/실행 작업은 API 서버가 직접 처리^)
)
node scripts\wait-port.mjs 5432 180
if errorlevel 1 goto :fail

echo [5/6] DB 스키마 반영 / 브라우저 준비...
call %PNPM% db:push --skip-generate
if errorlevel 1 goto :fail
call %PNPM% db:generate
call %PNPM% playwright:install

echo [6/6] 개발 서버 시작 (API 4000, Web 3000)...
echo   대시보드: http://localhost:3000
echo   API 상태: http://localhost:4000/health
echo.
call %PNPM% dev
goto :eof

:fail
echo.
echo [오류] 위 메시지를 확인하세요.
pause
exit /b 1
