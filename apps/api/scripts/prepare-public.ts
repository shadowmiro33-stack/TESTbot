// 공개(외부 접속) 모드 준비: 루트 .env 의 보안 값을 점검하고 필요하면 안전한 값으로 교체합니다.
// - API_TOKEN 이 비었거나 짧으면 새로 생성
// - CREDENTIAL_ENCRYPTION_KEY 가 예시 값/짧은 값이면 새 키로 교체하고, 저장된 테스트 계정 비밀번호를 새 키로 재암호화
// 비밀 값은 화면에 출력하지 않습니다. 접속 토큰은 _public-token.txt (git 제외) 에만 기록합니다.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { decryptSecret, encryptSecret } from '@autohands/core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envPath = path.join(root, '.env');
if (!existsSync(envPath)) copyFileSync(path.join(root, '.env.example'), envPath);
let text = readFileSync(envPath, 'utf8');

const read = (key: string) => {
  const m = new RegExp(`^\\s*${key}\\s*=(.*)$`, 'm').exec(text);
  return m ? m[1]!.trim().replace(/^['"]|['"]$/g, '') : '';
};
const write = (key: string, value: string) => {
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
};
const fresh = (bytes: number) => randomBytes(bytes).toString('base64url');

const WEAK_KEYS = new Set(['', 'change-me-to-a-long-random-secret', 'development-only-change-me']);
const DEV_FALLBACK_KEY = 'development-only-change-me';

let changed = false;
let token = read('API_TOKEN');
if (token.length < 16) {
  token = fresh(24);
  write('API_TOKEN', token);
  changed = true;
  console.log('[public] API_TOKEN: 새로 생성했습니다.');
} else {
  console.log('[public] API_TOKEN: 기존 값을 사용합니다.');
}

const oldKey = read('CREDENTIAL_ENCRYPTION_KEY');
if (WEAK_KEYS.has(oldKey) || oldKey.length < 24) {
  const newKey = fresh(32);
  // DATABASE_URL 은 .env 값 사용
  process.env.DATABASE_URL ||= read('DATABASE_URL');
  const prisma = new PrismaClient();
  try {
    const creds = await prisma.credential.findMany({ select: { id: true, encryptedPassword: true } });
    const candidates = [...new Set([oldKey || DEV_FALLBACK_KEY, DEV_FALLBACK_KEY, 'change-me-to-a-long-random-secret'])];
    const updates: Array<{ id: string; encryptedPassword: string }> = [];
    let unreadable = 0;
    for (const c of creds) {
      let plain: string | null = null;
      for (const k of candidates) {
        try { plain = decryptSecret(c.encryptedPassword, k); break; } catch { /* 다음 후보 */ }
      }
      if (plain === null) { unreadable++; continue; }
      updates.push({ id: c.id, encryptedPassword: encryptSecret(plain, newKey) });
    }
    await prisma.$transaction(updates.map((u) => prisma.credential.update({ where: { id: u.id }, data: { encryptedPassword: u.encryptedPassword } })));
    copyFileSync(envPath, `${envPath}.bak`);
    write('CREDENTIAL_ENCRYPTION_KEY', newKey);
    changed = true;
    console.log(`[public] 암호화 키: 예시 값이라 새 키로 교체했습니다. (테스트 계정 ${updates.length}개 재암호화${unreadable ? `, 읽을 수 없는 ${unreadable}개는 다시 등록 필요` : ''})`);
  } finally {
    await prisma.$disconnect();
  }
} else {
  console.log('[public] 암호화 키: 기존 값을 사용합니다.');
}

if (changed) writeFileSync(envPath, text);
writeFileSync(
  path.join(root, '_public-token.txt'),
  `AUTOHANDS 외부 접속 토큰 (다른 사람에게 공유하면 그 사람도 접속할 수 있습니다)\r\n\r\n${token}\r\n\r\n토큰을 바꾸려면 .env 의 API_TOKEN 값을 지우고 start-public.bat 을 다시 실행하세요.\r\n`
);
console.log('[public] 접속 토큰은 _public-token.txt 에 저장했습니다.');
