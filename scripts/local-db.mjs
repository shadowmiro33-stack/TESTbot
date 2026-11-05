// Docker 없이 로컬 PostgreSQL 실행 (embedded-postgres: npm 으로 받은 PostgreSQL 바이너리를 관리자 권한 없이 실행)
// 사용: pnpm db:local   (종료: Ctrl+C)
// 접속 정보는 .env 의 DATABASE_URL 을 따릅니다. 데이터는 .local/pgdata 에 유지됩니다.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function envValue(key) {
  if (process.env[key]) return process.env[key];
  const file = path.join(root, '.env');
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`).exec(line);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}
const url = new URL(envValue('DATABASE_URL') ?? 'postgresql://autohands:autohands@localhost:5432/autohands?schema=public');
const config = {
  user: decodeURIComponent(url.username || 'autohands'),
  password: decodeURIComponent(url.password || 'autohands'),
  port: Number(url.port || 5432),
  database: url.pathname.replace(/^\//, '') || 'autohands'
};
const databaseDir = path.join(root, '.local', 'pgdata');
const pg = new EmbeddedPostgres({
  databaseDir, user: config.user, password: config.password, port: config.port, persistent: true,
  onLog: () => {}, onError: (e) => console.error('[local-db]', String(e).trim())
});

// 강제 종료로 남은 postmaster.pid 정리 (포트가 비어 있는데 pid 파일만 남은 경우 Windows 에서 재시작이 막힘)
const pidFile = path.join(databaseDir, 'postmaster.pid');
if (existsSync(pidFile)) {
  const portBusy = await new Promise((resolve) => {
    const s = net.connect(config.port, '127.0.0.1');
    s.once('connect', () => { s.end(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  if (portBusy) { console.log(`[local-db] 포트 ${config.port} 에서 이미 PostgreSQL 이 실행 중입니다.`); process.exit(0); }
  rmSync(pidFile, { force: true });
  console.log('[local-db] 이전 비정상 종료로 남은 postmaster.pid 를 정리했습니다.');
}

if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) {
  console.log(`[local-db] 데이터 디렉터리 초기화: ${databaseDir}`);
  await pg.initialise();
}
await pg.start();
try { await pg.createDatabase(config.database); console.log(`[local-db] 데이터베이스 생성: ${config.database}`); } catch { /* 이미 있음 */ }
console.log(`[local-db] LOCAL_POSTGRES_READY postgresql://${config.user}:***@localhost:${config.port}/${config.database}`);

let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; console.log('[local-db] 종료 중...'); await pg.stop().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
