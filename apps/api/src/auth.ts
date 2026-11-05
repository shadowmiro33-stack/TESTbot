import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 공유 토큰 기반 API 인증
 * - API_TOKEN 설정 시 /api/* 는 인증 필요 (Authorization: Bearer <토큰> 또는 로그인 세션 쿠키)
 * - 세션 쿠키 값 = HMAC(API_TOKEN) → 서버에 세션 저장소가 필요 없고, 토큰을 바꾸면 모든 세션이 무효화됩니다.
 * - 운영(NODE_ENV=production)에서는 API_TOKEN 이 없으면 서버를 시작하지 않습니다.
 */
export const SESSION_COOKIE = 'autohands_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;

export type AuthConfig = { token: string | null; secureCookie: boolean };

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const token = env.API_TOKEN?.trim() || null;
  if (!token && env.NODE_ENV === 'production') {
    throw new Error('FATAL: 운영 환경(NODE_ENV=production)에서는 API_TOKEN 을 반드시 설정해야 합니다. 인증 없이 API 를 노출할 수 없습니다.');
  }
  return { token, secureCookie: env.NODE_ENV === 'production' || env.COOKIE_SECURE === 'true' };
}

const sessionValue = (token: string) => createHmac('sha256', token).update('autohands-session-v1').digest('base64url');

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthenticated(config: AuthConfig, headers: Record<string, string | string[] | undefined>): boolean {
  if (!config.token) return true;
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), config.token)) return true;
  const cookie = parseCookies(typeof headers.cookie === 'string' ? headers.cookie : undefined)[SESSION_COOKIE];
  return Boolean(cookie && safeEqual(cookie, sessionValue(config.token)));
}

export function verifyToken(config: AuthConfig, candidate: string): boolean {
  return Boolean(config.token && safeEqual(candidate, config.token));
}

export function sessionCookie(config: AuthConfig): string {
  return `${SESSION_COOKIE}=${sessionValue(config.token!)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${config.secureCookie ? '; Secure' : ''}`;
}
export function clearedCookie(config: AuthConfig): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookie ? '; Secure' : ''}`;
}

/** 로그인 실패 횟수 제한 (IP 단위, 메모리) */
const failures = new Map<string, number[]>();
export function loginBlocked(ip: string): boolean {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= MAX_FAILURES;
}
export function recordLoginFailure(ip: string) {
  failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
}
export function clearLoginFailures(ip: string) { failures.delete(ip); }
