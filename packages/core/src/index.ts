import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const key = (secret: string) => createHash('sha256').update(secret).digest();
export function encryptSecret(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}
export function decryptSecret(value: string, secret: string): string {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part!, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(secret), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8');
}

/** 민감 정보로 간주하는 키 이름 패턴 (헤더, JSON 필드, 폼 필드, 쿼리 파라미터 공통) */
export const SENSITIVE_KEY_PATTERN = /authorization|cookie|passw(or)?d|pwd|token|secret|api[-_]?key|session|credential/i;
const MASK = '***';
const SENSITIVE_KEY_SOURCE = '(?:authorization|cookie|passw(?:or)?d|pwd|token|secret|api[-_]?key|session|credential)';

export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY_PATTERN.test(k) ? MASK : maskSecrets(v)])
    );
  }
  return value;
}

/**
 * 자유 형식 문자열(요청 본문, 콘솔 로그 등)에서 민감 값을 마스킹합니다.
 * - "key": "value" (JSON 유사 문자열)
 * - key=value (폼 / 쿼리스트링)
 * - Bearer / Basic 인증 토큰
 */
export function maskSecretText(text: string): string {
  return text
    .replace(new RegExp(`(["']?[\\w-]*${SENSITIVE_KEY_SOURCE}[\\w-]*["']?\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi'), `$1"${MASK}"`)
    .replace(new RegExp(`(["']?[\\w-]*${SENSITIVE_KEY_SOURCE}[\\w-]*["']?\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gi'), `$1'${MASK}'`)
    .replace(new RegExp(`((?:^|[?&;\\s])[\\w.\\[\\]-]*${SENSITIVE_KEY_SOURCE}[\\w.\\[\\]-]*=)[^&;\\s]*`, 'gi'), `$1${MASK}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${MASK}`);
}

/** 요청 본문(postData)을 형식에 맞게 마스킹합니다. JSON → 키 기반, 그 외 → 텍스트 패턴 기반 */
export function maskRequestBody(body: string | null | undefined): string | null {
  if (body == null || body === '') return body ?? null;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(maskSecrets(JSON.parse(trimmed)));
    } catch {
      /* JSON 이 아니면 텍스트 마스킹으로 진행 */
    }
  }
  return maskSecretText(body);
}

/** URL 쿼리 파라미터 중 민감 키를 마스킹합니다. */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    for (const name of [...new Set(url.searchParams.keys())]) {
      if (SENSITIVE_KEY_PATTERN.test(name)) {
        url.searchParams.set(name, MASK);
        changed = true;
      }
    }
    return changed ? url.toString() : raw;
  } catch {
    return maskSecretText(raw);
  }
}

export function isDangerousAction(text: string): boolean {
  return /(delete|remove|withdraw|refund|payment|탈퇴|삭제|출금|환불|결제|취소)/i.test(text);
}

export function getEncryptionKey(): string {
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: CREDENTIAL_ENCRYPTION_KEY 환경 변수가 설정되지 않았습니다. 프로덕션 환경에서는 기본 키를 사용할 수 없습니다.');
    }
    return 'development-only-change-me';
  }
  return key;
}

export * from './target-policy.js';
