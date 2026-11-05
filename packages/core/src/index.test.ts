import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, getEncryptionKey, isDangerousAction, maskRequestBody, maskSecretText, maskSecrets, maskUrl } from './index';
describe('security helpers', () => {
  it('round trips encrypted secrets', () => { const encrypted = encryptSecret('pw', 'secret'); expect(encrypted).not.toContain('pw'); expect(decryptSecret(encrypted, 'secret')).toBe('pw'); });
  it('masks nested credentials', () => expect(maskSecrets({ password: 'x', nested: { token: 'y', ok: 1 } })).toEqual({ password: '***', nested: { token: '***', ok: 1 } }));
  it('detects dangerous actions', () => expect(isDangerousAction('회원 삭제')).toBe(true));
  it('returns encryption key safely', () => expect(getEncryptionKey()).toBeDefined());
});

describe('request body / text masking', () => {
  it('masks urlencoded form bodies', () => {
    const masked = maskRequestBody('username=admin&password=S3cret!&remember=1')!;
    expect(masked).not.toContain('S3cret');
    expect(masked).toContain('username=admin');
    expect(masked).toContain('remember=1');
  });
  it('masks JSON bodies by key', () => {
    const masked = JSON.parse(maskRequestBody('{"user":{"email":"a@b.c","password":"S3cret!"},"accessToken":"abc"}')!);
    expect(masked).toEqual({ user: { email: 'a@b.c', password: '***' }, accessToken: '***' });
  });
  it('masks JSON-like strings that fail to parse', () => {
    expect(maskRequestBody('{"password":"S3cret!", broken')).not.toContain('S3cret');
  });
  it('masks bearer tokens and key=value in free text', () => {
    const masked = maskSecretText('Authorization: Bearer eyJhbGciOi.payload.sig and pwd=hunter2');
    expect(masked).not.toContain('eyJhbGciOi');
    expect(masked).not.toContain('hunter2');
  });
  it('keeps empty/null bodies as is', () => {
    expect(maskRequestBody(null)).toBeNull();
    expect(maskRequestBody('')).toBe('');
  });
  it('masks sensitive query params in URLs', () => {
    const masked = maskUrl('https://example.com/cb?code=1&access_token=abc&session_id=zz');
    expect(masked).not.toContain('abc');
    expect(masked).not.toContain('zz');
    expect(masked).toContain('code=1');
  });
  it('leaves URLs without secrets untouched', () => {
    expect(maskUrl('https://example.com/list?page=2')).toBe('https://example.com/list?page=2');
  });
});
