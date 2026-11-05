import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * 테스트 대상 URL 정책 (SSRF 방지)
 *
 * QA 도구는 사내 스테이징(사설 IP)을 테스트하는 것이 주 용도이므로 사설 대역은 기본 허용합니다.
 * - 항상 차단: 클라우드 메타데이터/링크로컬(169.254.0.0/16, fe80::/10), 0.0.0.0/8, 멀티캐스트, 메타데이터 호스트명
 * - 루프백(127.0.0.0/8, ::1): 운영(NODE_ENV=production)에서 기본 차단 (TARGET_ALLOW_LOOPBACK=true 로 허용)
 * - 사설 대역(10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7): TARGET_BLOCK_PRIVATE=true 일 때 차단
 * - TARGET_ALLOWLIST(쉼표, *.example.com 형식 지원)가 있으면 목록에 있는 호스트만 허용
 *   (목록에 있는 호스트는 루프백/사설 제한을 받지 않지만, 메타데이터/링크로컬은 여전히 차단)
 */
export type TargetPolicy = { blockPrivate: boolean; blockLoopback: boolean; allowHosts: string[] };
export type IpClass = 'public' | 'private' | 'loopback' | 'link-local' | 'unspecified' | 'multicast';

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.com', 'instance-data', 'instance-data.ec2.internal']);

export function targetPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): TargetPolicy {
  return {
    blockPrivate: env.TARGET_BLOCK_PRIVATE === 'true',
    blockLoopback: env.NODE_ENV === 'production' && env.TARGET_ALLOW_LOOPBACK !== 'true',
    allowHosts: (env.TARGET_ALLOWLIST ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  };
}

function ipv4ToInt(ip: string) {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}
const inV4 = (ip: string, cidr: string) => {
  const [base, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base!) & mask);
};

export function classifyIp(rawIp: string): IpClass {
  let ip = rawIp.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6 (::ffff:169.254.169.254) → IPv4 로 판정
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  // URL 파서는 ::ffff:169.254.169.254 를 ::ffff:a9fe:a9fe 로 정규화하므로 16진 표기도 변환 (우회 방지)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16); const lo = parseInt(mappedHex[2]!, 16);
    ip = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  if (isIP(ip) === 4) {
    if (inV4(ip, '0.0.0.0/8')) return 'unspecified';
    if (inV4(ip, '127.0.0.0/8')) return 'loopback';
    if (inV4(ip, '169.254.0.0/16')) return 'link-local';
    if (inV4(ip, '224.0.0.0/4') || inV4(ip, '240.0.0.0/4')) return 'multicast';
    if (inV4(ip, '10.0.0.0/8') || inV4(ip, '172.16.0.0/12') || inV4(ip, '192.168.0.0/16') || inV4(ip, '100.64.0.0/10')) return 'private';
    return 'public';
  }
  if (isIP(ip) === 6) {
    if (ip === '::') return 'unspecified';
    if (ip === '::1') return 'loopback';
    if (/^fe[89ab]/.test(ip)) return 'link-local';
    if (/^ff/.test(ip)) return 'multicast';
    if (/^f[cd]/.test(ip)) return 'private';
    return 'public';
  }
  return 'public';
}

const hostAllowlisted = (host: string, policy: TargetPolicy) =>
  policy.allowHosts.some((pattern) => (pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern));

/** IP 하나에 대한 차단 사유 (허용이면 null) */
export function ipBlockReason(ip: string, policy: TargetPolicy, allowlisted = false): string | null {
  const cls = classifyIp(ip);
  if (cls === 'link-local') return `링크로컬/클라우드 메타데이터 주소(${ip})는 테스트 대상으로 사용할 수 없습니다.`;
  if (cls === 'unspecified' || cls === 'multicast') return `특수 주소(${ip})는 테스트 대상으로 사용할 수 없습니다.`;
  if (allowlisted) return null;
  if (cls === 'loopback' && policy.blockLoopback) return `운영 환경에서는 루프백 주소(${ip})를 테스트할 수 없습니다. (TARGET_ALLOW_LOOPBACK=true 로 허용 가능)`;
  if (cls === 'private' && policy.blockPrivate) return `사설 네트워크 주소(${ip})는 정책상 차단되어 있습니다. (TARGET_BLOCK_PRIVATE / TARGET_ALLOWLIST 확인)`;
  return null;
}

export class TargetBlockedError extends Error {
  readonly code = 'TARGET_BLOCKED';
  readonly statusCode = 400;
  constructor(message: string) { super(`TARGET_BLOCKED: ${message}`); }
}

/**
 * 테스트 대상 URL 검증 (DNS 해석 결과까지 확인). 실패 시 TargetBlockedError.
 * 등록 시점과 실행 시점 모두 호출해 DNS 리바인딩을 줄입니다.
 */
export async function assertSafeTarget(rawUrl: string, policy: TargetPolicy = targetPolicyFromEnv()): Promise<void> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new TargetBlockedError('올바른 URL 이 아닙니다.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TargetBlockedError(`http/https 만 허용됩니다. (${url.protocol})`);
  if (url.username || url.password) throw new TargetBlockedError('URL 에 계정 정보를 넣지 마세요. 계정은 별도로 등록합니다.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_HOSTS.has(host)) throw new TargetBlockedError(`메타데이터 호스트(${host})는 테스트 대상으로 사용할 수 없습니다.`);
  const allowlisted = hostAllowlisted(host, policy);
  if (policy.allowHosts.length && !allowlisted) throw new TargetBlockedError(`허용 목록(TARGET_ALLOWLIST)에 없는 호스트입니다: ${host}`);

  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new TargetBlockedError(`호스트 이름을 해석할 수 없습니다: ${host}`);
  for (const address of addresses) {
    const reason = ipBlockReason(address, policy, allowlisted);
    if (reason) throw new TargetBlockedError(reason);
  }
}

/**
 * 브라우저가 보내는 개별 요청(리다이렉트·하위 리소스 포함)용 동기 검사.
 * DNS 조회 없이 IP 리터럴과 메타데이터 호스트명만 판정합니다. 차단해야 하면 true.
 */
export function isForbiddenRequestUrl(rawUrl: string, policy: TargetPolicy = targetPolicyFromEnv()): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false; // data:, blob: 등은 브라우저 내부
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_HOSTS.has(host)) return true;
  if (!isIP(host)) return false;
  return ipBlockReason(host, policy, hostAllowlisted(host, policy)) !== null;
}
