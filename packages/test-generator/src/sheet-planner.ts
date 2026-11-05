/**
 * QA 시나리오 시트의 한 줄(메뉴 경로 + 테스트 항목)을 실행 계획으로 바꿉니다.
 *
 * - 사람만 할 수 있는 항목(녹화·녹음, 카메라, 푸시, 다수 기기 동시 실행, CMS 대조 …)은 MANUAL → 결과 "테스트불가(NT)" + 사유
 * - 나머지는 메뉴 경로를 화면 텍스트로 따라가며 누르고(tapText), 테스트 항목에서 확인할 텍스트를 뽑아 검증합니다.
 *   · 따옴표로 적힌 문구("이미 배틀 콘텐츠에 참여 하셨습니다")는 강한 검증 → 없으면 실패(F)
 *   · 문장에서 추정한 대상("투표 버튼이 노출")은 약한 검증 → 없으면 재확인(check)
 *   · 확인할 대상을 뽑을 수 없으면 화면 캡처와 함께 재확인 요청(manualCheck)
 * 규칙으로 만든 계획은 AI(LLM)가 있으면 refineSheetPlansWithAI 로 보강할 수 있습니다.
 */
import { isPageMarker, isSituationLabel, type TestStep } from '@autohands/shared';
import { parseStepsText, planFromSteps } from './step-planner.js';

export type SheetPlan = { mode: 'AUTO' | 'MANUAL'; reason?: string; steps: TestStep[]; checks: string[] };
export type SheetPlanInput = { menuPath: string[]; item: string; caseType?: string; section?: string; stepsText?: string; precondition?: string };
/** "0023 선행 작업후 …" 처럼 다른 케이스를 먼저 수행해야 하는 경우, 그 케이스의 계획을 찾아 주는 함수 */
export type PlanResolver = (ref: string) => SheetPlan | undefined;

/** 기기 뒤로가기 */
const DEVICE_BACK = /디바이스\s*(이전|뒤로)|기기\s*(이전|뒤로)|백\s*키|뒤로\s*가기\s*(키)?$|하드웨어\s*(이전|뒤로)/;
/** 선행 케이스 참조: "0023선행 작업후 이전버튼 선택", "0037 선행 작업후 X버튼 선택" */
const PRECEDING = /^(\d{3,4})\s*선행\s*작업\s*(?:후|이후|뒤)?\s*(.*)$/;

/** 자동화할 수 없는 항목 판별 규칙 (앞에서부터 처음 걸리는 사유 사용) */
const MANUAL_RULES: Array<[RegExp, string]> = [
  [/동시\s*접속|과부하|부하\s*테스트|인코딩\s*서버|encoding\s*서버/i, '여러 기기 동시 실행(부하 테스트)이 필요한 항목'],
  [/녹화|녹음|마이크|이어폰|블루투스|가창|노래\s*(진행|부르는)/, '실제 녹화·녹음(노래 부르기)이 필요한 항목'],
  [/카메라|사진\s*촬영|촬영/, '기기 카메라 사용이 필요한 항목'],
  [/앨범에서\s*선택|디바이스\s*내\s*앨범|갤러리|사진첩/, '기기 사진첩 접근이 필요한 항목'],
  [/푸시|알림\s*메시지|노티/, '푸시 알림 수신 확인이 필요한 항목'],
  [/재부팅|비행기\s*모드|와이파이|wi-?fi|LTE|5G|네트워크\s*(끊|차단|전환)|백그라운드|전화\s*수신/i, '기기 상태(네트워크·전원 등) 변경이 필요한 항목'],
  [/CMS/i, 'CMS(관리자 화면)와 대조가 필요한 항목 — CMS 환경을 함께 등록하면 자동화 가능'],
  [/(iOS|IOS|아이폰).*(안드로이드|AOS|Android)|(안드로이드|AOS|Android).*(iOS|IOS|아이폰)/, '두 OS 기기 간 비교가 필요한 항목'],
  [/다른\s*(계정|유저|사용자)|타\s*계정|상대(방)?\s*(유저|계정)|두\s*명/, '다른 계정을 동시에 사용해야 하는 항목'],
  [/언어.*(설정|변경)|설정한\s*언어/, '기기 언어 설정 변경이 필요한 항목'],
  [/결제|구매|환불|이용권\s*(구매|결제)/, '실제 결제가 필요한 항목 (자동 실행 금지)']
];

const QUOTED = /["“”「」『』]([^"“”「」『』]{1,60})["“”「」『』]/g;
/** "투표 버튼이 노출", "VS 아이콘이 노출" 처럼 대상 + 요소 + 노출 */
const TARGET_VISIBLE = /([가-힣A-Za-z0-9+#&·]{1,20}(?:\s[가-힣A-Za-z0-9+#&·]{1,12}){0,2})\s*(버튼|탭|문구|텍스트|메뉴|라벨|타이틀|제목)(?:이|가|은|는|도)?\s*(노출|표시|보이|나타|활성)/g;
/** "프로필 편집 화면이 노출", "관련영상모두보기 페이지로 이동" */
const SCREEN_REACHED = /([가-힣A-Za-z0-9+#&·]{1,20}(?:\s[가-힣A-Za-z0-9+#&·]{1,12}){0,2})\s*(화면|페이지|팝업|창)(?:으로|로|이|가|에)?\s*(이동|노출|표시|진입|열리|뜨)/g;
const NEGATIVE = /(노출|표시|보이)\s*(안\s*되|되지\s*않|않|안)\b|(안\s*(보이|나오))|사라지/;
/** 확인 대상으로 쓰기에 너무 일반적인 말 */
const GENERIC = new Set(['해당', '각', '모든', '전체', '선택', '상세', '이전', '다음', '기존', '기본', '정상', '팝업', '화면', '페이지', '버튼', '이미지', '썸네일', '리스트', '목록', '콘텐츠', '해당곡의', '본인의', '보기', '없습니다', '있습니다', '노출', '표시', '이동', '창']);

/** 문장 끝쪽의 명사구만 남깁니다. 예) "참여 콘텐츠가 6개 이상인 경우 더보기" → "더보기", "해당곡의 파트별 선택" → "파트별 선택" */
const STOP_WORDS = new Set(['경우', '후', '시', '때', '및', '또는', '다시', '바로', '모두', '전부', '정상적으로', '해당', '각', '이후', '뒤', '중', '선택한', '노출된']);
const ENDS_WITH_PARTICLE = /(며|고|서|면|인|된|한|하는|되는|는|을|를|이|가|에|의|로|으로|에서|와|과|도|만)$/;
function cleanTarget(raw: string): string | null {
  const words = raw.trim().split(/\s+/);
  const kept: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]!;
    if (STOP_WORDS.has(w) || (kept.length > 0 && ENDS_WITH_PARTICLE.test(w)) || /^\d+개?$/.test(w)) break;
    kept.unshift(w);
    if (kept.length === 3) break;
  }
  const t = kept.join(' ').trim();
  if (!t || t.length < 2 || t.length > 30 || kept.every((w) => GENERIC.has(w))) return null;
  return t;
}

function manualReason(input: SheetPlanInput): string | undefined {
  const all = `${input.section ?? ''} ${input.menuPath.join(' ')} ${input.item}`;
  for (const [re, reason] of MANUAL_RULES) if (re.test(all)) return reason;
  const situation = input.menuPath.find((l) => isSituationLabel(l) && !PRECEDING.test(l.trim()));
  if (situation) return `사전 조건이 필요한 항목: "${situation}"`;
  return undefined;
}

/** 메뉴 라벨 하나 → 단계 (뒤로가기 / 화면 표시 확인 / 누르기) */
function labelStep(label: string): Omit<TestStep, 'order'> {
  if (DEVICE_BACK.test(label)) return { action: 'goBack', value: label, metadata: { phase: 'navigate' } };
  if (isPageMarker(label)) return { action: 'assertTextVisible', value: label, metadata: { phase: 'navigate', optional: true } };
  return { action: 'tapText', value: label, metadata: { phase: 'navigate' } };
}

export function planSheetCase(input: SheetPlanInput, resolve?: PlanResolver): SheetPlan {
  // "단계" 칸이 있는 시트(ISTQB 스킬에서 만든 시트 등)는 메뉴 경로 대신 단계 문장으로 실행
  if (input.stepsText?.trim()) {
    return planFromSteps({ steps: parseStepsText(input.stepsText), expectedResult: input.item, preconditions: input.precondition ? input.precondition.split(/\s*\/\s*|\n/) : [] });
  }
  const reason = manualReason(input);
  if (reason) return { mode: 'MANUAL', reason, steps: [], checks: [] };

  let steps: TestStep[] = [];
  const push = (step: Omit<TestStep, 'order'>) => steps.push({ order: steps.length + 1, ...step } as TestStep);

  // 1) 메뉴 경로 따라가기
  for (const label of input.menuPath) {
    const pre = PRECEDING.exec(label.trim());
    if (pre) {
      // 선행 케이스의 이동 단계를 그대로 수행한 뒤 나머지 동작
      const ref = resolve?.(pre[1]!);
      if (!ref) return { mode: 'MANUAL', reason: `선행 케이스 ${pre[1]} 을(를) 시트에서 찾을 수 없는 항목`, steps: [], checks: [] };
      if (ref.mode === 'MANUAL') return { mode: 'MANUAL', reason: `선행 케이스 ${pre[1]} 이(가) 사람 확인 항목: ${ref.reason ?? ''}`.trim(), steps: [], checks: [] };
      steps = ref.steps.filter((s) => (s.metadata as { phase?: string } | undefined)?.phase === 'navigate').map((s, i) => ({ ...s, order: i + 1 }));
      const rest = pre[2]!.trim();
      if (rest) push(labelStep(rest));
      continue;
    }
    push(labelStep(label));
  }

  // 2) 테스트 항목에서 확인할 텍스트 추출
  const item = input.item.replace(/\s+/g, ' ');
  const negate = NEGATIVE.test(item);
  const checks: string[] = [];
  // 메뉴 경로에서 누른 버튼 이름을 항목에서 다시 인용한 경우("<" 이전버튼 선택 시 …)는 기대 결과가 아니라 동작 설명 → 제외
  const pathText = input.menuPath.join(' ').replace(/\s+/g, ' ');
  const quoted = [...new Set([...item.matchAll(QUOTED)].map((m) => m[1]!.trim()).filter(Boolean))].filter((q) => !pathText.includes(q));
  for (const q of quoted) {
    // "보이지 않아야 함"은 대개 앞선 동작(팔로우 후 사라짐 등)을 전제로 하므로 약한 검증으로 취급 (오탐 실패 방지)
    push({ action: 'assertTextVisible', value: q, metadata: { phase: 'verify', strength: negate ? 'weak' : 'strong', negate } });
    checks.push(`${negate ? '보이지 않음' : '보임'}: "${q}"`);
  }
  if (!quoted.length) {
    const targets = new Set<string>();
    for (const re of [TARGET_VISIBLE, SCREEN_REACHED]) {
      for (const m of item.matchAll(re)) { const t = cleanTarget(m[1]!); if (t) targets.add(t); }
    }
    for (const t of [...targets].slice(0, 3)) {
      push({ action: 'assertTextVisible', value: t, metadata: { phase: 'verify', strength: 'weak', negate } });
      checks.push(`${negate ? '보이지 않음(추정)' : '보임(추정)'}: ${t}`);
    }
  }
  // 3) 자동으로 판정할 근거가 없으면 사람 확인 요청 (메뉴 이동은 자동으로 하고 화면을 캡처해 둠)
  if (!checks.length) push({ action: 'manualCheck', value: input.item, metadata: { phase: 'verify' } });

  return { mode: 'AUTO', steps, checks };
}

// ── AI 보강 (선택) ─────────────────────────────────────────────────────────────

export type AIPlanRequest = { key: string; menuPath: string[]; item: string };
type AIPlanAnswer = {
  key: string;
  manualReason?: string | null;
  navigation?: Array<{ label: string; kind: 'tap' | 'screen' | 'skip' }>;
  checks?: Array<{ text: string; negate?: boolean; strength?: 'strong' | 'weak' }>;
};

/**
 * 규칙으로 판정 근거를 못 찾은 케이스를 AI 로 보강합니다. (OPENAI_API_KEY 가 있을 때만)
 * AI 에게는 메뉴 경로와 테스트 항목만 보내고, 응답은 허용된 단계로만 다시 조립합니다.
 */
export async function refineSheetPlansWithAI(
  requests: AIPlanRequest[],
  context: { notes?: string; screenTexts?: string[] } = {},
  options: { apiKey?: string; model?: string; baseUrl?: string; batchSize?: number } = {}
): Promise<Map<string, SheetPlan>> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const out = new Map<string, SheetPlan>();
  if (!apiKey || !requests.length) return out;
  const model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const batchSize = options.batchSize ?? 25;

  const system = `당신은 모바일 앱·웹 QA 자동화 엔지니어입니다. QA 시트의 각 행(메뉴 경로 + 테스트 항목)을 화면 텍스트 기반 자동화 계획으로 바꿉니다.
규칙:
- navigation: 메뉴 경로의 각 라벨을 화면에서 누를 텍스트(kind:"tap"), 도착 화면 표시(kind:"screen"), 화면 요소가 아닌 설명(kind:"skip")으로 분류. label 은 화면에 실제로 보일 짧은 텍스트로 정리(예: '곡 선택 "사랑비"' → '사랑비', '프로필이미지변경 버튼' → '프로필 이미지 변경').
- checks: 테스트 항목이 기대하는 결과를 화면에 보이는(또는 보이지 않아야 하는) 짧은 텍스트로 표현. 문구가 그대로 적혀 있으면 strength:"strong", 추정이면 "weak". 아이콘·이미지·숫자 비교처럼 텍스트로 확인할 수 없으면 checks 를 비움.
- 녹화/녹음/카메라/푸시/다수 기기/CMS 대조/결제처럼 사람이 해야 하는 항목은 manualReason 에 짧게 사유.
- 출력: {"plans":[{"key":"...","manualReason":null,"navigation":[...],"checks":[...]}]} JSON 만.`;

  for (let i = 0; i < requests.length; i += batchSize) {
    const batch = requests.slice(i, i + batchSize);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify({ notes: context.notes?.slice(0, 2000), screenTexts: context.screenTexts?.slice(0, 300), rows: batch }) }
          ]
        })
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as { plans?: AIPlanAnswer[] };
      for (const answer of parsed.plans ?? []) {
        if (!batch.some((b) => b.key === answer.key)) continue;
        const plan = planFromAI(answer);
        if (plan) out.set(answer.key, plan);
      }
    } catch {
      /* AI 실패 시 규칙 계획 유지 */
    }
  }
  return out;
}

const str = (v: unknown, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function planFromAI(answer: AIPlanAnswer): SheetPlan | null {
  const reason = str(answer.manualReason, 120);
  if (reason) return { mode: 'MANUAL', reason: `${reason} (AI 판단)`, steps: [], checks: [] };
  const steps: TestStep[] = [];
  const push = (step: Omit<TestStep, 'order'>) => steps.push({ order: steps.length + 1, ...step } as TestStep);
  for (const nav of Array.isArray(answer.navigation) ? answer.navigation.slice(0, 8) : []) {
    const label = str(nav?.label, 40);
    if (!label || nav.kind === 'skip') continue;
    if (nav.kind === 'screen') push({ action: 'assertTextVisible', value: label, metadata: { phase: 'navigate', optional: true } });
    else push({ action: 'tapText', value: label, metadata: { phase: 'navigate' } });
  }
  const checks: string[] = [];
  for (const c of Array.isArray(answer.checks) ? answer.checks.slice(0, 5) : []) {
    const t = str(c?.text, 60);
    if (!t) continue;
    const strength = c.strength === 'strong' ? 'strong' : 'weak';
    push({ action: 'assertTextVisible', value: t, metadata: { phase: 'verify', strength, negate: Boolean(c.negate), source: 'ai' } });
    checks.push(`${c.negate ? '보이지 않음' : '보임'}${strength === 'weak' ? '(추정)' : ''}: ${t}`);
  }
  if (!steps.length) return null;
  if (!checks.length) push({ action: 'manualCheck', value: '자동 판정 근거 없음', metadata: { phase: 'verify' } });
  return { mode: 'AUTO', steps, checks };
}
