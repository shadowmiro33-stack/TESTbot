/**
 * 단계가 문장으로 적힌 테스트 케이스(ISTQB 기법 기반 TC 작성 스킬의 test-cases.json 등)를 실행 계획으로 바꿉니다.
 *
 * 표기 규칙 (TC 작성 시 이렇게 쓰면 자동 실행됩니다)
 * - 화면·버튼·필드 이름은 「 」  예) 「마이페이지」 탭을 누른다, 「닉네임」 필드에 입력한다 (data: 테스터)
 * - 화면에 실제로 표시되는 문구는 " "  예) "이미 사용 중인 닉네임입니다" 문구가 표시된다
 *
 * 판정 규칙
 * - 기대 결과의 " " 문구 → 강한 검증(없으면 실패), 「 」 화면 이름 → 약한 검증(없으면 재확인)
 * - "~되지 않는다/표시되지 않는다" → 보이지 않아야 함(약한 검증)
 * - 로그인 외의 사전 조건이 있으면 자동으로 준비하지 못하므로 강한 검증도 약하게(실패 대신 재확인)
 * - 해석하지 못한 단계가 나오면 그 앞까지만 실행하고 사람 확인으로 넘김 (잘못된 실패 방지)
 * - HTTP 상태·DB 상태만 확인하는 케이스, 녹화·카메라·결제 같은 항목은 테스트불가(NT) + 사유
 */
import type { TestStep } from '@autohands/shared';
import type { SheetPlan } from './sheet-planner.js';

export type CaseStep = { action: string; data?: string | null };
export type StepCaseInput = {
  steps: CaseStep[];
  expectedResult: string;
  preconditions?: string[];
  isNegative?: boolean;
  technique?: string;
};

const NAME = /「([^」]{1,60})」/g;
const SHOWN = /["“”]([^"“”]{1,80})["“”]/g;
const TAP = /(누른다|누르고|클릭한다|탭한다|터치한다|선택한다|진입한다|연다|펼친다|이동한다|들어간다|제출한다|전송한다|저장한다|닫는다)/;
const FILL = /(입력한다|작성한다|기입한다|채운다|붙여\s*넣는다|변경한다)/;
const BACK = /뒤로\s*가기|뒤로가기|이전\s*화면으로\s*(돌아간다|이동한다)|백\s*(버튼|키)|기기의?\s*(이전|뒤로)/;
const CHECK_STEP = /(확인한다|본다|살펴본다)/;
const LOGIN = /로그인한다|로그인\s*상태|로그인된|로그인 되어/;
const WAIT = /(\d+)\s*초\s*(동안\s*)?(기다린다|대기한다)/;
const URL_RE = /https?:\/\/[^\s"'」]+/;
const NEGATIVE = /(표시|노출|생성|이동|저장|전송|활성화|보이)(되지|하지)\s*않|나타나지\s*않|사라진다|비활성/;
const API_ONLY = /\b[1-5]\d{2}\b|응답 (코드|본문|필드)|반환한다|DB|데이터베이스|레코드|로그에|이벤트가 (기록|전송)/;

/** 사람만 할 수 있는 항목 */
const MANUAL_RULES: Array<[RegExp, string]> = [
  [/동시\s*(접속|요청)|부하|과부하|성능|응답\s*시간|TPS/i, '부하·성능 측정이 필요한 항목 — 성능 테스트 도구로 확인'],
  [/녹화|녹음|마이크/, '실제 녹화·녹음이 필요한 항목'],
  [/카메라|촬영/, '기기 카메라 사용이 필요한 항목'],
  [/사진첩|갤러리|앨범에서/, '기기 사진첩 접근이 필요한 항목'],
  [/푸시|알림을 수신|이메일을 수신|문자(를)? 수신|SMS/i, '외부 알림(푸시·메일·문자) 수신 확인이 필요한 항목'],
  [/네트워크|오프라인|비행기\s*모드|재부팅|백그라운드/, '기기 상태(네트워크·전원 등) 변경이 필요한 항목'],
  [/결제|환불|송금|출금/, '실제 결제·송금이 필요한 항목 (자동 실행 금지)'],
  [/다른 (계정|사용자)|두 (계정|사용자)|동시에 (두|여러)/, '여러 계정을 동시에 사용해야 하는 항목'],
  [/서버를? (중지|재시작)|장애를? (주입|발생)|타임아웃을 (발생|유발)/, '서버 장애 주입이 필요한 항목']
];

const names = (s: string) => [...s.matchAll(NAME)].map((m) => m[1]!.trim()).filter(Boolean);
const shown = (s: string) => [...s.matchAll(SHOWN)].map((m) => m[1]!.trim()).filter(Boolean);
/** "age=13" → "13", 그 외는 그대로 */
const dataValue = (data?: string | null) => {
  if (data === undefined || data === null) return undefined;
  const m = /^\s*[\w.\-가-힣 ]{1,30}\s*=\s*(.*)$/s.exec(String(data));
  return (m ? m[1]! : String(data)).trim();
};
const dataKey = (data?: string | null) => /^\s*([\w.\-가-힣 ]{1,30})\s*=/.exec(String(data ?? ''))?.[1]?.trim();

export function planFromSteps(input: StepCaseInput): SheetPlan {
  const pre = (input.preconditions ?? []).filter(Boolean);
  const allText = `${input.steps.map((s) => `${s.action} ${s.data ?? ''}`).join(' ')} ${input.expectedResult} ${pre.join(' ')}`;
  for (const [re, reason] of MANUAL_RULES) if (re.test(allText)) return { mode: 'MANUAL', reason, steps: [], checks: [] };

  const expected = input.expectedResult.replace(/\s+/g, ' ').trim();
  const expShown = shown(expected);
  const expNames = names(expected);
  if (!expShown.length && !expNames.length && API_ONLY.test(expected)) {
    return { mode: 'MANUAL', reason: 'API 응답·저장 상태를 확인하는 항목 — 화면 실행 대상이 아님 (API 테스트로 확인)', steps: [], checks: [] };
  }

  const steps: TestStep[] = [];
  const notes: string[] = [];
  const push = (step: Omit<TestStep, 'order'>) => steps.push({ order: steps.length + 1, ...step } as TestStep);
  let stoppedAt: string | undefined;

  for (const s of input.steps) {
    const action = s.action.replace(/\s+/g, ' ').trim();
    const refs = names(action).concat(shown(action));
    const url = URL_RE.exec(`${action} ${s.data ?? ''}`)?.[0];
    const wait = WAIT.exec(action);
    if (url && /(접속|열|방문|이동)/.test(action)) { push({ action: 'navigate', value: url, metadata: { phase: 'navigate' } }); continue; }
    if (wait) { push({ action: 'wait', value: Number(wait[1]) * 1000, metadata: { phase: 'navigate' } }); continue; }
    if (BACK.test(action)) { push({ action: 'goBack', value: action, metadata: { phase: 'navigate' } }); continue; }
    if (FILL.test(action)) {
      const label = refs[0] ?? dataKey(s.data);
      const value = dataValue(s.data) ?? shown(action)[1];
      if (label && value !== undefined) { push({ action: 'fillText', value: label, metadata: { phase: 'navigate', data: value } }); continue; }
    }
    if (refs.length && TAP.test(action)) { for (const r of refs.slice(0, 1)) push({ action: 'tapText', value: r, metadata: { phase: 'navigate' } }); continue; }
    if (refs.length && CHECK_STEP.test(action)) { for (const r of refs.slice(0, 2)) push({ action: 'assertTextVisible', value: r, metadata: { phase: 'navigate', strength: 'weak' } }); continue; }
    if (LOGIN.test(action) && !refs.length) { notes.push('로그인 단계는 등록된 계정으로 자동 처리'); continue; }
    stoppedAt = action;
    break;
  }

  if (stoppedAt) {
    // 해석하지 못한 단계 이후는 실행하지 않음 → 그 화면을 캡처해 사람 확인
    push({ action: 'manualCheck', value: `자동화하지 못한 단계: "${stoppedAt}" — 이후 단계와 기대 결과(${expected.slice(0, 120)})는 사람이 확인`, metadata: { phase: 'verify' } });
    return { mode: 'AUTO', steps, checks: [] };
  }

  // 기대 결과 → 검증
  const negate = NEGATIVE.test(expected);
  const unpreparedPre = pre.filter((p) => !LOGIN.test(p) && !/계정|회원|사용자로/.test(p));
  const checks: string[] = [];
  const pathRefs = new Set(steps.map((s) => String(s.value)));
  for (const t of expShown) {
    const strength = negate || unpreparedPre.length ? 'weak' : 'strong';
    push({ action: 'assertTextVisible', value: t, metadata: { phase: 'verify', strength, negate } });
    checks.push(`${negate ? '보이지 않음' : '보임'}${strength === 'weak' ? '(추정)' : ''}: "${t}"`);
  }
  for (const t of expNames.filter((n) => !pathRefs.has(n))) {
    push({ action: 'assertTextVisible', value: t, metadata: { phase: 'verify', strength: 'weak', negate } });
    checks.push(`${negate ? '보이지 않음' : '보임'}(추정): 「${t}」`);
  }
  if (!checks.length) push({ action: 'manualCheck', value: expected, metadata: { phase: 'verify' } });
  if (unpreparedPre.length && checks.length) notes.push(`사전 조건(${unpreparedPre.join(', ').slice(0, 80)})은 자동으로 준비하지 못해 실패 대신 재확인으로 판정`);
  if (notes.length) steps[0] && (steps[0].metadata = { ...(steps[0].metadata ?? {}), notes });
  return { mode: 'AUTO', steps, checks };
}

/** 시트의 "단계" 칸 텍스트("1. 「마이페이지」 탭을 누른다 [data]" 줄 목록) → 단계 배열 */
export function parseStepsText(text: string): CaseStep[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(.*?)\s*\[(.*)\]\s*$/.exec(line);
      return m ? { action: m[1]!, data: m[2]! } : { action: line };
    });
}

/** 단계 배열 → 시트 "단계" 칸 텍스트 */
export function formatStepsText(steps: CaseStep[]): string {
  // 빈 값 입력("")도 단계에 남기기 위해 data 가 있으면 빈 문자열이라도 [ ] 로 표기
  return steps.map((s, i) => `${i + 1}. ${s.action}${s.data !== undefined && s.data !== null ? ` [${s.data}]` : ''}`).join('\n');
}

/** 단계에서 화면 경로(1~6Depth)로 쓸 이름들 */
export function menuPathFromSteps(steps: CaseStep[]): string[] {
  const path: string[] = [];
  for (const s of steps) {
    if (!TAP.test(s.action) && !FILL.test(s.action)) continue;
    const ref = names(s.action)[0] ?? shown(s.action)[0];
    if (ref && path[path.length - 1] !== ref) path.push(ref);
  }
  return path.slice(0, 6);
}
