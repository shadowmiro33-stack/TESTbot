/**
 * QA 시나리오 시트(엑셀) 양식 해석 — 엑셀 라이브러리와 무관한 순수 로직
 *
 * 지원 양식 (실무 QA 시트 형태)
 *   STEP (ID) | [CASE유형] | Menu Depth (1Depth ~ 6Depth) | 테스트 항목 | 결과 | 이슈현상 | 발생빈도 | 개발사 확인 | 개발사 조치 사항 | 접수일 | 조치일 | 검수
 * - 헤더 행 위치·열 위치는 시트마다 달라도 자동으로 찾습니다.
 * - 메뉴 경로는 "위 행과 같으면 비워 두는" 방식 → 상위 단계가 바뀌면 하위 단계는 초기화하며 채워 넣습니다.
 * - "구분 | 표시" 범례(정상동작=O, 실패=F, 테스트불가=NT, 재확인요청=check …)가 있으면 그 코드를 결과 기입에 사용합니다.
 */

export type SheetCell = string | number | boolean | Date | null | undefined;
export type SheetGrid = SheetCell[][];

export type SheetColumns = {
  id: number;
  caseType?: number;
  depth: number[];
  item: number;
  result?: number;
  issue?: number;
  frequency?: number;
  devConfirm?: number;
  devAction?: number;
  received?: number;
  fixed?: number;
  verify?: number;
  /** (선택) 수행 단계 — "1. 「마이페이지」 탭을 누른다 [data]" 줄 목록. 있으면 메뉴 경로 대신 이 단계로 실행 */
  steps?: number;
  /** (선택) 사전 조건 */
  precondition?: number;
  /** (선택) 케이스 제목 */
  title?: number;
};

export type ResultCodes = { pass: string; fail: string; notTested: string; check: string };
export const DEFAULT_RESULT_CODES: ResultCodes = { pass: 'O', fail: 'F', notTested: 'NT', check: 'check' };

export type SheetCaseRow = {
  /** 1부터 시작하는 엑셀 행 번호 (결과를 원본에 다시 쓸 때 사용) */
  row: number;
  externalId: string;
  caseType?: string;
  section?: string;
  menuPath: string[];
  item: string;
  /** 원본 파일에 이미 적혀 있던 결과 (참고용) */
  previousResult?: string;
  stepsText?: string;
  precondition?: string;
  title?: string;
};

export type ParsedSheet = {
  name: string;
  headerRow: number;
  columns: SheetColumns;
  cases: SheetCaseRow[];
  resultCodes?: ResultCodes;
  /** 헤더 위쪽의 설명(테스트 대상, 목적, 가정 등) */
  notes: string;
  meta: Record<string, string>;
};

const text = (v: SheetCell): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).replace(/\r\n?/g, '\n').trim();
};
const norm = (v: SheetCell) => text(v).replace(/\s+/g, '').toUpperCase();

const ID_PATTERN = /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+$/;

/** 범례에서 결과 코드 읽기 (예: 정상동작|O, 실패|F, 테스트불가|NT, 재확인요청|check) */
function readResultCodes(grid: SheetGrid, until: number): ResultCodes | undefined {
  const found: Partial<ResultCodes> = {};
  for (let r = 0; r < until; r++) {
    const cells = Array.from(grid[r] ?? [], text).filter(Boolean);
    if (cells.length !== 2) continue;
    const [label, code] = [cells[0]!.replace(/\s+/g, ''), cells[1]!.trim()];
    if (/^정상(동작)?$|^통과$|^PASS$/i.test(label)) found.pass = code;
    else if (/^실패$|^FAIL$/i.test(label)) found.fail = code;
    else if (/테스트\s*불가|미수행|^N\/?T$/i.test(label)) found.notTested = code;
    else if (/재확인|확인\s*요청/.test(label)) found.check = code;
  }
  return Object.keys(found).length ? { ...DEFAULT_RESULT_CODES, ...found } : undefined;
}

/** 헤더 위쪽 메타 정보(테스트 OS 버전, 앱버전, 테스트 일시, 진행자 …)와 설명 문구 */
function readMeta(grid: SheetGrid, until: number) {
  const meta: Record<string, string> = {};
  const notes: string[] = [];
  const META_KEYS = /(OS\s*버전|앱\s*버전|버전|이용권|패스|테스트\s*일시|진행자|기기|환경)/;
  for (let r = 0; r < until; r++) {
    const row = grid[r] ?? [];
    const cells = Array.from(row, text);
    const filled = cells.filter(Boolean);
    if (!filled.length) continue;
    if (filled.length >= 3 && filled.every((c) => META_KEYS.test(c) || c.length <= 12) && filled.some((c) => META_KEYS.test(c))) {
      const below = Array.from(grid[r + 1] ?? [], text);
      cells.forEach((key, c) => { if (key && META_KEYS.test(key)) meta[key] = below[c] ?? ''; });
      r++;
      continue;
    }
    if (filled.length === 2 && filled[0]!.length <= 10 && filled[1]!.length <= 20) continue; // 범례 행
    notes.push(filled.join(' '));
  }
  return { meta, notes: notes.join('\n').slice(0, 4000) };
}

export function findHeaderRow(grid: SheetGrid): number {
  for (let r = 0; r < Math.min(grid.length, 80); r++) {
    if ((grid[r] ?? []).some((c) => { const n = norm(c); return n.includes('STEP') && n.includes('ID'); })) return r;
  }
  return -1;
}

/** 시트 하나를 해석합니다. QA 시나리오 양식이 아니면 null */
export function parseSheetGrid(name: string, grid: SheetGrid): ParsedSheet | null {
  const h = findHeaderRow(grid);
  if (h < 0) return null;
  const header = Array.from(grid[h] ?? [], norm);
  const col = (test: (n: string) => boolean) => { const i = header.findIndex(test); return i >= 0 ? i : undefined; };

  const id = col((n) => n.includes('STEP') && n.includes('ID'))!;
  const item = col((n) => n.includes('테스트항목') || n === '항목' || n.includes('확인항목') || n.includes('기대결과'));
  if (item === undefined) return null;
  const depthStart = col((n) => n.includes('DEPTH') || n.includes('메뉴'));
  // 다음 행의 1Depth~6Depth 라벨 우선, 없으면 Menu Depth ~ 테스트 항목 사이 열
  const sub = Array.from(grid[h + 1] ?? [], norm);
  let depth = sub.map((n, i) => (/^\d+DEPTH$/.test(n) ? i : -1)).filter((i) => i >= 0);
  if (!depth.length && depthStart !== undefined) depth = Array.from({ length: Math.max(0, item - depthStart) }, (_, k) => depthStart + k);

  const columns: SheetColumns = {
    id, item, depth,
    caseType: col((n) => n.includes('CASE유형') || n.includes('케이스유형') || n === '유형'),
    result: col((n) => n.startsWith('결과')),
    issue: col((n) => n.startsWith('이슈')),
    frequency: col((n) => n.includes('발생빈도') || n.includes('빈도')),
    devConfirm: col((n) => n.includes('개발사확인') || n.includes('개발확인')),
    devAction: col((n) => n.includes('조치사항') || n.includes('개발사조치')),
    received: col((n) => n.includes('접수일')),
    fixed: col((n) => n.includes('조치일')),
    verify: col((n) => n.includes('검수')),
    steps: col((n) => n === '단계' || n === '테스트단계' || n === '수행단계' || n === '수행절차' || n === '절차'),
    precondition: col((n) => n.startsWith('사전조건') || n === '전제조건'),
    title: col((n) => n === '제목' || n === '케이스제목' || n === 'TC제목' || n === '테스트케이스명')
  };

  const firstDataRow = depth.length && sub.some((n) => /^\d+DEPTH$/.test(n)) ? h + 2 : h + 1;
  const path: string[] = [];
  let section: string | undefined;
  const cases: SheetCaseRow[] = [];
  for (let r = firstDataRow; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rawId = text(row[id]);
    const itemText = text(row[item]);
    if (!ID_PATTERN.test(rawId) || !/\d/.test(rawId)) {
      // ID 없는 텍스트 행 = 구역 제목 (예: "1. 동시 접속 및 서버 과부하 테스트")
      const first = Array.from(row, text).find(Boolean);
      if (first && !itemText) section = first.split('\n')[0]!.slice(0, 120);
      continue;
    }
    depth.forEach((c, level) => {
      const v = text(row[c]);
      if (v) { path[level] = v.replace(/\s+/g, ' '); path.length = level + 1; }
    });
    if (!itemText) continue;
    cases.push({
      row: r + 1,
      externalId: rawId,
      caseType: columns.caseType !== undefined ? text(row[columns.caseType]) || undefined : undefined,
      section,
      menuPath: path.filter(Boolean),
      item: itemText,
      previousResult: columns.result !== undefined ? text(row[columns.result]) || undefined : undefined,
      stepsText: columns.steps !== undefined ? text(row[columns.steps]) || undefined : undefined,
      precondition: columns.precondition !== undefined ? text(row[columns.precondition]) || undefined : undefined,
      title: columns.title !== undefined ? text(row[columns.title]) || undefined : undefined
    });
  }

  const { meta, notes } = readMeta(grid, h);
  return { name, headerRow: h + 1, columns, cases, resultCodes: readResultCodes(grid, h), notes, meta };
}

/** 실행 결과 → 시트 결과 코드 */
export function sheetCodeFor(result: string, codes: ResultCodes = DEFAULT_RESULT_CODES): string {
  switch (result) {
    case 'PASS': return codes.pass;
    case 'FAIL': return codes.fail;
    case 'SKIP': case 'BLOCKED': return codes.notTested;
    default: return codes.check;
  }
}

// ── 텍스트 기반 화면 조작(웹·앱 공통) ─────────────────────────────────────────

const QUOTED = /["“”「」『』]([^"“”「」『』]{1,60})["“”「」『』]/g;
const SUFFIX = /(\s*(선택|버튼|클릭|탭|터치|필드|아이콘|메뉴|화면|페이지|영역|링크|항목))+$/;

/** 페이지 표시 라벨 (예: "[p]Recommend") → 클릭 대상이 아니라 "이 화면에 있다"는 표시 */
export const isPageMarker = (label: string) => /^\s*\[\s*p\s*\]/i.test(label);

/** 화면 요소가 아닌 상황 설명 (예: "한곡을 부른뒤", "로그인 상태에서") */
export const isSituationLabel = (label: string) => /(부른\s*뒤|한\s*뒤|한\s*후|이후|경우|상태(에서)?|중일\s*때|했을\s*때|된\s*후)\s*$/.test(label.trim());

/**
 * 메뉴 라벨에서 화면에서 찾을 텍스트 후보를 만듭니다.
 * 예) `곡 선택 "사랑비"` → ["사랑비", "곡 선택 사랑비", "곡"], `프로필이미지변경 버튼` → ["프로필이미지변경 버튼", "프로필이미지변경"]
 */
export function labelCandidates(label: string): string[] {
  const raw = label.replace(/\s+/g, ' ').trim();
  const quoted = [...raw.matchAll(QUOTED)].map((m) => m[1]!.trim()).filter(Boolean);
  const base = raw.replace(/^\s*\[\s*[a-z]\s*\]\s*/i, '').replace(QUOTED, '$1').replace(/\s+/g, ' ').trim();
  const stripped = base.replace(SUFFIX, '').trim();
  const out = [...quoted, base, stripped].filter((c) => c && c.length <= 40);
  return [...new Set(out)];
}
