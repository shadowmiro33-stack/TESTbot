import { describe, expect, it } from 'vitest';
import { assertSafeTarget, classifyIp, isForbiddenRequestUrl, targetPolicyFromEnv, type TargetPolicy } from './index';

const dev: TargetPolicy = { blockPrivate: false, blockLoopback: false, allowHosts: [] };
const prod: TargetPolicy = { blockPrivate: false, blockLoopback: true, allowHosts: [] };
const strict: TargetPolicy = { blockPrivate: true, blockLoopback: true, allowHosts: [] };
const blocked = async (url: string, policy: TargetPolicy) => assertSafeTarget(url, policy).then(() => false, (e) => String(e.message).startsWith('TARGET_BLOCKED'));

describe('target policy (SSRF)', () => {
  it('classifies addresses', () => {
    expect(classifyIp('169.254.169.254')).toBe('link-local');
    expect(classifyIp('::ffff:169.254.169.254')).toBe('link-local');
    expect(classifyIp('::ffff:a9fe:a9fe')).toBe('link-local');
    expect(classifyIp('::ffff:7f00:1')).toBe('loopback');
    expect(classifyIp('127.0.0.1')).toBe('loopback');
    expect(classifyIp('10.1.2.3')).toBe('private');
    expect(classifyIp('172.20.0.1')).toBe('private');
    expect(classifyIp('172.32.0.1')).toBe('public');
    expect(classifyIp('8.8.8.8')).toBe('public');
    expect(classifyIp('fd00::1')).toBe('private');
  });
  it('always blocks cloud metadata, even in dev', async () => {
    expect(await blocked('http://169.254.169.254/latest/meta-data/', dev)).toBe(true);
    expect(await blocked('http://[::ffff:169.254.169.254]/', dev)).toBe(true);
    expect(await blocked('http://metadata.google.internal/computeMetadata/v1/', dev)).toBe(true);
    expect(await blocked('http://0.0.0.0:4000/', dev)).toBe(true);
  });
  it('allows internal staging by default (QA use case)', async () => {
    expect(await blocked('http://10.0.0.5:8080/', dev)).toBe(false);
    expect(await blocked('http://192.168.0.10/', prod)).toBe(false);
    expect(await blocked('http://127.0.0.1:3000/', dev)).toBe(false);
  });
  it('blocks loopback in production and private when configured', async () => {
    expect(await blocked('http://127.0.0.1:4000/api/projects', prod)).toBe(true);
    expect(await blocked('http://localhost:6379/', prod)).toBe(true);
    expect(await blocked('http://10.0.0.5/', strict)).toBe(true);
  });
  it('enforces allowlist and rejects non-http and embedded credentials', async () => {
    const list: TargetPolicy = { ...strict, allowHosts: ['*.autohands.co.kr', '127.0.0.1'] };
    expect(await blocked('http://127.0.0.1:4300/home', list)).toBe(false);
    expect(await blocked('http://localhost:4300/home', list)).toBe(true);
    expect(await blocked('file:///etc/passwd', dev)).toBe(true);
    expect(await blocked('http://user:pw@10.0.0.1/', dev)).toBe(true);
  });
  it('sync request guard catches metadata / redirects to IP literals', () => {
    expect(isForbiddenRequestUrl('http://169.254.169.254/latest', dev)).toBe(true);
    expect(isForbiddenRequestUrl('http://127.0.0.1:4000/api', prod)).toBe(true);
    expect(isForbiddenRequestUrl('https://cdn.example.com/app.js', prod)).toBe(false);
    expect(isForbiddenRequestUrl('data:image/png;base64,AAA', prod)).toBe(false);
  });
  it('reads policy from env', () => {
    expect(targetPolicyFromEnv({ NODE_ENV: 'production', TARGET_ALLOWLIST: 'a.com, *.b.com' } as NodeJS.ProcessEnv)).toEqual({ blockPrivate: false, blockLoopback: true, allowHosts: ['a.com', '*.b.com'] });
  });
});
