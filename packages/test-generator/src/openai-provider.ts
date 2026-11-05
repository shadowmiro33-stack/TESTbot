import { PLATFORMS, SEVERITIES, STEP_ACTIONS, STRATEGIES, type DiscoveryResult, type TestStep, type TestStrategy } from '@autohands/shared';
import type { AIProvider, GeneratedCase } from './index.js';

export interface OpenAIOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAIProvider implements AIProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(options: OpenAIOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async generateTestCases(discovery: DiscoveryResult, strategies: TestStrategy[]): Promise<GeneratedCase[]> {
    if (!this.apiKey) {
      console.warn('[OpenAIProvider] OPENAI_API_KEY가 설정되지 않아 생성을 건너뜁니다.');
      return [];
    }

    const pagesSummary = discovery.pages.map((p) => ({
      url: p.url,
      title: p.title,
      inputs: p.inputs.map((i) => ({
        selector: i.selector,
        name: i.name,
        label: i.label,
        type: i.type,
        required: i.required,
        maxLength: i.maxLength,
      })),
      buttons: p.buttons.map((b) => ({
        selector: b.selector,
        label: b.label || b.name,
      })),
    }));

    const systemPrompt = `당신은 시니어 웹 QA 자동화 엔지니어입니다.
제공된 웹 서비스 탐색 구조(페이지, 폼 입력 필드, 버튼 등)를 바탕으로 신뢰할 수 있는 Playwright 자동화 테스트 케이스(TC)를 설계하십시오.

[생성 규칙]
1. 요청된 전략(${strategies.join(', ')})에 부합하는 실무적인 시나리오를 작성하십시오.
   - NORMAL: 핵심 비즈니스 기능(폼 입력 및 제출, 조회, 상세 진입 등) 정상 워크플로우
   - EXCEPTION: 잘못된 형식 입력, 빈 값 제출 시도, 서버 에러 유발 가능한 비정상 입력
   - BOUNDARY: 특수문자, 초과 길이, 최소/최대 제약 시나리오
   - PERMISSION / STATE: 권한 확인 또는 상태 전환 플로우
2. 각 step의 action은 다음 중 하나여야 합니다:
   - 'navigate' (value: URL)
   - 'input' (selector: 정확한 선택자, value: 입력값)
   - 'click' (selector: 버튼/링크 선택자)
   - 'assertVisible' (selector: 확인 대상 요소)
   - 'assertText' (selector: 확인 요소, value: 포함될 텍스트)
   - 'assertUrl' (value: 기대 URL 일부)
   - 'wait' (value: 대기 ms)
   - 'assertStatus' (value: 기대 HTTP 상태코드, 생략 시 400 미만)
   - 'assertInvalid' / 'assertValid' (selector: 입력 필드)
   - 'assertValueLength' (selector: 입력 필드, value: { "max": 숫자 } 또는 { "equals": 숫자 })
   그 외 action 은 사용하지 마십시오. 모든 케이스는 마지막에 최소 1개의 assert 단계를 포함해야 합니다.
   navigate URL 은 제공된 페이지와 같은 도메인이어야 합니다.
3. 출력은 반드시 다음 JSON 객체 형식이어야 합니다:
{
  "testCases": [
    {
      "platform": "PC_WEB",
      "strategy": "NORMAL",
      "title": "케이스 제목",
      "precondition": "사전 조건",
      "testData": { "sample": "value" },
      "steps": [
        { "order": 1, "action": "navigate", "value": "https://..." },
        { "order": 2, "action": "input", "selector": "#id", "value": "test" },
        { "order": 3, "action": "click", "selector": "button[type='submit']" },
        { "order": 4, "action": "assertVisible", "selector": ".success" }
      ],
      "expected": ["기대 결과 설명"],
      "severity": "HIGH",
      "sourceType": "SUGGESTED"
    }
  ]
}`;

    const userPrompt = `[발견된 페이지 및 UI 구조]:
${JSON.stringify(pagesSummary, null, 2)}

[요청 테스트 전략]:
${strategies.join(', ')}

위 구조를 기반으로 약 5~10개의 고부가가치 심층 테스트 케이스를 생성해 주세요.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[OpenAIProvider] API 응답 오류 (${response.status}):`, errorText);
        return [];
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content;
      if (!content) return [];

      const parsed = JSON.parse(content) as { testCases?: unknown[] };
      if (!Array.isArray(parsed.testCases)) return [];

      return normalizeAICases(parsed.testCases, discovery);
    } catch (error) {
      console.error('[OpenAIProvider] 테스트 케이스 생성 중 오류 발생:', error);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/**
 * LLM 응답을 신뢰하지 않고 정규화합니다.
 * - 정의되지 않은 strategy / severity / platform → 기본값 대체 (DB enum 오류 방지)
 * - 지원하지 않는 action 을 포함하거나 assert 단계가 없는 케이스 → 제외
 * - 탐색 대상과 다른 도메인으로 이동하는 케이스 → 제외
 */
export function normalizeAICases(raw: unknown[], discovery: DiscoveryResult): GeneratedCase[] {
  const origins = new Set(
    discovery.pages.map((p) => { try { return new URL(p.url).origin; } catch { return ''; } }).filter(Boolean)
  );
  const result: GeneratedCase[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const tc = item as Record<string, unknown>;
    const title = typeof tc.title === 'string' ? tc.title.trim() : '';
    if (!title || !Array.isArray(tc.steps) || !tc.steps.length) continue;

    const steps: TestStep[] = [];
    let valid = true;
    for (const [index, rawStep] of (tc.steps as unknown[]).entries()) {
      const step = (rawStep ?? {}) as Record<string, unknown>;
      if (!isOneOf(STEP_ACTIONS, step.action)) { valid = false; break; }
      if (step.action === 'navigate') {
        try {
          if (origins.size && !origins.has(new URL(String(step.value)).origin)) { valid = false; break; }
        } catch { valid = false; break; }
      }
      steps.push({
        order: typeof step.order === 'number' ? step.order : index + 1,
        action: step.action,
        selector: typeof step.selector === 'string' ? step.selector : undefined,
        value: step.value
      });
    }
    if (!valid || !steps.some((s) => s.action.startsWith('assert'))) continue;

    result.push({
      platform: isOneOf(PLATFORMS, tc.platform) ? tc.platform : 'PC_WEB',
      strategy: isOneOf(STRATEGIES, tc.strategy) ? tc.strategy : 'NORMAL',
      title,
      precondition: typeof tc.precondition === 'string' && tc.precondition ? tc.precondition : '기본 로그인 상태',
      testData: tc.testData && typeof tc.testData === 'object' ? (tc.testData as Record<string, unknown>) : undefined,
      steps,
      expected: Array.isArray(tc.expected) ? tc.expected.map(String) : [String(tc.expected ?? '')],
      severity: isOneOf(SEVERITIES, tc.severity) ? tc.severity : 'MEDIUM',
      sourceType: 'SUGGESTED',
      metadata: { ...(tc.metadata && typeof tc.metadata === 'object' ? (tc.metadata as Record<string, unknown>) : {}), generatedBy: 'openai' }
    });
  }
  return result;
}
