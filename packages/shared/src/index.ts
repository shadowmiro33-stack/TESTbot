export const PLATFORMS = ['BACK_OFFICE', 'PC_WEB', 'RESPONSIVE_WEB', 'ANDROID', 'IOS'] as const;
export const STRATEGIES = ['NORMAL', 'EXCEPTION', 'BOUNDARY', 'PERMISSION', 'BACKEND', 'STATE', 'RESPONSIVE', 'APP', 'E2E', 'VISUAL', 'CHAOS', 'REGRESSION'] as const;
export const RESULTS = ['READY', 'PASS', 'FAIL', 'BLOCKED', 'SKIP', 'REQUIREMENT_CHECK', 'FLAKY'] as const;
export type Platform = typeof PLATFORMS[number];
export type TestStrategy = typeof STRATEGIES[number];
export type TestResultStatus = typeof RESULTS[number];
export const STEP_ACTIONS = [
  'navigate', 'click', 'input', 'select', 'check', 'upload', 'wait',
  'assertText', 'assertVisible', 'assertHidden', 'assertUrl', 'assertStatus',
  /** 입력 필드가 브라우저 검증(validity) 또는 aria-invalid 기준으로 유효하지 않아야 함 */
  'assertInvalid',
  /** 입력 필드가 유효해야 함 */
  'assertValid',
  /** 입력 필드 값 길이 검증. value: { max?: number; equals?: number } */
  'assertValueLength',
  // ── 텍스트 기반 단계 (웹·앱 공통, QA 시나리오 시트 실행용) ──
  /** 화면에 보이는 텍스트로 요소를 찾아 누름. value: 라벨 (labelCandidates 로 후보 생성) */
  'tapText',
  /** 텍스트가 화면에 보여야 함. value: 텍스트, metadata.negate=true 면 보이지 않아야 함 */
  'assertTextVisible',
  /** 뒤로 가기 */
  'goBack',
  /** 이름(라벨·placeholder·힌트)으로 입력 칸을 찾아 값 입력. value: 칸 이름, metadata.data: 입력값 */
  'fillText',
  /** 자동 판정 불가 → 화면 캡처와 함께 사람 확인 요청(결과: 재확인). value: 확인할 내용 */
  'manualCheck'
] as const;
export type StepAction = typeof STEP_ACTIONS[number];
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type TestStep = {
  order: number;
  action: StepAction;
  selector?: string;
  value?: unknown;
  metadata?: Record<string, unknown>;
};
export type DiscoveredControl = { selector: string; tag: string; type?: string; name?: string; label?: string; required?: boolean; maxLength?: number; min?: string; max?: string };
/** 버튼 클릭으로만 열리는 화면(SPA 모달·탭·폼)에 도달하는 방법 */
export type DiscoveryTrigger = { selector: string; label: string };
export type DiscoveredPage = {
  url: string; title: string; links: string[]; forms: number; inputs: DiscoveredControl[]; buttons: DiscoveredControl[];
  /** 있으면 url 로 이동한 뒤 이 요소를 클릭해야 나타나는 화면 */
  trigger?: DiscoveryTrigger;
};
export type DiscoveryResult = { pages: DiscoveredPage[]; networkEndpoints: Array<{ method: string; url: string; status?: number }>; consoleErrors: string[] };

export * from './sheet.js';
export * from './queue.js';
export * from './concurrency.js';
