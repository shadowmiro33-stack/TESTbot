// Prisma CLI 래퍼: 저장소 루트의 .env 를 읽어 DATABASE_URL 등을 넘겨줍니다.
// (pnpm --filter 로 실행하면 작업 디렉터리가 apps/api 라서 Prisma 가 루트 .env 를 찾지 못함)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.resolve(here, '../../../.env'), path.resolve(here, '../.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env, cwd: path.resolve(here, '..') });
process.exit(result.status ?? 1);
