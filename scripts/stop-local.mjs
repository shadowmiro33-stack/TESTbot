// 이 프로젝트의 로컬 개발 프로세스(API/Web/Worker/로컬 DB/postgres)를 종료합니다.
// 사용: pnpm stop   (Windows 전용 동작, 그 외 OS 에서는 포트 기준으로만 안내)
// 창 제목 대신 명령줄/실행 파일 경로로 찾기 때문에 Windows Terminal 에서 실행한 경우에도 정확히 종료됩니다.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').toLowerCase();
if (process.platform !== 'win32') {
  console.log('[stop] Windows 이외 환경: 실행 중인 터미널에서 Ctrl+C 로 종료하세요.');
  process.exit(0);
}

const ps = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
const list = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const procs = Array.isArray(list) ? list : [list];

// 자기 자신과 부모 체인은 제외 (이 스크립트를 실행한 cmd/pnpm 을 죽이지 않도록)
const byId = new Map(procs.map((p) => [p.ProcessId, p]));
const protectedIds = new Set();
for (let id = process.pid; id && byId.has(id) && !protectedIds.has(id); id = byId.get(id).ParentProcessId) protectedIds.add(id);

const isOurs = (p) => {
  const cmd = String(p.CommandLine ?? '').toLowerCase().replace(/\//g, '\\');
  const exe = String(p.ExecutablePath ?? '').toLowerCase();
  const name = String(p.Name).toLowerCase();
  // 공개 모드 터널: 프로젝트 안의 cloudflared, 또는 이 대시보드(3000)를 내보내는 cloudflared
  if (name === 'cloudflared.exe') return exe.startsWith(root) || /(127\.0\.0\.1|localhost):3000/.test(cmd);
  if (!['node.exe', 'postgres.exe', 'pg_ctl.exe'].includes(name)) return false;
  return exe.startsWith(root) || cmd.includes(root) || cmd.includes('scripts\\local-db.mjs');
};
const targets = procs.filter((p) => isOurs(p) && !protectedIds.has(p.ProcessId));
if (!targets.length) { console.log('[stop] 종료할 프로세스가 없습니다.'); process.exit(0); }
for (const p of targets) {
  try {
    execFileSync('taskkill', ['/f', '/t', '/pid', String(p.ProcessId)], { stdio: 'ignore' });
    console.log(`[stop] 종료: ${p.Name} (PID ${p.ProcessId}) ${String(p.CommandLine ?? '').slice(0, 120)}`);
  } catch { /* 이미 종료됨 (부모와 함께 정리된 경우) */ }
}
