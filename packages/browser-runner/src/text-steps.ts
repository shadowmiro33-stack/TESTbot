/**
 * 텍스트 기반 단계 실행 (웹·앱 공통)
 * tapText / assertTextVisible / fillText / goBack / manualCheck 를 "드라이버"(웹: Playwright, 앱: Appium)에 맞춰 수행합니다.
 *
 * 찾는 순서 (요소를 못 찾았을 때)
 *   1) 잠시 기다리며 다시 찾기 (화면 로딩)
 *   2) 흔한 팝업(권한 요청·공지·광고) 닫기 → 다시 찾기
 *   3) 아래로 스크롤하며 찾기 (최대 QA_MAX_SCROLLS 회) → 못 찾으면 원래 위치로 되돌림
 *
 * 판정 규칙
 * - 메뉴 경로 요소를 못 찾음(tapText 실패)      → NAV_NOT_FOUND → 결과 "재확인" (경로 표기와 실제 화면 문구가 다를 수 있음)
 * - 강한 검증(따옴표 문구) 실패                 → 결과 "실패"
 * - 약한 검증(문장에서 추정한 대상) 실패         → 결과 "재확인" (사유 기록, 다음 단계 계속)
 * - [p] 화면 표시 미확인(optional)               → 기록만 하고 계속
 * - manualCheck                                  → 결과 "재확인" (자동 판정 근거 없음, 화면 캡처 첨부)
 */
import { labelCandidates, type TestStep } from '@autohands/shared';

export const NAV_NOT_FOUND = 'NAV_NOT_FOUND';
export const TEXT_ACTIONS = new Set(['tapText', 'assertTextVisible', 'goBack', 'manualCheck', 'fillText']);

export interface TextDriver {
  /** 후보 텍스트 중 지금 화면에 보이는 첫 요소를 누르고, 누른 텍스트를 반환 (없으면 null). 기다리지 않음 */
  tapOnce(candidates: string[]): Promise<string | null>;
  /** 후보 텍스트 중 하나라도 지금 화면에 보이는지. 기다리지 않음 */
  visibleOnce(candidates: string[]): Promise<boolean>;
  /** 후보 이름(라벨·placeholder·힌트) 중 지금 찾은 입력 칸에 값을 넣고, 찾은 이름을 반환 (없으면 null) */
  fillOnce(candidates: string[], value: string): Promise<string | null>;
  goBack(): Promise<void>;
  /** 한 화면 분량 스크롤. 더 움직일 수 없으면 false */
  scroll?(direction: 'down' | 'up'): Promise<boolean>;
  /** 흔한 팝업(권한 요청·공지·광고)을 닫았으면 닫은 버튼 문구, 없으면 null */
  dismissPopup?(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
}

export type TextStepState = {
  /** 사람 확인이 필요한 사유 (있으면 최종 결과는 재확인) */
  review: string[];
  /** 참고 기록 (결과에 영향 없음) */
  notes: string[];
};
export const newTextState = (): TextStepState => ({ review: [], notes: [] });

const TAP_TIMEOUT = Number(process.env.QA_TEXT_TIMEOUT_MS ?? 6000) || 6000;
const MAX_SCROLLS = Math.max(0, Math.min(20, Number(process.env.QA_MAX_SCROLLS ?? 6) || 0));
const POLL_MS = 300;

/**
 * 요소 찾기 공통 로직: 기다리기 → 팝업 닫기 → 스크롤
 * @param allowScroll false 면 스크롤하지 않음 (보이지 않아야 함 검사 등)
 */
export async function locate<T>(driver: TextDriver, attempt: () => Promise<T | null>, timeoutMs: number, state?: TextStepState, opts: { scroll?: boolean; popups?: boolean } = {}): Promise<T | null> {
  const allowScroll = opts.scroll !== false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await attempt();
    if (found) return found;
    if (Date.now() >= deadline) break;
    await driver.sleep(POLL_MS);
  }
  if (driver.dismissPopup && opts.popups !== false) {
    for (let i = 0; i < 3; i++) {
      const closed = await driver.dismissPopup().catch(() => null);
      if (!closed) break;
      state?.notes.push(`팝업 "${closed}" 닫음`);
      await driver.sleep(500);
      const found = await attempt();
      if (found) return found;
    }
  }
  if (!allowScroll || !driver.scroll || MAX_SCROLLS === 0) return null;
  let moved = 0;
  while (moved < MAX_SCROLLS) {
    // false = "더 내려갈 수 없음" (마지막으로 움직인 화면은 확인한 뒤 멈춤)
    const more = await driver.scroll('down').catch(() => false);
    moved++;
    await driver.sleep(400);
    const found = await attempt();
    if (found) {
      state?.notes.push(`스크롤 ${moved}회 후 찾음`);
      return found;
    }
    if (!more) break;
  }
  // 못 찾으면 원래 위치로
  for (let i = 0; i < moved; i++) if (!(await driver.scroll('up').catch(() => false))) break;
  return null;
}

export async function runTextStep(driver: TextDriver, step: TestStep, state: TextStepState): Promise<void> {
  const value = String(step.value ?? '').trim();
  const meta = (step.metadata ?? {}) as { optional?: boolean; strength?: 'strong' | 'weak'; negate?: boolean; data?: unknown };
  switch (step.action) {
    case 'tapText': {
      const candidates = labelCandidates(value);
      const tapped = await locate(driver, () => driver.tapOnce(candidates), TAP_TIMEOUT, state);
      if (!tapped) throw new Error(`${NAV_NOT_FOUND}: 메뉴 경로 '${value}' 을(를) 화면에서 찾지 못했습니다. (찾아본 문구: ${candidates.map((c) => `"${c}"`).join(', ')})`);
      if (tapped !== value) state.notes.push(`'${value}' → "${tapped}" 누름`);
      return;
    }
    case 'assertTextVisible': {
      const strong = meta.strength === 'strong';
      const candidates = strong ? [value] : labelCandidates(value);
      const check = async () => ((await driver.visibleOnce(candidates)) ? true : null);
      // "보이지 않아야 함"은 지금 화면만 확인 (스크롤·팝업 닫기로 상태를 바꾸지 않음)
      const visible = meta.negate
        ? Boolean(await locate(driver, check, 1500, undefined, { scroll: false, popups: false }))
        : Boolean(await locate(driver, check, strong ? TAP_TIMEOUT : Math.round(TAP_TIMEOUT * 0.7), state, { scroll: !meta.optional }));
      const ok = meta.negate ? !visible : visible;
      if (ok) return;
      if (meta.optional) { state.notes.push(`화면 표시 '${value}' 은(는) 확인하지 못함 (계속 진행)`); return; }
      const what = meta.negate ? `보이지 않아야 할 '${value}' 이(가) 화면에 보입니다` : `'${value}' 이(가) 화면에 보이지 않습니다`;
      if (strong) throw new Error(`검증 실패: ${what}`);
      state.review.push(`추정 확인 대상: ${what}`);
      return;
    }
    case 'goBack':
      await driver.goBack();
      return;
    case 'fillText': {
      const candidates = labelCandidates(value);
      const data = String(meta.data ?? '');
      const filled = await locate(driver, () => driver.fillOnce(candidates, data), TAP_TIMEOUT, state);
      if (!filled) throw new Error(`${NAV_NOT_FOUND}: 입력 칸 '${value}' 을(를) 화면에서 찾지 못했습니다. (찾아본 이름: ${candidates.map((c) => `"${c}"`).join(', ')})`);
      return;
    }
    case 'manualCheck':
      state.review.push(`자동 판정 근거 없음 — 화면 캡처로 확인 필요: ${value.slice(0, 200)}`);
      return;
    default:
      throw new Error(`텍스트 단계가 아닙니다: ${step.action}`);
  }
}

export function reviewSummary(state: TextStepState): string {
  return [...state.review, ...(state.notes.length ? [`(참고) ${state.notes.slice(0, 5).join(' / ')}`] : [])].join('\n');
}

/** 흔한 팝업의 "닫기" 계열 버튼 문구 (확인·동의처럼 동작을 확정하는 버튼은 넣지 않음) */
export const POPUP_DISMISS_TEXTS = ['닫기', '나중에', '다음에', '다음에 하기', '오늘 하루 보지 않기', '오늘 하루 그만 보기', '다시 보지 않기', '건너뛰기', 'Skip', 'Not now', 'Close', 'Later', 'No thanks'];
/** 권한 요청 허용 버튼 (Android/iOS 시스템 대화상자) */
export const PERMISSION_ALLOW_TEXTS = ['허용', '앱 사용 중에만 허용', '이번만 허용', 'Allow', 'While using the app', 'Allow while using app', 'Only this time', 'OK'];
