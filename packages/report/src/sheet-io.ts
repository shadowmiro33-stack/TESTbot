/**
 * QA 시나리오 시트 엑셀 입출력
 * - readSuiteWorkbook: 업로드된 엑셀에서 시나리오 시트를 찾아 케이스로 해석
 * - writeSuiteResults: 원본 파일을 그대로 열어 결과/이슈현상/접수일 칸만 채우고, 요약 시트를 덧붙여 저장
 *   (원본의 서식·병합·다른 시트는 건드리지 않습니다)
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

// @autohands/shared 의 SheetGrid/SheetColumns 와 같은 구조 (report 패키지는 shared 에 의존하지 않음)
type SheetCell = string | number | boolean | Date | null | undefined;
type SheetGrid = SheetCell[][];
type SheetColumns = { result?: number; issue?: number; received?: number };

export const SUMMARY_SHEET_NAME = 'AUTOHANDS 자동실행 결과';

/** 엑셀 셀 값 → 텍스트/숫자/날짜 (서식 있는 텍스트, 수식 결과, 하이퍼링크 처리) */
function plain(value: unknown): SheetCell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value !== 'object') return value as SheetCell;
  const v = value as Record<string, any>;
  if (Array.isArray(v.richText)) return v.richText.map((t: { text: string }) => t.text).join('');
  if ('result' in v) return plain(v.result);
  if ('text' in v) return plain(v.text);
  if ('error' in v) return null;
  return null;
}

/** 시트를 2차원 배열로 변환. 병합 셀은 왼쪽 위(대표) 셀에만 값을 둡니다 (메뉴 경로 채우기가 어긋나지 않도록). */
function toGrid(ws: ExcelJS.Worksheet): SheetGrid {
  const grid: SheetGrid = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    const out: SheetCell[] = [];
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) return;
      out[c - 1] = plain(cell.value);
    });
    grid[r - 1] = out;
  });
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  return grid;
}

/** 업로드된 엑셀의 시트별 셀 값 (해석은 @autohands/shared 의 parseSheetGrid) */
export async function readWorkbookGrids(buffer: Buffer): Promise<Array<{ name: string; grid: SheetGrid }>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb.worksheets.filter((ws) => ws.name !== SUMMARY_SHEET_NAME).map((ws) => ({ name: ws.name, grid: toGrid(ws) }));
}

export type SheetResultUpdate = {
  sheet: string;
  row: number;
  columns: SheetColumns;
  code: string;
  /** 실패·재확인·테스트불가 사유 (이슈현상 칸) */
  issue?: string;
  /** 실패일 때 접수일 칸에 넣을 날짜 (예: "10/28") — 이미 값이 있으면 덮어쓰지 않음 */
  received?: string;
};

export type SuiteSummary = {
  title: string;
  executedAt: Date;
  environment: string;
  platform: string;
  bySheet: Array<{ sheet: string; total: number; pass: number; fail: number; check: number; notTested: number }>;
  codes: { pass: string; fail: string; check: string; notTested: string };
};

const MAX_CELL_TEXT = 1000;

export async function writeSuiteResults(originalPath: string, outPath: string, updates: SheetResultUpdate[], summary: SuiteSummary) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(originalPath);
  for (const u of updates) {
    const ws = wb.getWorksheet(u.sheet);
    if (!ws || u.columns.result === undefined) continue;
    const row = ws.getRow(u.row);
    row.getCell(u.columns.result + 1).value = u.code;
    // 통과 행은 이슈현상 칸을 건드리지 않음 (이전 회차의 기록 보존)
    if (u.columns.issue !== undefined && u.issue) row.getCell(u.columns.issue + 1).value = `[AUTOHANDS] ${u.issue}`.slice(0, MAX_CELL_TEXT);
    if (u.received && u.columns.received !== undefined) {
      const cell = row.getCell(u.columns.received + 1);
      if (cell.value === null || cell.value === undefined || cell.value === '') cell.value = u.received;
    }
    row.commit?.();
  }

  const existing = wb.getWorksheet(SUMMARY_SHEET_NAME);
  if (existing) wb.removeWorksheet(existing.id);
  const ws = wb.addWorksheet(SUMMARY_SHEET_NAME);
  const { codes } = summary;
  ws.addRow([summary.title]).font = { bold: true, size: 14 };
  ws.addRow([`실행 일시: ${summary.executedAt.toLocaleString('ko-KR')}`, `환경: ${summary.environment}`, `플랫폼: ${summary.platform}`]);
  ws.addRow([`결과 코드: ${codes.pass}=통과, ${codes.fail}=실패, ${codes.check}=재확인 필요(자동 판정 근거 부족·메뉴 경로 확인), ${codes.notTested}=테스트불가(사람이 직접 해야 하는 항목)`]);
  ws.addRow([]);
  const header = ws.addRow(['시트', '전체', `통과(${codes.pass})`, `실패(${codes.fail})`, `재확인(${codes.check})`, `테스트불가(${codes.notTested})`, '자동 판정률']);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172033' } }; });
  const first = ws.rowCount + 1;
  for (const s of summary.bySheet) {
    const r = ws.rowCount + 1;
    ws.addRow([s.sheet, s.total, s.pass, s.fail, s.check, s.notTested, { formula: `IFERROR((C${r}+D${r})/B${r},0)` }]);
  }
  const last = ws.rowCount;
  const t = last + 1;
  const totalRow = ws.addRow(['합계', ...['B', 'C', 'D', 'E', 'F'].map((col) => ({ formula: `SUM(${col}${first}:${col}${last})` })), { formula: `IFERROR((C${t}+D${t})/B${t},0)` }]);
  totalRow.font = { bold: true };
  for (let r = first; r <= t; r++) ws.getRow(r).getCell(7).numFmt = '0.0%';
  ws.columns = [{ width: 30 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 16 }, { width: 14 }];

  await mkdir(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/** 점검용: 엑셀을 열어 시트 이름·병합 셀·셀 값을 확인 */
export async function inspectWorkbook(filePath: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return {
    sheetNames: wb.worksheets.map((ws) => ws.name),
    merges: Object.fromEntries(wb.worksheets.map((ws) => [ws.name, [...(((ws.model as any).merges ?? []) as string[])].sort()])),
    cell: (sheet: string, row: number, col: number) => plain(wb.getWorksheet(sheet)?.getRow(row).getCell(col).value)
  };
}

// ── 기법 기반 TC → QA 시나리오 시트 양식 ────────────────────────────────────────

export type DesignedCaseRow = {
  externalId: string;
  menuPath: string[];
  item: string;
  stepsText: string;
  precondition: string;
  technique: string;
  priority: string;
  isNegative: boolean;
  coversIds: string;
  rationale: string;
  title: string;
};
export type OpenQuestionRow = { question: string; why: string; blocksTesting: boolean };

const RESULT_LEGEND: Array<[string, string]> = [
  ['정상동작', 'O'], ['실패', 'F'], ['테스트불가', 'NT'], ['버그 아님', 'NOT A BUG'], ['중복 버그', 'DUPLICATED'],
  ['재현 안됨', 'NOT REPRO'], ['수정 안함', "WON'T FIX"], ['수정된 이슈가 재현됨', 'REOPENED'], ['검수완료', 'completed'], ['재확인요청', 'check']
];

/**
 * 팀에서 쓰는 QA 시나리오 시트와 같은 배치(STEP ID · 1~6Depth · 테스트 항목 · 결과 · 이슈현상 · 개발사 확인 …)로
 * 엑셀을 만듭니다. 오른쪽에 단계 · 사전조건 · 기법 · 우선순위 · 커버 항목 · 근거 열을 덧붙여 추적성을 남깁니다.
 */
export async function buildDesignedSuiteWorkbook(input: { feature: string; source: string; cases: DesignedCaseRow[]; openQuestions: OpenQuestionRow[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheetName = (input.feature || '기능').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || '기능';
  const ws = wb.addWorksheet(sheetName);
  const thin = { style: 'thin' as const, color: { argb: 'FFBFC7D2' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const headFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1F3864' } };

  ws.getRow(1).getCell(2).value = `${input.feature} 테스트 시나리오`;
  ws.getRow(1).getCell(2).font = { bold: true, size: 16 };
  ['테스트 OS 버전', '앱버전', '테스트 일시', '테스트 진행자'].forEach((t, i) => { const c = ws.getRow(3).getCell(2 + i); c.value = t; c.font = { bold: true }; c.border = box; ws.getRow(4).getCell(2 + i).border = box; });
  ws.getRow(6).getCell(2).value = '구분'; ws.getRow(6).getCell(3).value = '표시';
  RESULT_LEGEND.forEach(([k, v], i) => { ws.getRow(7 + i).getCell(2).value = k; ws.getRow(7 + i).getCell(3).value = v; });
  ws.getRow(18).getCell(2).value = `출처: ${input.source} — 오른쪽 열(기법·커버 항목·근거)로 어떤 기법의 어느 항목을 검증하는지 추적할 수 있습니다.`;
  ws.getRow(18).getCell(2).font = { italic: true, color: { argb: 'FF5B6475' } };

  const H = 20;
  const headers: Array<[number, string]> = [[2, 'STEP (ID)'], [3, 'Menu Depth'], [9, '테스트 항목'], [10, '결과'], [11, '이슈현상'], [12, '발생빈도'], [13, '개발사 확인 '], [14, '개발사 조치 사항'], [15, '접수일'], [16, '조치일'], [17, '검수'], [18, '단계'], [19, '사전조건'], [20, '기법'], [21, '우선순위'], [22, '부정'], [23, '커버 항목'], [24, '근거'], [25, '제목']];
  for (const [c, t] of headers) { const cell = ws.getRow(H).getCell(c); cell.value = t; }
  for (let d = 0; d < 6; d++) ws.getRow(H + 1).getCell(3 + d).value = `${d + 1}Depth`;
  for (let c = 2; c <= 25; c++) for (const r of [H, H + 1]) { const cell = ws.getRow(r).getCell(c); cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = headFill; cell.border = box; cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; }
  ws.mergeCells(H, 3, H, 8);
  for (const [c] of headers) if (c !== 3) ws.mergeCells(H, c, H + 1, c);

  input.cases.forEach((tc, i) => {
    const r = H + 2 + i;
    const row = ws.getRow(r);
    row.getCell(2).value = tc.externalId;
    tc.menuPath.slice(0, 6).forEach((p, d) => { row.getCell(3 + d).value = p; });
    row.getCell(9).value = tc.item;
    row.getCell(18).value = tc.stepsText;
    row.getCell(19).value = tc.precondition || null;
    row.getCell(20).value = tc.technique;
    row.getCell(21).value = tc.priority;
    row.getCell(22).value = tc.isNegative ? 'Y' : 'N';
    row.getCell(23).value = tc.coversIds;
    row.getCell(24).value = tc.rationale;
    row.getCell(25).value = tc.title;
    for (let c = 2; c <= 25; c++) { const cell = row.getCell(c); cell.border = box; cell.alignment = { vertical: 'top', wrapText: true }; }
  });
  const last = H + 1 + Math.max(1, input.cases.length);
  (ws as any).dataValidations?.add?.(`J${H + 2}:J${last}`, { type: 'list', allowBlank: true, formulae: [`"${RESULT_LEGEND.map(([, v]) => v).join(',')}"`] });
  const widths: Record<number, number> = { 1: 2, 2: 13, 3: 14, 4: 14, 5: 14, 6: 12, 7: 10, 8: 10, 9: 48, 10: 8, 11: 30, 12: 8, 13: 10, 14: 18, 15: 9, 16: 9, 17: 9, 18: 46, 19: 26, 20: 14, 21: 9, 22: 6, 23: 22, 24: 34, 25: 36 };
  ws.columns = Array.from({ length: 25 }, (_, i) => ({ width: widths[i + 1] ?? 10 }));
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: H + 1 }];

  if (input.openQuestions.length) {
    const q = wb.addWorksheet('열린 질문');
    q.addRow(['No', '질문', '왜 필요한가 (막히는 케이스)', '테스트 차단', '답변']);
    q.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = headFill; });
    input.openQuestions.forEach((oq, i) => q.addRow([i + 1, oq.question, oq.why, oq.blocksTesting ? 'Y' : 'N', '']));
    q.columns = [{ width: 6 }, { width: 60 }, { width: 50 }, { width: 10 }, { width: 40 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── 판정 가능성 점검 (개선 제안) ───────────────────────────────────────────────

export type ReviewRow = { sheet: string; externalId: string; menuPath: string; item: string; kind: string; problem: string; suggestion: string };

export async function buildReviewWorkbook(title: string, rows: ReviewRow[], summary: Array<[string, number]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const headFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1F3864' } };
  const s = wb.addWorksheet('요약');
  s.addRow([title]).font = { bold: true, size: 14 };
  s.addRow(['자동으로 판정할 수 있게 하려면 기대 결과에 화면에 실제로 보이는 문구를 " " 로, 화면·버튼 이름을 「 」 로 적어 주세요.']);
  s.addRow([]);
  for (const [k, v] of summary) s.addRow([k, v]);
  s.columns = [{ width: 60 }, { width: 12 }];
  const ws = wb.addWorksheet('개선 제안');
  ws.addRow(['시트', 'STEP ID', '메뉴 경로', '현재 테스트 항목', '현재 분류', '문제', '이렇게 바꾸면 자동 판정됩니다', '반영(직접 수정)']);
  ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = headFill; c.alignment = { wrapText: true, vertical: 'middle' }; });
  for (const r of rows) {
    const row = ws.addRow([r.sheet, r.externalId, r.menuPath, r.item, r.kind, r.problem, r.suggestion, '']);
    row.eachCell((c) => { c.alignment = { wrapText: true, vertical: 'top' }; });
  }
  ws.columns = [{ width: 16 }, { width: 13 }, { width: 34 }, { width: 50 }, { width: 14 }, { width: 34 }, { width: 60 }, { width: 30 }];
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
