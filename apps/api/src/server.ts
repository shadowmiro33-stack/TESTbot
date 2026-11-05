import { prisma } from './db.js';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { z } from 'zod';
import { assertSafeTarget, encryptSecret, getEncryptionKey } from '@autohands/core';
import { createExcelReport, createZip } from '@autohands/report';
import { STRATEGIES, countLiveWorkers, enqueueJob, type AnalyzeJob, type RunJob } from '@autohands/shared';
import { createAIProvider } from '@autohands/test-generator';
import { AppiumClient } from '@autohands/browser-runner';
import { saveGeneratedCases } from './analysis.js';
import { buildSuiteResultFile, buildSuiteReview, importDesignedSuite, importSuite, refineSuiteWithAI } from './suites.js';
import { describeJob, processJob } from './jobs.js';
import {
  authConfigFromEnv, clearLoginFailures, clearedCookie, isAuthenticated, loginBlocked, recordLoginFailure, sessionCookie, verifyToken
} from './auth.js';

const authConfig = authConfigFromEnv();

const app = Fastify({
  // 분석/실행은 백그라운드 작업이므로 긴 HTTP 타임아웃이 필요 없습니다. (TC 재생성 시 LLM 호출 최대 60초 고려)
  connectionTimeout: 90_000,
  logger: {
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password'
    ]
  }
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const allowedOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
/**
 * 허용 규칙
 * - Origin 헤더 없음(서버 간 호출, curl 등) → 허용
 * - CORS_ORIGIN 에 명시된 출처와 정확히 일치 → 허용
 * - 운영(NODE_ENV=production)이 아니면 localhost / 127.0.0.1 출처(포트 무관) 허용
 * - 그 외 → 거부 (기존: 정규식 부분 일치로 evil-localhost.com 도 허용, CORS_ORIGIN 미설정 시 전체 허용)
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

await app.register(cors, {
  origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => cb(null, isAllowedOrigin(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
});
await app.register(sensible);

// ── 인증 ────────────────────────────────────────────────────────────────────
const PUBLIC_PATHS = new Set(['/health', '/api/auth/login', '/api/auth/logout', '/api/auth/session']);
if (!authConfig.token) app.log.warn('API_TOKEN 이 설정되지 않아 인증 없이 동작합니다. (개발 모드 전용 — 공유 서버에서는 반드시 설정하세요)');

app.addHook('onRequest', async (request: any, reply: any) => {
  if (!authConfig.token || request.method === 'OPTIONS') return;
  const pathname = String(request.url).split('?')[0] ?? '';
  if (PUBLIC_PATHS.has(pathname) || !pathname.startsWith('/api/')) return;
  if (isAuthenticated(authConfig, request.headers)) return;
  return reply.code(401).send({ message: '로그인이 필요합니다.', code: 'AUTH_REQUIRED' });
});

app.get('/api/auth/session', async (request: any) => ({
  authRequired: Boolean(authConfig.token),
  authenticated: isAuthenticated(authConfig, request.headers)
}));

/**
 * 로그인 시도 제한용 클라이언트 IP.
 * Cloudflare Tunnel 뒤(공개 모드)에서는 모든 요청이 127.0.0.1 로 보이므로, 한 사람의 실패가 전원을 막지 않도록
 * Cloudflare 가 덮어쓰는 CF-Connecting-IP 를 사용합니다. 위조 방지를 위해 API 가 루프백에서만 수신할 때만 신뢰합니다.
 */
function clientIp(request: any): string {
  const loopbackOnly = (process.env.API_HOST ?? '').trim().startsWith('127.');
  const cf = request.headers['cf-connecting-ip'];
  if (process.env.TRUST_CF_CONNECTING_IP === 'true' && loopbackOnly && typeof cf === 'string' && cf) return cf;
  return String(request.ip ?? 'unknown');
}

app.post('/api/auth/login', async (request: any, reply: any) => {
  if (!authConfig.token) return { ok: true, authRequired: false };
  const ip = clientIp(request);
  if (loginBlocked(ip)) throw app.httpErrors.tooManyRequests('로그인 시도가 너무 많습니다. 5분 후 다시 시도하세요.');
  const { token } = z.object({ token: z.string().min(1).max(512) }).parse(request.body ?? {});
  if (!verifyToken(authConfig, token)) {
    recordLoginFailure(ip);
    await new Promise((r) => setTimeout(r, 400)); // 무차별 대입 속도 저하
    return reply.code(401).send({ message: '접근 토큰이 올바르지 않습니다.', code: 'AUTH_INVALID' });
  }
  clearLoginFailures(ip);
  return reply.header('Set-Cookie', sessionCookie(authConfig)).send({ ok: true });
});

app.post('/api/auth/logout', async (_request: any, reply: any) => reply.header('Set-Cookie', clearedCookie(authConfig)).send({ ok: true }));

const artifactRoot = path.resolve(process.env.ARTIFACT_ROOT ?? './artifacts');

/** Prisma cuid 형식만 허용 → 파일 경로 조합 시 경로 조작(../) 방지 */
const RUN_ID_PATTERN = /^[a-z0-9]{20,40}$/i;
function runIdParam(params: unknown): string {
  const { id } = params as { id?: string };
  if (!id || !RUN_ID_PATTERN.test(id)) throw app.httpErrors.badRequest('잘못된 실행 ID 입니다.');
  return id;
}
/** artifactRoot 하위 경로인지 확인 */
function insideArtifactRoot(target: string) {
  const relative = path.relative(artifactRoot, path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const redisUrl = process.env.REDIS_URL;
let redisClient: any = null;
if (redisUrl) {
  const ioredisModule = (await import('ioredis').catch(() => null)) as any;
  const Redis = ioredisModule?.default ?? ioredisModule?.Redis;
  if (Redis) {
    // 연결을 기다리지 않습니다. ioredis 가 백그라운드에서 재연결하며, 연결 전/끊김 동안에는 인프로세스로 실행합니다.
    // enableOfflineQueue: false → 끊긴 동안 명령이 쌓이지 않고 즉시 실패해 폴백이 동작합니다.
    redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    redisClient.on('ready', () => app.log.info({ redisUrl }, 'Redis 분산 큐 연결 완료'));
    let warned = false;
    redisClient.on('error', (err: Error) => {
      if (!warned) app.log.warn({ err: err.message || (err as NodeJS.ErrnoException).code || String(err) }, 'Redis 연결 불가 - 연결될 때까지 인프로세스 실행 모드로 동작합니다.');
      warned = true;
    });
    // 시작 직후 정리 로직이 워커 유무를 판단할 수 있도록 잠시 연결을 기다림 (최대 3초)
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 3_000);
      redisClient.once('ready', done);
    });
  }
}

const redisReady = () => Boolean(redisClient && redisClient.status === 'ready');
const liveWorkers = async () => (redisReady() ? countLiveWorkers(redisClient).catch(() => 0) : 0);

const runInProcess = (job: RunJob | AnalyzeJob) =>
  setImmediate(() => void processJob(job).catch((error) => app.log.error({ err: error }, `인프로세스 작업 실패: ${describeJob(job)}`)));

/**
 * 작업 배정: Redis 가 연결되어 있고 살아 있는 워커가 있으면 큐에 등록,
 * 아니면 API 프로세스 안에서 직접 실행합니다. (워커가 없는데 큐에만 쌓여 영원히 QUEUED 로 남는 문제 방지)
 */
async function dispatch(job: RunJob | AnalyzeJob) {
  if ((await liveWorkers()) > 0) {
    try {
      await enqueueJob(redisClient, job);
      app.log.info(`큐 등록: ${describeJob(job)}`);
      return 'queue' as const;
    } catch (err) {
      app.log.error({ err }, 'Redis 큐 등록 실패 - 인프로세스 실행으로 폴백');
    }
  } else if (redisReady()) {
    app.log.warn(`살아 있는 워커가 없어 API 프로세스에서 직접 실행합니다: ${describeJob(job)}`);
  }
  runInProcess(job);
  return 'in-process' as const;
}

// 서버 시작 시 정리: 워커가 없다면 RUNNING 상태 작업은 (죽은) API 프로세스 안에서 돌던 것이므로 실패 처리.
// 워커가 살아 있으면 워커 소유일 수 있으므로 건드리지 않습니다(워커 장애는 워커 측 reclaim 이 처리).
try {
  if ((await liveWorkers()) === 0) {
    const interrupted = { status: 'FAILED' as const, finishedAt: new Date(), error: 'API 서버 재시작으로 실행이 중단되었습니다.' };
    await prisma.testRun.updateMany({ where: { status: 'RUNNING' }, data: interrupted });
    await prisma.analysisJob.updateMany({ where: { status: 'RUNNING' }, data: interrupted });
  }
} catch (e) {
  app.log.warn({ err: e }, '초기 작업 상태 정리 중 오류 발생');
}

/**
 * TC 를 바꾸는 작업(분석/재생성)과 TC 를 읽는 작업(실행)이 동시에 돌지 않도록 막습니다.
 * - action 'TC 재생성': 진행 중인 실행 또는 분석이 있으면 409
 * - action '테스트 실행': 진행 중인 분석이 있으면 409
 */
async function assertNoActiveWork(projectId: string, action: 'TC 재생성' | '테스트 실행') {
  const analysis = await prisma.analysisJob.findFirst({
    where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true }
  });
  if (analysis) throw app.httpErrors.conflict(`분석(TC 생성)이 진행 중이라 ${action}을(를) 시작할 수 없습니다. 분석이 끝난 뒤 다시 시도하세요.`);
  if (action === 'TC 재생성') {
    const run = await prisma.testRun.findFirst({
      where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true }
    });
    if (run) throw app.httpErrors.conflict('테스트 실행이 진행 중입니다. 실행이 끝나거나 취소한 뒤 다시 시도하세요.');
  }
}

/** 환경 요약 필드 (discovery JSON 은 크므로 목록/폴링 응답에서 제외) */
const ENV_SUMMARY = { id: true, projectId: true, name: true, webUrl: true, apiUrl: true, isProduction: true, platform: true, appConfig: true, createdAt: true } as const;
const SUITE_SUMMARY = { id: true, name: true, fileName: true, meta: true, enabled: true, createdAt: true } as const;
const APP_ENV_PLATFORMS = new Set(['ANDROID', 'IOS']);

app.get('/health', async () => {
  const workers = await liveWorkers();
  return { status: 'ok', queue: redisReady() ? 'redis' : 'in-process', workers, authRequired: Boolean(authConfig.token) };
});

app.post('/api/projects', async (request, reply) => {
  const body = z.object({
    name: z.string().min(1),
    platforms: z.array(z.enum(['BACK_OFFICE', 'PC_WEB', 'RESPONSIVE_WEB', 'ANDROID', 'IOS'])).min(1)
  }).parse(request.body);

  const created = await prisma.project.create({ data: body });
  return reply.code(201).send(created);
});

app.get('/api/projects', async () => {
  return prisma.project.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      environments: { select: ENV_SUMMARY },
      suites: { select: { id: true }, where: { enabled: true } },
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        // 목록 카드에는 결과 상태만 필요 (로그 JSON 제외)
        include: { results: { select: { id: true, result: true } } }
      },
      _count: {
        // TC 재생성 시 실행 이력이 있는 이전 케이스는 비활성화(아카이빙)되어 남으므로, 현재 사용 중인 케이스만 집계
        select: { features: true, testCases: { where: { enabled: true, suiteId: null } } }
      }
    }
  });
});

app.get('/api/projects/:id', async (request) => {
  const { id } = request.params as { id: string };
  return prisma.project.findUniqueOrThrow({
    where: { id },
    include: {
      environments: {
        select: {
          ...ENV_SUMMARY,
          credentials: {
            select: { id: true, role: true, username: true, createdAt: true }
          },
          analysisJobs: { orderBy: { createdAt: 'desc' }, take: 1 }
        }
      },
      suites: { select: SUITE_SUMMARY, where: { enabled: true }, orderBy: { createdAt: 'desc' } },
      // features / testCases 전체 목록은 별도 API(/test-cases)로 조회 → 상세 응답에서는 개수(_count)만 제공
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { results: { select: { id: true, result: true } } }
      },
      _count: {
        // TC 재생성 시 실행 이력이 있는 이전 케이스는 비활성화(아카이빙)되어 남으므로, 현재 사용 중인 케이스만 집계
        select: { features: true, testCases: { where: { enabled: true, suiteId: null } } }
      }
    }
  });
});

app.post('/api/projects/:id/environments', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = z.object({
    name: z.string().min(1),
    platform: z.enum(['BACK_OFFICE', 'PC_WEB', 'RESPONSIVE_WEB', 'ANDROID', 'IOS']).default('PC_WEB'),
    webUrl: z.string().url().optional(),
    apiUrl: z.string().url().optional(),
    isProduction: z.boolean().default(false),
    appConfig: z.object({
      appId: z.string().max(200).regex(/^[\w.-]+$/, '앱 ID(패키지명/번들 ID) 형식이 올바르지 않습니다.').optional(),
      deviceName: z.string().max(120).optional(),
      udid: z.string().max(120).optional(),
      app: z.string().max(500).optional(),
      appActivity: z.string().max(200).optional(),
      automationName: z.string().max(60).optional()
    }).optional()
  }).parse(request.body);
  const isApp = APP_ENV_PLATFORMS.has(body.platform);
  if (!isApp && !body.webUrl) throw app.httpErrors.badRequest('웹 환경에는 Web URL 이 필요합니다.');
  if (isApp && !body.appConfig?.appId && !body.appConfig?.app) throw app.httpErrors.badRequest('앱 환경에는 앱 ID(패키지명/번들 ID) 또는 설치 파일 경로가 필요합니다.');
  // SSRF 방지: 메타데이터/금지 대역 주소는 등록 단계에서 거부 (TargetBlockedError → 400)
  if (body.webUrl) await assertSafeTarget(body.webUrl);

  const created = await prisma.environment.create({
    data: { ...body, appConfig: isApp ? (body.appConfig as any) : undefined, projectId: id }
  });
  return reply.code(201).send(created);
});

app.post('/api/environments/:id/credentials', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = z.object({
    role: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1)
  }).parse(request.body);

  const encryptionKey = getEncryptionKey();
  const created = await prisma.credential.create({
    data: {
      environmentId: id,
      role: body.role,
      username: body.username,
      encryptedPassword: encryptSecret(body.password, encryptionKey)
    },
    select: { id: true, role: true, username: true, createdAt: true }
  });
  return reply.code(201).send(created);
});

app.post('/api/environments/:id/analyze', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = z.object({
    strategies: z.array(z.enum(STRATEGIES)).min(1).default(['NORMAL', 'EXCEPTION', 'BOUNDARY']),
    replace: z.boolean().default(true)
  }).parse(request.body ?? {});

  const env = await prisma.environment.findUniqueOrThrow({ where: { id } });
  if (APP_ENV_PLATFORMS.has(env.platform)) throw app.httpErrors.badRequest('앱 환경은 화면 자동 분석을 지원하지 않습니다. QA 시나리오 시트를 올려 실행하세요.');
  if (!env.webUrl) throw app.httpErrors.badRequest('Web URL이 필요합니다.');

  // 실행 중에 TC 를 재생성하면 아직 실행되지 않은 케이스가 삭제되어 실행이 깨지므로 차단
  const activeRun = await prisma.testRun.findFirst({
    where: { projectId: env.projectId, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true }
  });
  if (activeRun) throw app.httpErrors.conflict('테스트 실행이 진행 중입니다. 실행이 끝나거나 취소한 뒤 다시 분석하세요.');

  // 같은 환경에 진행 중인 분석이 있으면 새로 만들지 않고 기존 작업을 반환
  const active = await prisma.analysisJob.findFirst({
    where: { environmentId: id, status: { in: ['QUEUED', 'RUNNING'] } },
    orderBy: { createdAt: 'desc' }
  });
  if (active) return reply.code(202).send(active);

  const job = await prisma.analysisJob.create({
    data: { projectId: env.projectId, environmentId: id, strategies: body.strategies, replace: body.replace }
  });
  await dispatch({ type: 'ANALYZE', jobId: job.id });
  return reply.code(202).send(job);
});

app.get('/api/analysis-jobs/:id', async (request) => {
  const { id } = request.params as { id: string };
  return prisma.analysisJob.findUniqueOrThrow({ where: { id } });
});

app.get('/api/projects/:id/test-cases', async (request) => {
  const { id } = request.params as { id: string };
  const query = request.query as { all?: string; suiteId?: string };
  const showAll = query.all === 'true';

  return prisma.testCase.findMany({
    where: {
      projectId: id,
      // 기본: 자동 생성 케이스만, suiteId 지정 시 그 시나리오 시트의 케이스
      suiteId: query.suiteId || null,
      ...(showAll ? {} : { enabled: true })
    },
    include: { feature: true },
    orderBy: query.suiteId ? [{ sheetName: 'asc' }, { rowNumber: 'asc' }] : { createdAt: 'asc' }
  });
});

app.post('/api/projects/:id/test-cases/generate', async (request) => {
  const { id } = request.params as { id: string };
  const body = z.object({
    strategies: z.array(z.enum(STRATEGIES)).default(['NORMAL', 'EXCEPTION', 'BOUNDARY']),
    replace: z.boolean().default(true)
  }).parse(request.body ?? {});

  const env = await prisma.environment.findFirstOrThrow({
    where: { projectId: id },
    orderBy: { createdAt: 'desc' }
  });
  if (!env.discovery) throw app.httpErrors.badRequest('먼저 분석을 실행하세요.');
  await assertNoActiveWork(id, 'TC 재생성');

  const generated = await createAIProvider().generateTestCases(env.discovery as any, body.strategies);
  return saveGeneratedCases(id, generated, body.replace);
});

app.post('/api/projects/:id/runs', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = z.object({
    environmentId: z.string(),
    credentialId: z.string().optional(),
    suiteId: z.string().optional(),
    sheets: z.array(z.string().max(200)).max(50).optional(),
    mode: z.enum(['SMOKE', 'REGRESSION', 'FULL_MATRIX', 'FAIL_RETEST']).default('SMOKE')
  }).parse(request.body);
  await assertNoActiveWork(id, '테스트 실행');
  const env = await prisma.environment.findFirst({ where: { id: body.environmentId, projectId: id }, select: { platform: true } });
  if (!env) throw app.httpErrors.badRequest('이 프로젝트의 환경이 아닙니다.');
  if (body.suiteId) {
    const suite = await prisma.testSuite.findFirst({ where: { id: body.suiteId, projectId: id, enabled: true }, select: { id: true } });
    if (!suite) throw app.httpErrors.badRequest('시나리오 시트를 찾을 수 없습니다.');
  } else if (APP_ENV_PLATFORMS.has(env.platform)) {
    throw app.httpErrors.badRequest('앱 환경은 QA 시나리오 시트를 선택해 실행하세요.');
  }

  const run = await prisma.testRun.create({
    data: {
      projectId: id,
      environmentId: body.environmentId,
      credentialId: body.credentialId,
      suiteId: body.suiteId,
      sheetFilter: body.suiteId ? body.sheets ?? [] : [],
      mode: body.mode
    }
  });
  await dispatch({ type: 'RUN', runId: run.id });
  return reply.code(202).send(run);
});

app.get('/api/runs/:id', async (request) => {
  const { id } = request.params as { id: string };
  return prisma.testRun.findUniqueOrThrow({
    where: { id },
    include: {
      project: true,
      environment: { select: ENV_SUMMARY },
      suite: { select: { id: true, name: true, fileName: true } },
      // encryptedPassword 가 응답에 포함되지 않도록 필요한 필드만 선택
      credential: { select: { id: true, role: true, username: true } },
      // 대시보드가 1.8초마다 폴링하는 응답 → 네트워크/콘솔 로그(JSON)와 산출물 목록은 제외하고 요약만 전달
      // (케이스별 상세는 GET /api/results/:id)
      results: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, testCaseId: true, result: true, actual: true, durationMs: true, createdAt: true, manualResult: true, manualNote: true,
          testCase: { select: { id: true, title: true, strategy: true, severity: true, sourceType: true, externalId: true, sheetName: true } }
        }
      }
    }
  });
});

/** 실행 결과 목록 (필터·검색·페이지) — 결과 화면용. 판정은 사람이 정한 값(manualResult)이 있으면 그것을 사용 */
app.get('/api/runs/:id/results', async (request) => {
  const id = runIdParam(request.params);
  const q = request.query as { status?: string; q?: string; skip?: string; take?: string };
  const rows = await prisma.testResult.findMany({
    where: { runId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, result: true, manualResult: true, manualNote: true, reviewedAt: true, actual: true, durationMs: true,
      testCase: { select: { id: true, title: true, externalId: true, sheetName: true, rowNumber: true, strategy: true, metadata: true } },
      artifacts: { select: { id: true, type: true, path: true } }
    }
  });
  const effective = (r: { result: string; manualResult: string | null }) => r.manualResult ?? r.result;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[effective(r)] = (counts[effective(r)] ?? 0) + 1;
  const needsReview = (r: (typeof rows)[number]) => !r.manualResult && ['REQUIREMENT_CHECK', 'FLAKY', 'FAIL', 'SKIP', 'BLOCKED'].includes(r.result);
  const text = (q.q ?? '').trim().toLowerCase();
  const filtered = rows
    .filter((r) => !q.status || q.status === 'ALL' || (q.status === 'NEEDS_REVIEW' ? needsReview(r) : effective(r) === q.status))
    .filter((r) => !text || `${r.testCase.externalId ?? ''} ${r.testCase.sheetName ?? ''} ${r.testCase.title} ${r.actual ?? ''}`.toLowerCase().includes(text))
    // 정렬: 시트 → 행 순서 (시트 실행), 그 외는 실행 순서
    .sort((a, b) => (a.testCase.sheetName ?? '').localeCompare(b.testCase.sheetName ?? '') || (a.testCase.rowNumber ?? 0) - (b.testCase.rowNumber ?? 0));
  const skip = Math.max(0, Number(q.skip ?? 0) || 0);
  const take = Math.min(200, Math.max(1, Number(q.take ?? 50) || 50));
  return {
    total: filtered.length,
    counts: { ...counts, NEEDS_REVIEW: rows.filter(needsReview).length, ALL: rows.length },
    items: filtered.slice(skip, skip + take).map((r) => {
      const m = (r.testCase.metadata ?? {}) as { menuPath?: string[]; item?: string };
      return {
        id: r.id, result: r.result, manualResult: r.manualResult, manualNote: r.manualNote, reviewedAt: r.reviewedAt, actual: r.actual, durationMs: r.durationMs,
        testCase: { id: r.testCase.id, title: r.testCase.title, externalId: r.testCase.externalId, sheetName: r.testCase.sheetName, strategy: r.testCase.strategy, menuPath: m.menuPath ?? [], item: m.item ?? null },
        // 파일 경로는 내보내지 않고 ID 만 (보기: /api/artifacts/:id/file)
        screenshots: r.artifacts.filter((a) => a.type === 'SCREENSHOT').sort((a, b) => a.path.localeCompare(b.path)).map((a) => ({ id: a.id, name: path.basename(a.path) }))
      };
    })
  };
});

/** 사람 판정: 재확인·테스트불가·실패 항목을 O(PASS)/F(FAIL)/NT(SKIP) 로 확정. null 이면 자동 판정으로 되돌림 */
app.patch('/api/results/:id', async (request) => {
  const { id } = request.params as { id: string };
  const body = z.object({
    manualResult: z.enum(['PASS', 'FAIL', 'SKIP']).nullable(),
    manualNote: z.string().max(2000).optional()
  }).parse(request.body);
  return prisma.testResult.update({
    where: { id },
    data: { manualResult: body.manualResult, manualNote: body.manualResult ? body.manualNote?.trim() || null : null, reviewedAt: body.manualResult ? new Date() : null },
    select: { id: true, result: true, manualResult: true, manualNote: true, reviewedAt: true }
  });
});

/** 스크린샷 보기 (artifactRoot 안의 이미지 파일만) */
app.get('/api/artifacts/:id/file', async (request, reply) => {
  const { id } = request.params as { id: string };
  const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id }, select: { path: true, type: true } });
  if (artifact.type !== 'SCREENSHOT' || !insideArtifactRoot(artifact.path) || !existsSync(artifact.path)) throw app.httpErrors.notFound('파일이 없습니다.');
  return reply.header('Cache-Control', 'private, max-age=3600').type('image/png').send(createReadStream(artifact.path));
});

app.get('/api/results/:id', async (request) => {
  const { id } = request.params as { id: string };
  return prisma.testResult.findUniqueOrThrow({
    where: { id },
    include: { testCase: true, artifacts: true, issue: true }
  });
});

app.post('/api/runs/:id/cancel', async (request) => {
  const id = runIdParam(request.params);
  const { count } = await prisma.testRun.updateMany({
    where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() }
  });
  if (!count) throw app.httpErrors.conflict('대기 중이거나 실행 중인 테스트만 취소할 수 있습니다.');
  return prisma.testRun.findUniqueOrThrow({ where: { id } });
});

app.post('/api/runs/:id/retest-fails', async (request, reply) => {
  const { id } = request.params as { id: string };
  const source = await prisma.testRun.findUniqueOrThrow({
    where: { id },
    include: { results: { where: { OR: [{ result: 'FAIL', manualResult: null }, { manualResult: 'FAIL' }] } } }
  });
  if (!source.results.length) throw app.httpErrors.badRequest('재테스트할 FAIL 케이스가 없습니다.');
  await assertNoActiveWork(source.projectId, '테스트 실행');

  const run = await prisma.testRun.create({
    data: {
      projectId: source.projectId,
      environmentId: source.environmentId,
      credentialId: source.credentialId,
      suiteId: source.suiteId,
      mode: 'FAIL_RETEST'
    }
  });
  await dispatch({ type: 'RUN', runId: run.id, onlyCaseIds: source.results.map((r) => r.testCaseId) });
  return reply.code(202).send(run);
});

app.get('/api/runs/:id/report.xlsx', async (request, reply) => {
  const id = runIdParam(request.params);
  const run = await prisma.testRun.findUniqueOrThrow({
    where: { id },
    include: {
      project: true,
      results: {
        include: {
          testCase: { include: { feature: true } },
          artifacts: true,
          issue: true
        }
      },
      artifacts: true
    }
  });

  const out = path.join(
    artifactRoot,
    `QA_RUN_${id}`,
    `QA_Result_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}.xlsx`
  );

  // 사람이 확정한 판정이 있으면 보고서도 그 판정으로
  const results = run.results.map((r) => (r.manualResult ? { ...r, result: r.manualResult, actual: r.manualNote ? `[확인] ${r.manualNote}` : r.actual } : r));
  await createExcelReport(
    {
      run: { ...run, results },
      testCases: results.map((r) => r.testCase),
      results,
      artifacts: results.flatMap((r) => r.artifacts.map((a) => ({ ...a, testResult: r }))),
      issues: results.flatMap((r) => (r.issue ? [{ ...r.issue, testResult: r }] : []))
    },
    out
  );

  if (!existsSync(out)) throw app.httpErrors.notFound();
  return reply
    .header('Content-Disposition', `attachment; filename="${path.basename(out)}"`)
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(createReadStream(out));
});

app.get('/api/runs/:id/sheet.xlsx', async (request, reply) => {
  const id = runIdParam(request.params);
  const out = path.join(artifactRoot, `QA_RUN_${id}`, 'sheet_result.xlsx');
  const { fileName } = await buildSuiteResultFile(id, out);
  return reply
    .header('Content-Disposition', `attachment; filename="sheet_result.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(createReadStream(out));
});

// ── QA 시나리오 시트 ─────────────────────────────────────────────────────────
app.post('/api/projects/:id/suites', { bodyLimit: 30 * 1024 * 1024 }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = z.object({
    fileName: z.string().min(1).max(200),
    contentBase64: z.string().min(1),
    name: z.string().max(120).optional()
  }).parse(request.body);
  await prisma.project.findUniqueOrThrow({ where: { id }, select: { id: true } });
  await assertNoActiveWork(id, 'TC 재생성');
  const result = await importSuite(id, { fileName: body.fileName, base64: body.contentBase64, name: body.name }, artifactRoot);
  return reply.code(201).send(result);
});

/** 기법 기반 TC(test-cases.json, 선택: test-model.json) → 팀 시트 양식으로 변환해 가져오기 */
app.post('/api/projects/:id/suites/designed', { bodyLimit: 30 * 1024 * 1024 }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const step = z.object({ action: z.string().min(1).max(500), data: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined ? undefined : String(v))) });
  const body = z.object({
    name: z.string().max(120).optional(),
    testCases: z.array(z.object({
      title: z.string().max(300).default(''),
      technique: z.string().max(80).optional(),
      priority: z.string().max(20).optional(),
      isNegative: z.boolean().optional(),
      preconditions: z.array(z.string().max(500)).max(30).optional(),
      steps: z.array(step).max(60).default([]),
      expectedResult: z.string().min(1).max(2000),
      coversIds: z.array(z.string().max(120)).max(60).optional(),
      rationale: z.string().max(1000).optional()
    }).passthrough()).min(1).max(5000),
    testModel: z.object({
      feature: z.string().max(200).optional(),
      openQuestions: z.array(z.object({ question: z.string().max(1000), why: z.string().max(1000).optional(), blocksTesting: z.boolean().optional() }).passthrough()).max(500).optional()
    }).passthrough().optional()
  }).parse(request.body);
  await prisma.project.findUniqueOrThrow({ where: { id }, select: { id: true } });
  await assertNoActiveWork(id, 'TC 재생성');
  const result = await importDesignedSuite(id, { cases: body.testCases, model: body.testModel, name: body.name }, artifactRoot);
  return reply.code(201).send(result);
});

/** 판정 가능성 점검: 자동으로 판정하지 못하는 항목과 수정 제안 */
app.get('/api/suites/:id/review.xlsx', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { buffer, fileName } = await buildSuiteReview(id);
  return reply
    .header('Content-Disposition', `attachment; filename="review.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(buffer);
});

/** 원본(또는 기법 기반 TC 에서 만든) 시트 내려받기 */
app.get('/api/suites/:id/original.xlsx', async (request, reply) => {
  const { id } = request.params as { id: string };
  const suite = await prisma.testSuite.findUniqueOrThrow({ where: { id }, select: { filePath: true, fileName: true } });
  if (!insideArtifactRoot(suite.filePath) || !existsSync(suite.filePath)) throw app.httpErrors.notFound('원본 파일이 없습니다.');
  return reply
    .header('Content-Disposition', `attachment; filename="suite.xlsx"; filename*=UTF-8''${encodeURIComponent(suite.fileName)}`)
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(createReadStream(suite.filePath));
});

app.get('/api/projects/:id/suites', async (request) => {
  const { id } = request.params as { id: string };
  return prisma.testSuite.findMany({ where: { projectId: id, enabled: true }, select: SUITE_SUMMARY, orderBy: { createdAt: 'desc' } });
});

app.delete('/api/suites/:id', async (request) => {
  const { id } = request.params as { id: string };
  const suite = await prisma.testSuite.findUniqueOrThrow({ where: { id }, select: { projectId: true } });
  await assertNoActiveWork(suite.projectId, 'TC 재생성');
  // 실행 이력 보존을 위해 삭제 대신 숨김 처리
  await prisma.testSuite.update({ where: { id }, data: { enabled: false } });
  return { ok: true };
});

app.post('/api/suites/:id/refine-ai', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!process.env.OPENAI_API_KEY) throw app.httpErrors.badRequest('AI 보강에는 서버 .env 의 OPENAI_API_KEY 가 필요합니다.');
  await prisma.testSuite.findUniqueOrThrow({ where: { id }, select: { id: true } });
  setImmediate(() => void refineSuiteWithAI(id).catch((err) => app.log.error({ err }, 'AI 보강 실패')));
  return reply.code(202).send({ ok: true });
});

app.patch('/api/test-cases/:id', async (request) => {
  const { id } = request.params as { id: string };
  const body = z.object({ enabled: z.boolean() }).parse(request.body);
  return prisma.testCase.update({ where: { id }, data: { enabled: body.enabled }, select: { id: true, enabled: true } });
});

/** 앱 실행기(Appium) 연결 상태 */
app.get('/api/app/status', async () => {
  const appiumUrl = process.env.APPIUM_URL || 'http://127.0.0.1:4723';
  try {
    const status = await new AppiumClient(appiumUrl, 4000).status();
    return { ok: true, appiumUrl, ready: status?.ready ?? true, message: status?.message ?? '' };
  } catch (error) {
    return { ok: false, appiumUrl, message: error instanceof Error ? error.message : String(error) };
  }
});

app.get('/api/runs/:id/artifacts.zip', async (request, reply) => {
  const id = runIdParam(request.params);
  await prisma.testRun.findUniqueOrThrow({ where: { id }, select: { id: true } });
  const dir = path.join(artifactRoot, `QA_RUN_${id}`);
  const out = path.join(artifactRoot, `${id}.zip`);
  if (!insideArtifactRoot(dir) || !insideArtifactRoot(out)) throw app.httpErrors.badRequest('잘못된 경로입니다.');
  if (!existsSync(dir)) throw app.httpErrors.notFound('아직 생성된 산출물이 없습니다.');
  await createZip(dir, out);

  return reply
    .header('Content-Disposition', `attachment; filename="QA_RUN_${id}.zip"`)
    .type('application/zip')
    .send(createReadStream(out));
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ message: '입력값을 확인하세요.', issues: error.issues });
  }
  if ((error as { code?: string }).code === 'P2025') {
    return reply.code(404).send({ message: '요청한 데이터를 찾을 수 없습니다.' });
  }
  app.log.error(error);
  return reply.code((error as any).statusCode ?? 500).send({
    message: error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.'
  });
});

const port = Number(process.env.API_PORT ?? 4000);
// 인증 없는 API 가 사내망에 노출되지 않도록, 토큰이 없으면 기본적으로 이 PC(127.0.0.1)에서만 수신
const host = process.env.API_HOST?.trim() || (authConfig.token ? '0.0.0.0' : '127.0.0.1');
if (host !== '127.0.0.1' && host !== 'localhost' && !authConfig.token) app.log.warn(`API_TOKEN 없이 ${host} 에서 수신합니다. 같은 네트워크의 누구나 API 에 접근할 수 있습니다.`);
await app.listen({ host, port });

