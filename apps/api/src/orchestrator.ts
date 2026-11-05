import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { TestCase } from '@prisma/client';
import { AppSession, ExecutionSession, type AppTarget, type RunCase } from '@autohands/browser-runner';
import { assertSafeTarget, decryptSecret, getEncryptionKey, isForbiddenRequestUrl, maskSecretText, targetPolicyFromEnv } from '@autohands/core';
import { runWithConcurrency } from '@autohands/shared';
import { prisma } from './db.js';

const artifactRoot = path.resolve(process.env.ARTIFACT_ROOT ?? './artifacts');
/** 한 실행(run) 안에서 동시에 수행할 케이스 수. 대상 서비스 부하를 고려해 조정하세요. */
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.QA_CONCURRENCY ?? 3) || 3));

const FULL_MATRIX_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 430, height: 932 },
  { width: 390, height: 844 },
  { width: 375, height: 812 },
  { width: 360, height: 800 }
];
const DEFAULT_VIEWPORTS = [{ width: 1440, height: 900 }];

/** 실패는 한 번 재시도 (QA_RETRY=0 이면 끔). 메뉴 경로를 못 찾은 경우도 재시도하려면 QA_RETRY_NAV=1 (실행 시간이 늘어남) */
const RETRY_ONCE = process.env.QA_RETRY !== '0';
const RETRY_NAV = process.env.QA_RETRY_NAV === '1';
const isRetryable = (e: { result: string; actual: string }) => e.result === 'FAIL' || (RETRY_NAV && e.result === 'REQUIREMENT_CHECK' && /찾지 못했습니다/.test(e.actual));
const errorMessage = (error: unknown) => maskSecretText(error instanceof Error ? error.message : String(error));

const APP_PLATFORMS = new Set(['ANDROID', 'IOS']);
export type AppConfig = { appId?: string; deviceName?: string; udid?: string; app?: string; appActivity?: string; automationName?: string; extra?: Record<string, unknown> };

/** 환경의 앱 설정 → Appium 접속 정보 (Appium 서버 주소는 서버 설정 APPIUM_URL 로만 지정) */
export function appTargetFor(platform: 'ANDROID' | 'IOS', config: AppConfig | null | undefined): AppTarget {
  const c = config ?? {};
  const caps: Record<string, unknown> = {
    'appium:automationName': c.automationName || (platform === 'ANDROID' ? 'UiAutomator2' : 'XCUITest'),
    'appium:newCommandTimeout': 300,
    'appium:noReset': true,
    // 권한 요청 대화상자로 실행이 막히지 않도록 (Android: 설치 시 권한 자동 허용, iOS: 시스템 알림 자동 수락)
    ...(platform === 'ANDROID' ? { 'appium:autoGrantPermissions': true } : { 'appium:autoAcceptAlerts': true })
  };
  if (c.deviceName) caps['appium:deviceName'] = c.deviceName;
  if (c.udid) caps['appium:udid'] = c.udid;
  if (c.app) caps['appium:app'] = c.app;
  if (c.appId) caps[platform === 'ANDROID' ? 'appium:appPackage' : 'appium:bundleId'] = c.appId;
  if (c.appActivity && platform === 'ANDROID') caps['appium:appActivity'] = c.appActivity;
  for (const [k, v] of Object.entries(c.extra ?? {})) caps[k.includes(':') || k === 'platformName' ? k : `appium:${k}`] = v;
  return { platform, appiumUrl: process.env.APPIUM_URL || 'http://127.0.0.1:4723', capabilities: caps, appId: c.appId };
}

type CaseRunner = {
  execute(tc: CaseRow, outputDir: string, viewport: { width: number; height: number }): Promise<Execution>;
  close(): Promise<void>;
  concurrency: number;
  viewports: Array<{ width: number; height: number }>;
};

/** 실행 전체를 실패 처리합니다. 이미 종료(취소/완료)된 실행은 건드리지 않습니다. */
export async function failRun(runId: string, reason: string) {
  await prisma.testRun.updateMany({
    where: { id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'FAILED', error: reason.slice(0, 2000), finishedAt: new Date() }
  });
}

/**
 * 테스트 실행.
 * - 같은 run 이 다시 전달되면(워커 중단 후 재큐잉) 이미 저장된 결과는 건너뛰고 이어서 실행합니다.
 * - 로그인은 run 시작 시 한 번만 수행하고, 실패하면 케이스를 돌리지 않고 run 을 FAILED 로 종료합니다.
 */
export async function executeRun(runId: string, onlyCaseIds?: string[]) {
  const run = await prisma.testRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      environment: { include: { credentials: true } },
      credential: true,
      results: { select: { testCaseId: true } }
    }
  });
  // 이미 종료된 실행(중복 전달, 취소 후 재큐잉 등)은 무시
  if (!['QUEUED', 'RUNNING'].includes(run.status)) return;

  const isApp = APP_PLATFORMS.has(run.environment.platform);
  if (!isApp && !run.environment.webUrl) {
    await failRun(runId, '환경에 Web URL 이 설정되지 않았습니다.');
    return;
  }

  await prisma.testRun.update({
    where: { id: runId },
    data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date(), error: null }
  });

  const alreadyDone = new Set(run.results.map((r) => r.testCaseId));
  const testCases: CaseRow[] = (
    await prisma.testCase.findMany({
      where: {
        projectId: run.projectId,
        // FAIL 재테스트는 TC 재생성으로 비활성화(아카이빙)된 케이스도 원래 케이스 그대로 재실행
        ...(onlyCaseIds ? { id: { in: onlyCaseIds } } : { enabled: true }),
        // 시나리오 시트 실행이면 그 시트의 케이스만, 아니면 자동 생성 케이스만
        ...(onlyCaseIds ? {} : { suiteId: run.suiteId ?? null }),
        ...(!onlyCaseIds && run.suiteId && run.sheetFilter?.length ? { sheetName: { in: run.sheetFilter } } : {})
      },
      orderBy: [{ sheetName: 'asc' }, { rowNumber: 'asc' }, { createdAt: 'asc' }]
    })
  ).filter((tc: CaseRow) => !alreadyDone.has(tc.id));

  const credential = run.credential ?? run.environment.credentials[0];
  const password = credential ? decryptSecret(credential.encryptedPassword, getEncryptionKey()) : undefined;
  const runDir = path.join(artifactRoot, `QA_RUN_${run.id}`);
  await mkdir(runDir, { recursive: true });
  // 사람이 해야 하는 항목(시트에서 MANUAL 로 분류)은 실행기 없이 "테스트불가" 로 기록
  const manualCases = testCases.filter(isManualCase);
  const autoCases = testCases.filter((tc) => !isManualCase(tc));
  for (const tc of manualCases) await saveSkipped(runId, tc);

  let runner: CaseRunner | undefined;
  if (autoCases.length) {
    try {
      runner = isApp
        ? await openAppRunner(runId, run.environment, credential && password ? { username: credential.username, password } : undefined)
        : await openWebRunner(run, credential?.username, password);
    } catch (error) {
      await failRun(runId, `실행 준비 실패: ${errorMessage(error)}`);
      return;
    }
  }

  const isCancelled = async () =>
    (await prisma.testRun.findUnique({ where: { id: runId }, select: { status: true } }))?.status === 'CANCELLED';

  try {
    if (runner) {
      const active = runner;
      await runWithConcurrency(
        autoCases,
        active.concurrency,
        async (tc) => {
          const runAll = async (attempt: string) => {
            const out: Execution[] = [];
            for (const viewport of active.viewports) {
              out.push(await active.execute(tc, path.join(runDir, 'screenshots', tc.sheetName ? 'SHEET' : tc.strategy, tc.id, `${viewport.width}x${viewport.height}`, attempt), viewport));
            }
            return out;
          };
          const first = await runAll('1');
          // 실패 또는 "메뉴 경로를 못 찾음"은 화면 로딩 지연일 수 있어 한 번 더 실행 → 두 번째에 통과하면 불안정(FLAKY)
          if (RETRY_ONCE && first.some(isRetryable)) {
            const second = await runAll('2');
            if (second.every((e) => e.result === 'PASS')) {
              const reason = first.find(isRetryable)!.actual;
              await saveCaseResult(runId, tc, second, active.viewports, { status: 'FLAKY', actual: `불안정: 1차 실행 실패 후 재시도에서 통과 — 1차: ${reason}`.slice(0, 2000) });
              return;
            }
            await saveCaseResult(runId, tc, second, active.viewports);
            return;
          }
          await saveCaseResult(runId, tc, first, active.viewports);
        },
        isCancelled
      );
    }

    // 취소된 실행을 COMPLETED 로 덮어쓰지 않도록 RUNNING 상태일 때만 완료 처리
    await prisma.testRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: 'COMPLETED', finishedAt: new Date() }
    });
  } catch (error) {
    await failRun(runId, `실행 중 오류: ${errorMessage(error)}`);
    throw error;
  } finally {
    await runner?.close();
  }

  async function openWebRunner(r: typeof run, username: string | undefined, pw: string | undefined): Promise<CaseRunner> {
    // 등록 이후 DNS 가 바뀌었을 수 있으므로 실행 시점에 다시 검증 (DNS 리바인딩 완화)
    const policy = targetPolicyFromEnv();
    await assertSafeTarget(r.environment.webUrl!, policy);
    const session = await ExecutionSession.open({
      baseUrl: r.environment.webUrl!,
      username,
      password: pw,
      production: r.environment.isProduction,
      requestGuard: (url) => isForbiddenRequestUrl(url, policy)
    });
    // 시나리오 시트 케이스는 기본 화면 크기 한 번만 실행
    const viewports = r.suiteId ? DEFAULT_VIEWPORTS : r.mode === 'FULL_MATRIX' ? FULL_MATRIX_VIEWPORTS : DEFAULT_VIEWPORTS;
    return {
      concurrency: CONCURRENCY,
      viewports,
      execute: (tc, outputDir, viewport) => session.executeCase(toRunCase(tc), { viewport, outputDir }),
      close: () => session.close()
    };
  }
}

/** 같은 기기(Appium 주소 + 기기)를 쓰는 다른 실행이 끝날 때까지 대기 — 기기 1대에 실행 2개가 붙으면 서로 화면을 바꿔 버림 */
const deviceKey = (env: { appConfig: unknown }) => {
  const c = (env.appConfig ?? {}) as AppConfig;
  return `${process.env.APPIUM_URL || 'http://127.0.0.1:4723'}|${c.udid || c.deviceName || 'default'}`;
};
async function waitForDevice(runId: string, env: { id?: string; appConfig: unknown }) {
  const key = deviceKey(env);
  const maxWaitMs = (Number(process.env.QA_DEVICE_WAIT_MIN ?? 30) || 30) * 60_000;
  const started = Date.now();
  for (;;) {
    const others = await prisma.testRun.findMany({
      where: { id: { not: runId }, status: 'RUNNING', environment: { platform: { in: ['ANDROID', 'IOS'] } } },
      select: { id: true, startedAt: true, createdAt: true, environment: { select: { appConfig: true } } }
    });
    const me = await prisma.testRun.findUnique({ where: { id: runId }, select: { createdAt: true, status: true } });
    if (!me || me.status !== 'RUNNING') return;
    // 먼저 만들어진 실행이 기기를 쓰고 있으면 대기
    const busy = others.some((o) => deviceKey(o.environment) === key && o.createdAt < me.createdAt);
    if (!busy) return;
    if (Date.now() - started > maxWaitMs) throw new Error(`같은 기기(${key.split('|')[1]})를 쓰는 다른 실행이 끝나지 않아 ${Math.round(maxWaitMs / 60000)}분 대기 후 중단했습니다.`);
    await prisma.testRun.update({ where: { id: runId }, data: { error: '같은 기기를 쓰는 다른 실행이 끝나기를 기다리는 중…' } });
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function openAppRunner(runId: string, env: { platform: string; appConfig: unknown }, login?: { username: string; password: string }): Promise<CaseRunner> {
  await waitForDevice(runId, env);
  await prisma.testRun.update({ where: { id: runId }, data: { error: null } });
  const session = await AppSession.open({ ...appTargetFor(env.platform as 'ANDROID' | 'IOS', env.appConfig as AppConfig), login });
  return {
    concurrency: 1, // 기기 1대 → 순서대로
    viewports: [{ width: 0, height: 0 }],
    execute: (tc, outputDir) => session.executeCase(toRunCase(tc), { outputDir: outputDir.replace(/[/\\]0x0$/, '') }),
    close: () => session.close()
  };
}

const toRunCase = (tc: CaseRow): RunCase => ({ id: tc.id, title: tc.title, strategy: tc.strategy, steps: tc.steps as any[] });

function isManualCase(tc: CaseRow) {
  const plan = (tc.metadata as { plan?: { mode?: string } } | null)?.plan;
  return plan?.mode === 'MANUAL';
}

async function saveSkipped(runId: string, tc: CaseRow) {
  const reason = (tc.metadata as { plan?: { reason?: string } } | null)?.plan?.reason ?? '사람이 직접 확인해야 하는 항목';
  try {
    await prisma.testResult.create({ data: { runId, testCaseId: tc.id, result: 'SKIP', actual: `테스트불가(수동 확인 필요): ${reason}`, durationMs: 0 } });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }
}

type CaseRow = TestCase;
type Execution = Awaited<ReturnType<ExecutionSession['executeCase']>>;

async function saveCaseResult(runId: string, tc: CaseRow, executions: Execution[], viewports: Array<{ width: number; height: number }>, override?: { status: 'FLAKY'; actual: string }) {
  const failed = executions.find((item) => item.result === 'FAIL');
  const blocked = executions.find((item) => item.result === 'BLOCKED');
  // 실행 중 판정된 정책 확인 대상(예: 401/403 인증 필요 페이지)
  const needsCheck = executions.find((item) => item.result === 'REQUIREMENT_CHECK');
  const requirementCheck = Boolean(needsCheck) || Boolean((tc.metadata as Record<string, unknown> | null)?.requirementCheck);
  const status = override?.status ?? (failed ? 'FAIL' : blocked ? 'BLOCKED' : requirementCheck ? 'REQUIREMENT_CHECK' : 'PASS');
  const viewportText = viewports.filter((v) => v.width).map((v) => `${v.width}x${v.height}`).join(', ');

  const actual = override?.actual ??
    failed?.actual ??
    blocked?.actual ??
    needsCheck?.actual ??
    (requirementCheck
      ? '기술 검증은 통과했으나 기대 동작 정책 확인이 필요합니다.'
      : executions.length === 1 ? executions[0]!.actual : `모든 viewport(${viewportText})를 통과했습니다.`);

  let savedId: string;
  try {
    const saved = await prisma.testResult.create({
      data: {
        runId,
        testCaseId: tc.id,
        result: status,
        actual,
        durationMs: executions.reduce((sum, item) => sum + item.durationMs, 0),
        networkLogs: executions.flatMap((item) => item.networkLogs) as any,
        consoleLogs: executions.flatMap((item) => item.consoleLogs)
      }
    });
    savedId = saved.id;
  } catch (error) {
    // 같은 작업이 중복 전달되어 이미 저장된 경우(unique: runId+testCaseId) → 건너뜀
    if ((error as { code?: string }).code === 'P2002') return;
    throw error;
  }

  const artifacts = executions.flatMap((execution) => [
    ...execution.screenshots.filter(Boolean).map((p) => ({ runId, testResultId: savedId, type: 'SCREENSHOT' as const, path: p })),
    ...(execution.tracePath ? [{ runId, testResultId: savedId, type: 'TRACE' as const, path: execution.tracePath }] : [])
  ]);
  if (artifacts.length) await prisma.artifact.createMany({ data: artifacts });

  if (status === 'FAIL') {
    await prisma.issue.create({
      data: {
        testResultId: savedId,
        description: actual,
        expected: JSON.stringify(tc.expected),
        actual,
        reproductionSteps: JSON.stringify(tc.steps),
        severity: tc.severity,
        rootCauseCandidate: actual.slice(0, 240)
      }
    });
  }
}
