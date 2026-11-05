import { describe, expect, it } from 'vitest';
import type { DiscoveryResult } from '@autohands/shared';
import { RuleProvider, OpenAIProvider, HybridProvider, createAIProvider } from './index.js';
import { normalizeAICases } from './openai-provider.js';

const mockDiscovery: DiscoveryResult = {
  pages: [
    {
      url: 'https://example.com/login',
      title: '로그인 페이지',
      links: [],
      forms: 1,
      inputs: [
        { selector: '#email', tag: 'input', type: 'email', name: 'email', label: '이메일', required: true },
        { selector: '#pw', tag: 'input', type: 'password', name: 'password', label: '비밀번호', maxLength: 20 },
        { selector: '#age', tag: 'input', type: 'number', name: 'age', label: '나이' }
      ],
      buttons: [
        { selector: '#btn-submit', tag: 'button', label: '로그인' }
      ]
    }
  ],
  networkEndpoints: [],
  consoleErrors: []
};

describe('Test Generator Providers', () => {
  it('RuleProvider generates normal, exception, boundary test cases', async () => {
    const provider = new RuleProvider();
    const cases = await provider.generateTestCases(mockDiscovery, ['NORMAL', 'EXCEPTION', 'BOUNDARY']);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => c.strategy === 'NORMAL')).toBe(true);
    expect(cases.some((c) => c.strategy === 'EXCEPTION')).toBe(true);
    expect(cases.some((c) => c.strategy === 'BOUNDARY')).toBe(true);
  });

  it('OpenAIProvider gracefully returns empty array when API key is missing', async () => {
    const provider = new OpenAIProvider({ apiKey: '' });
    const cases = await provider.generateTestCases(mockDiscovery, ['NORMAL']);
    expect(cases).toEqual([]);
  });

  it('HybridProvider returns at least rule-based cases when AI fails or key is missing', async () => {
    const provider = new HybridProvider();
    const cases = await provider.generateTestCases(mockDiscovery, ['NORMAL', 'EXCEPTION']);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => c.strategy === 'NORMAL')).toBe(true);
  });

  it('every rule-based case ends with a real assertion (no input-only cases)', async () => {
    const cases = await new RuleProvider().generateTestCases(mockDiscovery, ['NORMAL', 'EXCEPTION', 'BOUNDARY']);
    for (const c of cases) {
      const last = [...c.steps].sort((a, b) => a.order - b.order).at(-1)!;
      expect(last.action.startsWith('assert'), `${c.title} 마지막 단계가 검증이 아님`).toBe(true);
    }
  });

  it('EXCEPTION uses invalid values that the browser can judge', async () => {
    const cases = await new RuleProvider().generateTestCases(mockDiscovery, ['EXCEPTION']);
    const email = cases.find((c) => c.title.includes('이메일'))!;
    expect(email.testData).toEqual({ value: 'not-an-email' });
    expect(email.steps.some((s) => s.action === 'assertInvalid')).toBe(true);
    // 필수 아님 + 형식 없는 number 필드는 EXCEPTION 대상 아님
    expect(cases.some((c) => c.title.includes('나이'))).toBe(false);
  });

  it('BOUNDARY over-limit case asserts the value is truncated to maxLength', async () => {
    const cases = await new RuleProvider().generateTestCases(mockDiscovery, ['BOUNDARY']);
    const over = cases.find((c) => c.title.includes('21자'))!;
    expect(over.steps.at(-1)).toMatchObject({ action: 'assertValueLength', value: { max: 20 } });
    const unboundedNumber = cases.filter((c) => c.title.includes('나이'));
    expect(unboundedNumber.every((c) => c.metadata?.requirementCheck === true)).toBe(true);
  });

  it('normalizeAICases drops unsafe / invalid AI cases and fixes enums', () => {
    const cases = normalizeAICases([
      { title: 'ok', strategy: 'SECURITY', severity: 'URGENT', steps: [{ order: 1, action: 'navigate', value: 'https://example.com/login' }, { order: 2, action: 'assertVisible', selector: 'body' }] },
      { title: 'unknown action', steps: [{ order: 1, action: 'hover', selector: 'a' }, { order: 2, action: 'assertVisible', selector: 'a' }] },
      { title: 'other domain', steps: [{ order: 1, action: 'navigate', value: 'https://evil.test/' }, { order: 2, action: 'assertVisible', selector: 'body' }] },
      { title: 'no assert', steps: [{ order: 1, action: 'click', selector: '#a' }] },
      { steps: [] }
    ], mockDiscovery);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ title: 'ok', strategy: 'NORMAL', severity: 'MEDIUM', sourceType: 'SUGGESTED' });
  });

  it('shared components repeated on every page are tested once', async () => {
    const search = { selector: 'input[aria-label="검색"]', tag: 'input', type: 'email', label: '검색', required: true };
    const pages = ['/a', '/b', '/c'].map((p) => ({ url: `https://example.com${p}`, title: p, links: [], forms: 1, inputs: [search], buttons: [] }));
    const cases = await new RuleProvider().generateTestCases({ pages, networkEndpoints: [], consoleErrors: [] }, ['NORMAL', 'EXCEPTION']);
    expect(cases.filter((c) => c.strategy === 'NORMAL')).toHaveLength(3);
    expect(cases.filter((c) => c.strategy === 'EXCEPTION')).toHaveLength(1);
  });

  it('same-named fields on only some pages are still tested per page (could be different forms)', async () => {
    const email = { selector: 'input[name="email"]', tag: 'input', type: 'email', label: '이메일', required: true };
    const pages = [
      { url: 'https://example.com/users/new', title: 'u', links: [], forms: 1, inputs: [email], buttons: [] },
      { url: 'https://example.com/admins/new', title: 'a', links: [], forms: 1, inputs: [email], buttons: [] },
      { url: 'https://example.com/', title: 'home', links: [], forms: 0, inputs: [], buttons: [] }
    ];
    const cases = await new RuleProvider().generateTestCases({ pages, networkEndpoints: [], consoleErrors: [] }, ['EXCEPTION']);
    expect(cases).toHaveLength(2);
  });

  it('click-revealed screens replay the trigger before testing the form', async () => {
    const page = { url: 'https://example.com/', title: '목록 › 새 항목', links: [], forms: 1, buttons: [],
      inputs: [{ selector: '#name', tag: 'input', label: '이름', required: true }], trigger: { selector: 'button:has-text("새 항목") >> nth=0', label: '새 항목' } };
    const cases = await new RuleProvider().generateTestCases({ pages: [page], networkEndpoints: [], consoleErrors: [] }, ['EXCEPTION']);
    expect(cases[0]!.steps.map((s) => s.action)).toEqual(['navigate', 'assertStatus', 'click', 'input', 'assertInvalid']);
    expect(cases[0]!.steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('createAIProvider factory creates provider correctly', () => {
    const provider = createAIProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.generateTestCases).toBe('function');
  });
});
