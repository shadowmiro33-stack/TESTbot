// cloudflared 로그에서 공개 주소(https://*.trycloudflare.com)를 찾아 _public-url.txt 에 기록하고,
// 그 주소로 실제 접속이 되는지 확인합니다.  사용: node scripts/wait-tunnel.mjs <로그 파일> [대기 초]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logFile = path.resolve(process.argv[2] ?? '_run-tunnel.log');
const timeoutMs = Number(process.argv[3] ?? 120) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

let url = null;
while (!url && Date.now() - started < timeoutMs) {
  if (existsSync(logFile)) url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(readFileSync(logFile, 'utf8'))?.[0] ?? null;
  if (!url) await sleep(1000);
}
if (!url) {
  console.error('[tunnel] 공개 주소를 받지 못했습니다. _run-tunnel.log 를 확인하세요. (회사 방화벽이 Cloudflare 연결을 막는 경우가 있습니다)');
  process.exit(1);
}
writeFileSync(path.join(root, '_public-url.txt'), `${url}\r\n`);
console.log(`[tunnel] 공개 주소: ${url}`);

// 새 주소는 DNS 반영까지 수 초~수십 초 걸릴 수 있음
let lastError = '';
while (Date.now() - started < timeoutMs + 60_000) {
  try {
    const res = await fetch(`${url}/api/auth/session`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    if (res.ok && body.includes('authRequired')) {
      console.log(`[tunnel] 외부 주소 접속 확인: ${body}`);
      process.exit(0);
    }
    lastError = `HTTP ${res.status}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  await sleep(3000);
}
console.error(`[tunnel] 주소는 받았지만 접속 확인에 실패했습니다: ${lastError}`);
process.exit(2);
