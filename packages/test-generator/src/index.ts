import type { DiscoveredControl, DiscoveryResult, DiscoveryTrigger, Platform, TestStep, TestStrategy } from '@autohands/shared';
import { OpenAIProvider } from './openai-provider.js';
import { HybridProvider } from './hybrid-provider.js';

export type GeneratedCase = {
  platform: Platform;
  strategy: TestStrategy;
  title: string;
  precondition: string;
  testData?: Record<string, unknown>;
  steps: TestStep[];
  expected: string[];
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  sourceType: 'DIRECT' | 'DERIVED' | 'SUGGESTED' | 'DISCOVERED';
  metadata?: Record<string, unknown>;
};

export interface AIProvider {
  generateTestCases(discovery: DiscoveryResult, strategies: TestStrategy[]): Promise<GeneratedCase[]>;
}

const TEXT_LIKE_TYPES = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'password']);
function isTextLike(input: DiscoveredControl) {
  return input.tag === 'textarea' || (input.tag === 'input' && TEXT_LIKE_TYPES.has(input.type ?? ''));
}
/** EXCEPTION 케이스에 사용할 잘못된 값. 브라우저가 판정할 수 없는 필드는 undefined */
function exceptionValueFor(input: DiscoveredControl): string | undefined {
  if (input.tag === 'select' || ['checkbox', 'radio', 'file', 'submit', 'button', 'hidden'].includes(input.type ?? '')) return undefined;
  if (input.type === 'email') return 'not-an-email';
  if (input.type === 'url') return 'not a url';
  if (input.required) return '';
  return undefined;
}

/** navigate(+assertStatus) 바로 뒤에 트리거 클릭을 넣고 order 를 다시 매깁니다. */
export function withTrigger(steps: TestStep[], trigger: DiscoveryTrigger): TestStep[] {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  let insertAt = sorted.findIndex((s) => s.action === 'navigate') + 1;
  if (sorted[insertAt]?.action === 'assertStatus') insertAt++;
  sorted.splice(insertAt, 0, { order: 0, action: 'click', selector: trigger.selector, metadata: { trigger: trigger.label } });
  return sorted.map((s, i) => ({ ...s, order: i + 1 }));
}

export class RuleProvider implements AIProvider {
  async generateTestCases(discovery: DiscoveryResult, strategies: TestStrategy[]): Promise<GeneratedCase[]> {
    const cases: GeneratedCase[] = [];
    // 모든 페이지에 똑같이 나오는 입력(헤더 검색창 등 공통 컴포넌트)은 처음 나온 페이지에서 한 번만 검증.
    // (일부 페이지에만 있는 같은 이름의 필드는 서로 다른 폼일 수 있으므로 각각 검증)
    const keyOf = (input: DiscoveredControl) =>
      [input.selector, input.label || input.name || '', input.type ?? '', input.required ? 'r' : '', input.maxLength ?? '', input.min ?? '', input.max ?? ''].join('|');
    const pagesWithControl = new Map<string, number>();
    for (const page of discovery.pages) {
      if (page.trigger) continue;
      for (const key of new Set(page.inputs.map(keyOf))) pagesWithControl.set(key, (pagesWithControl.get(key) ?? 0) + 1);
    }
    const plainPages = discovery.pages.filter((p) => !p.trigger).length;
    const isGlobalControl = (input: DiscoveredControl) => plainPages >= 2 && pagesWithControl.get(keyOf(input)) === plainPages;
    const testedGlobal = new Set<string>();
    // 여러 페이지가 같은 <title> 을 쓰면 TC 이름이 구분되지 않으므로 경로를 덧붙임
    const titleCount = new Map<string, number>();
    for (const page of discovery.pages) titleCount.set(page.title, (titleCount.get(page.title) ?? 0) + 1);
    const pageName = (page: { title: string; url: string; trigger?: unknown }) => {
      if (!page.title) return page.url;
      if ((titleCount.get(page.title) ?? 0) < 2 || page.trigger) return page.title;
      try { const u = new URL(page.url); return `${page.title} (${u.pathname}${u.search})`; } catch { return `${page.title} (${page.url})`; }
    };

    for (const page of discovery.pages) {
      const firstCaseOfPage = cases.length;
      if (strategies.includes('NORMAL')) {
        cases.push({
          platform: 'PC_WEB',
          strategy: 'NORMAL',
          title: `${pageName(page)} 페이지 정상 접근`,
          precondition: '유효한 계정으로 로그인',
          steps: [
            { order: 1, action: 'navigate', value: page.url },
            { order: 2, action: 'assertStatus' },
            { order: 3, action: 'assertVisible', selector: 'body' }
          ],
          expected: ['페이지가 HTTP 오류(4xx/5xx) 없이 표시된다.'],
          severity: 'HIGH',
          sourceType: 'DISCOVERED'
        });
      }

      for (const input of page.inputs) {
        const label = input.label || input.name || input.selector;
        if (!page.trigger && isGlobalControl(input)) {
          if (testedGlobal.has(keyOf(input))) continue;
          testedGlobal.add(keyOf(input));
        }

        const invalidValue = exceptionValueFor(input);
        if (strategies.includes('EXCEPTION') && invalidValue !== undefined) {
          cases.push({
            platform: 'PC_WEB',
            strategy: 'EXCEPTION',
            title: `${label} ${invalidValue === '' ? '빈 값' : '형식 오류 값'} 입력 검증`,
            precondition: `${pageName(page)} 페이지 접근`,
            testData: { value: invalidValue },
            steps: [
              { order: 1, action: 'navigate', value: page.url },
              { order: 2, action: 'assertStatus' },
              { order: 3, action: 'input', selector: input.selector, value: invalidValue },
              { order: 4, action: 'assertInvalid', selector: input.selector }
            ],
            expected: [
              invalidValue === ''
                ? '필수 입력 필드가 빈 값을 유효하지 않은 값으로 판정한다.'
                : '형식에 맞지 않는 값을 유효하지 않은 값으로 판정한다.',
              '서버 오류(5xx) 응답이 발생하지 않는다.'
            ],
            severity: 'MEDIUM',
            sourceType: 'DERIVED',
            // 브라우저/aria 기준 클라이언트 검증만 확인하므로 서버측 검증 정책은 별도 확인이 필요
            metadata: { validationScope: 'client' }
          });
        }

        if (strategies.includes('BOUNDARY') && input.maxLength && isTextLike(input)) {
          for (const size of [Math.max(0, input.maxLength - 1), input.maxLength, input.maxLength + 1]) {
            const overLimit = size > input.maxLength;
            cases.push({
              platform: 'PC_WEB',
              strategy: 'BOUNDARY',
              title: `${label} ${size}자 경계값`,
              precondition: `${pageName(page)} 페이지 접근`,
              testData: { size },
              steps: [
                { order: 1, action: 'navigate', value: page.url },
                { order: 2, action: 'assertStatus' },
                { order: 3, action: 'input', selector: input.selector, value: '가'.repeat(size) },
                overLimit
                  ? { order: 4, action: 'assertValueLength', selector: input.selector, value: { max: input.maxLength } }
                  : { order: 4, action: 'assertValueLength', selector: input.selector, value: { equals: size } }
              ],
              expected: [
                overLimit
                  ? `${input.maxLength}자를 초과한 입력이 필드에 남지 않는다.`
                  : `${size}자 입력이 그대로 유지된다.`
              ],
              severity: 'MEDIUM',
              sourceType: 'DERIVED'
            });
          }
        }

        if (strategies.includes('BOUNDARY') && input.type === 'number') {
          const min = input.min !== undefined && input.min !== '' ? Number(input.min) : undefined;
          const max = input.max !== undefined && input.max !== '' ? Number(input.max) : undefined;
          const probes: Array<{ value: number; valid?: boolean }> = [];
          if (min !== undefined && Number.isFinite(min)) probes.push({ value: min - 1, valid: false }, { value: min, valid: true });
          if (max !== undefined && Number.isFinite(max)) probes.push({ value: max, valid: true }, { value: max + 1, valid: false });
          // 범위가 정의되지 않은 경우: 실행은 하되 기대 동작은 정책 확인 대상으로 분류
          if (!probes.length) probes.push({ value: -1 }, { value: 0 }, { value: 1 });

          for (const probe of probes) {
            const steps: TestStep[] = [
              { order: 1, action: 'navigate', value: page.url },
              { order: 2, action: 'assertStatus' },
              { order: 3, action: 'input', selector: input.selector, value: probe.value }
            ];
            steps.push(
              probe.valid !== undefined
                ? { order: 4, action: probe.valid ? 'assertValid' : 'assertInvalid', selector: input.selector }
                // 기준이 없으므로 화면 깨짐 없이 필드가 유지되는지만 확인 (결과는 REQUIREMENT_CHECK 로 분류)
                : { order: 4, action: 'assertVisible', selector: input.selector }
            );
            cases.push({
              platform: 'PC_WEB',
              strategy: 'BOUNDARY',
              title: `${label} 숫자 경계값 ${probe.value}`,
              precondition: `${pageName(page)} 페이지 접근`,
              testData: { value: probe.value, min, max },
              steps,
              expected: [
                probe.valid === undefined
                  ? '허용 범위가 정의되지 않아 처리 정책 확인이 필요하다.'
                  : probe.valid
                    ? `${probe.value}은(는) 허용 범위 안의 값으로 처리된다.`
                    : `${probe.value}은(는) 허용 범위를 벗어난 값으로 판정된다.`
              ],
              severity: 'MEDIUM',
              sourceType: probe.valid === undefined ? 'SUGGESTED' : 'DERIVED',
              metadata: { requirementCheck: probe.valid === undefined }
            });
          }
        }
      }
      // 버튼 클릭으로 열리는 화면이면, 페이지 진입 직후 해당 버튼 클릭 단계를 넣어 같은 화면을 재현
      if (page.trigger) {
        for (const tc of cases.slice(firstCaseOfPage)) tc.steps = withTrigger(tc.steps, page.trigger);
      }
    }

    return cases;
  }
}

export { OpenAIProvider } from './openai-provider.js';
export { HybridProvider } from './hybrid-provider.js';

export function createAIProvider(): AIProvider {
  if (process.env.OPENAI_API_KEY) {
    return new HybridProvider();
  }
  return new RuleProvider();
}
export { planSheetCase, refineSheetPlansWithAI, planFromAI, type SheetPlan, type SheetPlanInput, type AIPlanRequest, type PlanResolver } from './sheet-planner.js';
export { planFromSteps, parseStepsText, formatStepsText, menuPathFromSteps, type CaseStep, type StepCaseInput } from './step-planner.js';
