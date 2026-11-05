/**
 * QA 시나리오 시트(엑셀) 가져오기 · 결과 내보내기
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RESULT_CODES, parseSheetGrid, sheetCodeFor, type ParsedSheet, type ResultCodes, type SheetColumns } from '@autohands/shared';
import { buildDesignedSuiteWorkbook, buildReviewWorkbook, readWorkbookGrids, writeSuiteResults, type ReviewRow, type SheetResultUpdate } from '@autohands/report';
import { formatStepsText, menuPathFromSteps, planSheetCase, refineSheetPlansWithAI, type CaseStep, type SheetPlan } from '@autohands/test-generator';
import { prisma } from './db.js';

export type SuiteSheetMeta = {
  name: string;
  headerRow: number;
  columns: SheetColumns;
  resultCodes: ResultCodes;
  notes: string;
  meta: Record<string, string>;
  count: number;
};
export type SuiteMeta = {
  sheets: SuiteSheetMeta[];
  skipped: string[];
  plan: { auto: number; manual: number; review: number };
  ai?: { status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED'; refined?: number; error?: string };
  /** 기법 기반 TC(테스트 모델)에서 만든 경우: 기획서가 답하지 않은 질문 */
  openQuestions?: Array<{ question: string; why: string; blocksTesting: boolean }>;
  source?: 'sheet' | 'designed';
};

export type SheetCaseMetadata = {
  kind: 'sheet';
  sheet: string;
  externalId: string;
  menuPath: string[];
  item: string;
  section?: string;
  caseType?: string;
  previousResult?: string;
  stepsText?: string;
  plan: { mode: SheetPlan['mode']; reason?: string; checks: string[]; source: 'rule' | 'ai' };
};

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const safeName = (name: string) => path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'suite.xlsx';

function caseTitle(sheet: string, c: { externalId: string; menuPath: string[]; item: string; title?: string }) {
  if (c.title) return `${c.externalId} ${c.title}`.slice(0, 190);
  const where = c.menuPath.length ? c.menuPath.slice(-2).join(' > ') : sheet.trim();
  return `${c.externalId} ${where} · ${c.item.replace(/\s+/g, ' ').slice(0, 70)}`.slice(0, 190);
}

function planKind(plan: SheetPlan): 'auto' | 'manual' | 'review' {
  if (plan.mode === 'MANUAL') return 'manual';
  return plan.checks.length ? 'auto' : 'review';
}

export async function importSuite(projectId: string, input: { fileName: string; base64: string; name?: string }, artifactRoot: string) {
  const buffer = Buffer.from(input.base64, 'base64');
  if (!buffer.length) throw Object.assign(new Error('빈 파일입니다.'), { statusCode: 400 });
  if (buffer.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('파일이 너무 큽니다. (최대 20MB)'), { statusCode: 400 });
  // xlsx = zip (PK..)
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw Object.assign(new Error('엑셀(.xlsx) 파일만 올릴 수 있습니다.'), { statusCode: 400 });

  let grids: Awaited<ReturnType<typeof readWorkbookGrids>>;
  try {
    grids = await readWorkbookGrids(buffer);
  } catch (error) {
    throw Object.assign(new Error(`엑셀 파일을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 400 });
  }
  const sheets: ParsedSheet[] = [];
  const skipped: string[] = [];
  for (const g of grids) {
    const parsed = parseSheetGrid(g.name, g.grid);
    if (parsed && parsed.cases.length) sheets.push(parsed);
    else skipped.push(g.name);
  }
  if (!sheets.length) {
    throw Object.assign(new Error('QA 시나리오 양식을 찾지 못했습니다. "STEP (ID)", "테스트 항목" 열이 있는 시트가 필요합니다.'), { statusCode: 400 });
  }

  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { platforms: true } });
  const platform = project.platforms[0] ?? 'PC_WEB';
  const fileName = safeName(input.fileName);
  const tally = { auto: 0, manual: 0, review: 0 };
  const rows = sheets.flatMap((sheet) => {
    // "0023 선행 작업후 …" 참조를 풀기 위해 같은 시트 안에서 ID 끝자리 → 계획 기록
    const bySuffix = new Map<string, SheetPlan>();
    const resolve = (ref: string) => bySuffix.get(ref.padStart(4, '0'));
    return sheet.cases.map((c) => {
      const plan = planSheetCase(c, resolve);
      const suffix = /(\d+)$/.exec(c.externalId)?.[1];
      if (suffix && !bySuffix.has(suffix.slice(-4).padStart(4, '0'))) bySuffix.set(suffix.slice(-4).padStart(4, '0'), plan);
      tally[planKind(plan)]++;
      const metadata: SheetCaseMetadata = {
        kind: 'sheet', sheet: sheet.name, externalId: c.externalId, menuPath: c.menuPath, item: c.item,
        section: c.section, caseType: c.caseType, previousResult: c.previousResult, stepsText: c.stepsText,
        plan: { mode: plan.mode, reason: plan.reason, checks: plan.checks, source: 'rule' }
      };
      return {
        projectId, platform, strategy: 'E2E' as const, severity: 'MEDIUM' as const, sourceType: 'DIRECT' as const,
        title: caseTitle(sheet.name, c), precondition: c.precondition ?? c.section ?? null,
        externalId: c.externalId, sheetName: sheet.name, rowNumber: c.row,
        steps: plan.steps as any, expected: { text: c.item } as any, metadata: metadata as any
      };
    });
  });

  const meta: SuiteMeta = {
    sheets: sheets.map((s) => ({ name: s.name, headerRow: s.headerRow, columns: s.columns, resultCodes: s.resultCodes ?? DEFAULT_RESULT_CODES, notes: s.notes, meta: s.meta, count: s.cases.length })),
    skipped,
    plan: tally,
    ai: { status: process.env.OPENAI_API_KEY ? 'RUNNING' : 'SKIPPED' }
  };

  const suite = await prisma.testSuite.create({
    data: { projectId, name: (input.name?.trim() || fileName.replace(/\.xlsx$/i, '')).slice(0, 120), fileName, filePath: '', meta: meta as any }
  });
  const dir = path.join(artifactRoot, 'suites', suite.id);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'original.xlsx');
  await writeFile(filePath, buffer);
  await prisma.$transaction([
    prisma.testSuite.update({ where: { id: suite.id }, data: { filePath } }),
    prisma.testCase.createMany({ data: rows.map((r) => ({ ...r, suiteId: suite.id })) })
  ]);

  if (process.env.OPENAI_API_KEY) setImmediate(() => void refineSuiteWithAI(suite.id).catch(() => undefined));
  return { id: suite.id, name: suite.name, fileName, sheets: meta.sheets.map((s) => ({ name: s.name, count: s.count })), skipped, plan: tally, total: rows.length };
}

/** 규칙으로 판정 근거를 못 찾은 케이스(재확인 예정)를 AI 로 보강 */
export async function refineSuiteWithAI(suiteId: string) {
  const suite = await prisma.testSuite.findUniqueOrThrow({ where: { id: suiteId } });
  const meta = suite.meta as unknown as SuiteMeta;
  const setAi = (ai: SuiteMeta['ai']) => prisma.testSuite.update({ where: { id: suiteId }, data: { meta: { ...meta, ai } as any } });
  try {
    const cases = await prisma.testCase.findMany({ where: { suiteId }, select: { id: true, metadata: true } });
    const targets = cases.filter((c) => {
      const m = c.metadata as unknown as SheetCaseMetadata;
      return m?.plan?.mode === 'AUTO' && !m.plan.checks.length;
    });
    const notes = meta.sheets.map((s) => s.notes).join('\n').slice(0, 2000);
    const refined = await refineSheetPlansWithAI(
      targets.map((c) => { const m = c.metadata as unknown as SheetCaseMetadata; return { key: c.id, menuPath: m.menuPath, item: m.item }; }),
      { notes }
    );
    for (const [id, plan] of refined) {
      const tc = targets.find((t) => t.id === id)!;
      const m = tc.metadata as unknown as SheetCaseMetadata;
      await prisma.testCase.update({
        where: { id },
        data: { steps: plan.steps as any, metadata: { ...m, plan: { mode: plan.mode, reason: plan.reason, checks: plan.checks, source: 'ai' } } as any }
      });
    }
    await setAi({ status: 'COMPLETED', refined: refined.size });
  } catch (error) {
    await setAi({ status: 'FAILED', error: error instanceof Error ? error.message : String(error) });
  }
}

const monthDay = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

/** 실행 결과를 원본 시트 양식에 채운 엑셀 생성 */
export async function buildSuiteResultFile(runId: string, outPath: string) {
  const run = await prisma.testRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      environment: { select: { name: true, platform: true } },
      suite: true,
      results: { select: { result: true, actual: true, manualResult: true, manualNote: true, testCase: { select: { sheetName: true, rowNumber: true } } } }
    }
  });
  if (!run.suite) throw Object.assign(new Error('시나리오 시트로 실행한 결과가 아닙니다.'), { statusCode: 400 });
  const meta = run.suite.meta as unknown as SuiteMeta;
  const sheetMeta = new Map(meta.sheets.map((s) => [s.name, s]));
  const date = monthDay(run.startedAt ?? run.createdAt);

  const updates: SheetResultUpdate[] = [];
  const counts = new Map<string, { sheet: string; total: number; pass: number; fail: number; check: number; notTested: number }>();
  for (const r of run.results) {
    const sheet = r.testCase.sheetName;
    const s = sheet ? sheetMeta.get(sheet) : undefined;
    if (!s || !r.testCase.rowNumber) continue;
    const codes = s.resultCodes ?? DEFAULT_RESULT_CODES;
    // 사람이 확정한 판정이 있으면 그것을 사용
    const final = r.manualResult ?? r.result;
    const code = sheetCodeFor(final, codes);
    const issue = r.manualResult
      ? (r.manualNote ? `[확인] ${r.manualNote}` : final === 'PASS' ? undefined : (r.actual ?? '').trim() || undefined)
      : final === 'PASS' ? undefined : (r.actual ?? '').trim() || undefined;
    updates.push({ sheet: s.name, row: r.testCase.rowNumber, columns: s.columns, code, issue, received: final === 'FAIL' ? date : undefined });
    const c = counts.get(s.name) ?? { sheet: s.name, total: 0, pass: 0, fail: 0, check: 0, notTested: 0 };
    c.total++;
    if (code === codes.pass) c.pass++; else if (code === codes.fail) c.fail++; else if (code === codes.notTested) c.notTested++; else c.check++;
    counts.set(s.name, c);
  }
  const codes = meta.sheets[0]?.resultCodes ?? DEFAULT_RESULT_CODES;
  await writeSuiteResults(run.suite.filePath, outPath, updates, {
    title: `${run.suite.name} — AUTOHANDS 자동 실행 결과`,
    executedAt: run.startedAt ?? run.createdAt,
    environment: run.environment.name,
    platform: run.environment.platform,
    bySheet: meta.sheets.map((s) => counts.get(s.name) ?? { sheet: s.name, total: 0, pass: 0, fail: 0, check: 0, notTested: 0 }),
    codes
  });
  return { outPath, fileName: `${run.suite.fileName.replace(/\.xlsx$/i, '')}_결과_${date.replace('/', '')}.xlsx` };
}


// ── 기법 기반 TC(ISTQB TC 작성 스킬의 test-cases.json) 가져오기 ─────────────────

export type DesignedCase = {
  title: string;
  technique?: string;
  priority?: string;
  isNegative?: boolean;
  preconditions?: string[];
  steps: CaseStep[];
  expectedResult: string;
  coversIds?: string[];
  rationale?: string;
};
export type DesignedModel = { feature?: string; openQuestions?: Array<{ question: string; why?: string; blocksTesting?: boolean }> };

/**
 * 기법 기반으로 설계한 TC → 팀 QA 시트 양식의 엑셀을 만들고, 그 엑셀을 일반 시트와 똑같이 가져옵니다.
 * (같은 경로로 가져오므로 실행 결과도 이 엑셀 양식에 그대로 채워집니다)
 */
export async function importDesignedSuite(projectId: string, input: { cases: DesignedCase[]; model?: DesignedModel; name?: string }, artifactRoot: string) {
  if (!input.cases.length) throw Object.assign(new Error('테스트 케이스가 없습니다.'), { statusCode: 400 });
  const feature = (input.model?.feature || input.name || '기능').trim();
  const openQuestions = (input.model?.openQuestions ?? []).map((q) => ({ question: q.question, why: q.why ?? '', blocksTesting: Boolean(q.blocksTesting) }));
  const buffer = await buildDesignedSuiteWorkbook({
    feature,
    source: 'ISTQB 기법 기반 TC 설계(test-cases.json)',
    openQuestions,
    cases: input.cases.map((c, i) => ({
      externalId: `01-01-${String(i + 1).padStart(4, '0')}`,
      menuPath: menuPathFromSteps(c.steps),
      item: c.expectedResult,
      stepsText: formatStepsText(c.steps),
      precondition: (c.preconditions ?? []).join(' / '),
      technique: c.technique ?? '',
      priority: c.priority ?? '',
      isNegative: Boolean(c.isNegative),
      coversIds: (c.coversIds ?? []).join(', '),
      rationale: c.rationale ?? '',
      title: c.title
    }))
  });
  const result = await importSuite(projectId, { fileName: `${safeName(feature)}_TC.xlsx`, base64: buffer.toString('base64'), name: input.name || `${feature} (기법 기반 TC)` }, artifactRoot);
  const suite = await prisma.testSuite.findUniqueOrThrow({ where: { id: result.id } });
  // 생성한 엑셀의 "열린 질문" 시트는 시나리오 시트가 아니므로 안내에서 제외
  const skipped = result.skipped.filter((name) => name !== '열린 질문');
  await prisma.testSuite.update({ where: { id: result.id }, data: { meta: { ...(suite.meta as object), skipped, openQuestions, source: 'designed' } as any } });
  return { ...result, skipped, openQuestions };
}

// ── 판정 가능성 점검 ───────────────────────────────────────────────────────────

const VAGUE = /(정상적으로|정상\s*동작|적절히|올바르게|잘\s|원활|문제\s*없이|인터랙션|정확하게|제대로)/;

export async function buildSuiteReview(suiteId: string) {
  const suite = await prisma.testSuite.findUniqueOrThrow({ where: { id: suiteId } });
  const cases = await prisma.testCase.findMany({ where: { suiteId }, orderBy: [{ sheetName: 'asc' }, { rowNumber: 'asc' }], select: { externalId: true, sheetName: true, metadata: true } });
  const rows: ReviewRow[] = [];
  let auto = 0, weakOnly = 0, review = 0, manual = 0;
  for (const c of cases) {
    const m = c.metadata as unknown as SheetCaseMetadata;
    if (!m?.plan) continue;
    if (m.plan.mode === 'MANUAL') { manual++; continue; }
    const weak = m.plan.checks.length > 0 && m.plan.checks.every((x) => x.includes('추정'));
    if (m.plan.checks.length && !weak) { auto++; continue; }
    if (weak) weakOnly++; else review++;
    const vague = VAGUE.exec(m.item)?.[1]?.trim();
    const problems = [
      vague ? `판정 기준이 모호한 표현: "${vague}"` : '',
      !/["“”「」]/.test(m.item) ? '화면에 보일 문구나 화면 이름이 적혀 있지 않음' : '',
      weak ? `확인 대상을 문장에서 추정함 (${m.plan.checks.join(', ').slice(0, 80)}) → 없으면 실패가 아니라 재확인으로 처리됨` : ''
    ].filter(Boolean);
    const where = m.menuPath.at(-1);
    const guessed = m.plan.checks.map((x) => /: 「?"?([^"」]+)/.exec(x)?.[1]).filter(Boolean)[0];
    const suggestion = [
      `${where ? `「${where}」 ` : ''}${guessed ? `"${guessed}"` : '"<화면에 실제로 보일 문구>"'} 이(가) 표시된다`,
      vague ? `("${vague}" 대신 무엇이 보이거나 바뀌어야 하는지 적어 주세요. 예: 개수, 버튼 이름, 안내 문구, 이동한 화면 이름)` : '',
      m.stepsText ? '' : '메뉴 경로로 갈 수 없는 동작이 있다면 "단계" 열에 「버튼」 을 누른다 형태로 적어 주세요.'
    ].filter(Boolean).join('\n');
    rows.push({ sheet: (c.sheetName ?? '').trim(), externalId: c.externalId ?? '', menuPath: m.menuPath.join(' › '), item: m.item, kind: weak ? '추정 판정' : '사람 확인', problem: problems.join('\n'), suggestion });
  }
  const buffer = await buildReviewWorkbook(`${suite.name} — 자동 판정 개선 제안`, rows, [
    ['자동 판정 (기대 문구가 명확함)', auto],
    ['추정 판정 (문장에서 확인 대상을 추정 — 실패 대신 재확인)', weakOnly],
    ['사람 확인 (판정 근거 없음)', review],
    ['테스트불가 (사람이 해야 하는 항목)', manual],
    ['개선 제안 행 수', rows.length]
  ]);
  return { buffer, fileName: `${suite.fileName.replace(/\.xlsx$/i, '')}_판정개선제안.xlsx`, count: rows.length };
}
