import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
type ZipStream = NodeJS.ReadWriteStream & { directory(source: string, destination: false | string): void; finalize(): Promise<void>; on(event: 'error', listener: (error: Error) => void): unknown };
/**
 * archiver 버전별 API 차이 흡수
 * - v7 이하(CJS): archiver('zip', options)
 * - v8+(ESM):     new ZipArchive(options)
 */
async function createZipStream(options: { zlib?: { level: number } }): Promise<ZipStream> {
  const mod: any = await import('archiver');
  const ZipArchive = mod.ZipArchive ?? mod.default?.ZipArchive;
  if (typeof ZipArchive === 'function') return new ZipArchive(options);
  const factory = typeof mod.default === 'function' ? mod.default : typeof mod === 'function' ? mod : null;
  if (factory) return factory('zip', options);
  throw new Error('지원하지 않는 archiver 버전입니다.');
}

type ReportInput = { run: any; testCases: any[]; results: any[]; artifacts: any[]; issues: any[] };
const columns: Record<string, string[]> = {
  Summary: ['전체 TC', 'PASS', 'FAIL', 'BLOCKED', 'SKIP', 'REQUIREMENT_CHECK', 'FLAKY'],
  'Test Cases': ['TC ID', 'Scenario ID', 'Platform', 'Agent', 'Menu', 'Page', 'Function', 'Test Type', 'Test Item', 'Precondition', 'Test Data', 'Steps', 'Expected', 'Actual', 'Result', 'Severity', 'Source', 'Execution Time', 'URL', 'Environment'],
  Issues: ['Issue ID', 'TC ID', 'Platform', 'Function', 'Issue Description', 'Expected', 'Actual', 'Reproduction Steps', 'Severity', 'Frequency', 'Root Cause Candidate', 'Developer Confirmation', 'Developer Action', 'Retest Result'],
  Backend: ['TC ID', 'API', 'Method', 'Request', 'Expected Status', 'Actual Status', 'Expected Response', 'Actual Response', 'Response Time', 'Result'],
  Evidence: ['TC ID', 'Screenshot Before', 'Screenshot Fail', 'Screenshot After', 'Trace', 'Video', 'URL', 'Viewport', 'Browser', 'OS', 'Executed At']
};
export async function createExcelReport(input: ReportInput, outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true }); const wb = new ExcelJS.Workbook();
  for (const [name, headers] of Object.entries(columns)) { const ws = wb.addWorksheet(name); ws.addRow(headers); ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172033' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.columns = headers.map(() => ({ width: 20 })); }
  const counts = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED', 'SKIP', 'REQUIREMENT_CHECK', 'FLAKY'].map((s) => [s, input.results.filter((r) => r.result === s).length]));
  wb.getWorksheet('Summary')!.addRow([input.testCases.length, counts.PASS, counts.FAIL, counts.BLOCKED, counts.SKIP, counts.REQUIREMENT_CHECK, counts.FLAKY]);
  for (const tc of input.testCases) { const result = input.results.find((r) => r.testCaseId === tc.id); wb.getWorksheet('Test Cases')!.addRow([tc.id, '', tc.platform, tc.strategy, tc.feature?.menu ?? '', tc.feature?.page ?? '', tc.title, tc.strategy, tc.title, tc.precondition ?? '', JSON.stringify(tc.testData ?? {}), JSON.stringify(tc.steps), JSON.stringify(tc.expected), result?.actual ?? '', result?.result ?? 'READY', tc.severity, tc.sourceType, result?.durationMs ?? 0, tc.feature?.url ?? '', input.run.project?.name ?? '']); }
  for (const issue of input.issues) wb.getWorksheet('Issues')!.addRow([issue.id, issue.testResult?.testCaseId ?? '', issue.platform ?? '', issue.functionName ?? '', issue.description, issue.expected ?? '', issue.actual ?? '', issue.reproductionSteps ?? '', issue.severity, issue.frequency ?? '', issue.rootCauseCandidate ?? '', '', '', issue.retestResult ?? '']);
  for (const artifact of input.artifacts) { if (artifact.type === 'SCREENSHOT' || artifact.type === 'TRACE') { const ws = wb.getWorksheet('Evidence')!; const row = ws.addRow([artifact.testResult?.testCaseId ?? '', artifact.type === 'SCREENSHOT' ? artifact.path : '', '', '', artifact.type === 'TRACE' ? artifact.path : '', '', '', '', 'Chromium', process.platform, artifact.createdAt]); row.getCell(2).value = artifact.type === 'SCREENSHOT' ? { text: path.basename(artifact.path), hyperlink: artifact.path } : ''; } }
  await wb.xlsx.writeFile(outputPath); return outputPath;
}
export async function createZip(sourceDir: string, outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const zip = await createZipStream({ zlib: { level: 9 } });
  return new Promise<string>((resolve, reject) => {
    const out = createWriteStream(outputPath);
    out.on('close', () => resolve(outputPath));
    out.on('error', reject);
    zip.on('error', reject);
    zip.pipe(out);
    zip.directory(sourceDir, false);
    void Promise.resolve(zip.finalize()).catch(reject);
  });
}
export * from './sheet-io.js';
