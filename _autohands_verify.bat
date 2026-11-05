@echo off
chcp 65001 > nul
cd /d "%~dp0"
set "CI=true"
set "LOG=%~dp0_verify-log.txt"
echo ===== AUTOHANDS VERIFY %date% %time% > "%LOG%"
set "PNPM=pnpm"
where pnpm > nul 2>&1 || set "PNPM=npx -y pnpm@10.11.0"
echo PNPM=%PNPM% >> "%LOG%"
echo ===== STEP stop-servers ===== >> "%LOG%"
node scripts\stop-local.mjs >> "%LOG%" 2>&1
timeout /t 3 /nobreak > nul
if not defined DATABASE_URL set "DATABASE_URL=postgresql://autohands:autohands@localhost:5432/autohands?schema=public"

echo ===== STEP install ===== >> "%LOG%"
call %PNPM% install --no-frozen-lockfile --config.confirmModulesPurge=false --reporter=append-only >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP prisma-generate ===== >> "%LOG%"
call %PNPM% --filter @autohands/api prisma generate >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP prisma-validate ===== >> "%LOG%"
call %PNPM% --filter @autohands/api prisma validate >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP typecheck ===== >> "%LOG%"
call %PNPM% -r --no-bail typecheck >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP test ===== >> "%LOG%"
call %PNPM% -r --no-bail test >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP web-build ===== >> "%LOG%"
call %PNPM% --filter @autohands/web build >> "%LOG%" 2>&1
echo [exit %errorlevel%] >> "%LOG%"

echo ===== STEP sheet-roundtrip ===== >> "%LOG%"
if exist ".local\test-sheet.xlsx" (
  call %PNPM% --filter @autohands/api exec tsx scripts/sheet-roundtrip.ts "%~dp0.local\test-sheet.xlsx" "%~dp0.local\test-sheet-result.xlsx" >> "%LOG%" 2>&1
  if errorlevel 1 (echo [exit 1] >> "%LOG%") else (echo [exit 0] >> "%LOG%")
) else (
  echo skip: .local\test-sheet.xlsx 없음 >> "%LOG%"
)

echo ===== DONE %date% %time% >> "%LOG%"
