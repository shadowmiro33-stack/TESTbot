// QA 시나리오 시트 입출력 점검 (실제 exceljs 로 사용자 엑셀을 읽고 → 결과를 채워 저장 → 다시 읽어 확인)
// 사용: pnpm --filter @autohands/api exec tsx scripts/sheet-roundtrip.ts <엑셀 파일> [출력 파일]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_RESULT_CODES, parseSheetGrid } from '@autohands/shared';
import { inspectWorkbook, readWorkbookGrids, writeSuiteResults, SUMMARY_SHEET_NAME } from '@autohands/report';
import { planSheetCase, type SheetPlan } from '@autohands/test-generator';

const input = process.argv[2];
if (!input) { console.error('사용: tsx scripts/sheet-roundtrip.ts <엑셀 파일> [출력 파일]'); process.exit(2); }
const output = process.argv[3] ?? path.join(path.dirname(input), 'sheet-roundtrip-result.xlsx');

const grids = await readWorkbookGrids(readFileSync(input));
const sheets = grids.map((g) => parseSheetGrid(g.name, g.grid)).filter((s): s is NonNullable<typeof s> => Boolean(s && s.cases.length));
let total = 0;
const tally = { auto: 0, review: 0, manual: 0 };
const updates = [];
for (const s of sheets) {
  const by = new Map<string, SheetPlan>();
  for (const c of s.cases) {
    const plan = planSheetCase(c, (ref) => by.get(ref.padStart(4, '0')));
    const suffix = /(\d+)$/.exec(c.externalId)?.[1]?.slice(-4);
    if (suffix && !by.has(suffix)) by.set(suffix, plan);
    const kind = plan.mode === 'MANUAL' ? 'manual' : plan.checks.length ? 'auto' : 'review';
    tally[kind]++;
    total++;
    const codes = s.resultCodes ?? DEFAULT_RESULT_CODES;
    const code = kind === 'manual' ? codes.notTested : kind === 'auto' ? codes.pass : codes.check;
    updates.push({ sheet: s.name, row: c.row, columns: s.columns, code, issue: kind === 'auto' ? undefined : `점검용 ${kind}` });
  }
  console.log(`[sheet] ${s.name.trim()}: 헤더 ${s.headerRow}행, ${s.cases.length}건, 결과열 ${s.columns.result !== undefined ? String.fromCharCode(65 + s.columns.result) : '-'}`);
}
console.log(`[sheet] 총 ${total}건 — 자동 판정 ${tally.auto} · 자동 이동+사람 확인 ${tally.review} · 테스트불가 ${tally.manual}`);

await writeSuiteResults(input, output, updates, {
  title: '점검', executedAt: new Date(), environment: '점검', platform: 'PC_WEB',
  bySheet: sheets.map((s) => ({ sheet: s.name, total: s.cases.length, pass: 0, fail: 0, check: 0, notTested: 0 })),
  codes: DEFAULT_RESULT_CODES
});

// 다시 읽어서 확인: 결과 칸, 원래 시트 수, 병합 셀 유지
const before = await inspectWorkbook(input);
const after = await inspectWorkbook(output);
let mismatch = 0;
for (const u of updates) if (after.cell(u.sheet, u.row, u.columns.result! + 1) !== u.code) mismatch++;
const mergesOk = before.sheetNames.every((name) => JSON.stringify(before.merges[name]) === JSON.stringify(after.merges[name]));
const sheetsOk = before.sheetNames.every((name) => after.sheetNames.includes(name)) && after.sheetNames.includes(SUMMARY_SHEET_NAME);
console.log(`[roundtrip] 결과 칸 불일치 ${mismatch}/${updates.length}, 병합 셀 유지 ${mergesOk ? 'OK' : 'NG'}, 시트 유지+요약 ${sheetsOk ? 'OK' : 'NG'} → ${output}`);
process.exit(mismatch === 0 && mergesOk && sheetsOk && total > 0 ? 0 : 1);
