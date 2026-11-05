import { discover } from '@autohands/browser-runner';
import { assertSafeTarget, decryptSecret, getEncryptionKey, isForbiddenRequestUrl, maskSecretText, targetPolicyFromEnv } from '@autohands/core';
import type { DiscoveryResult, TestStrategy } from '@autohands/shared';
import { createAIProvider, type GeneratedCase } from '@autohands/test-generator';
import { prisma } from './db.js';

export type AnalysisSummary = {
  pages: number; forms: number; inputs: number; buttons: number; apis: number;
  generated: number; byStrategy: Record<string, number>;
};

const normalizeUrl = (raw: string) => {
  try { const u = new URL(raw); u.hash = ''; return u.href; } catch { return raw; }
};

/**
 * 생성된 TC 를 저장합니다. (기존 케이스 정리 + 신규 저장을 하나의 트랜잭션으로)
 * 첫 navigate URL 과 일치하는 Feature 에 연결해 리포트의 Menu/Page/URL 이 채워지도록 합니다.
 */
export async function saveGeneratedCases(projectId: string, generated: GeneratedCase[], replace: boolean) {
  const features = await prisma.feature.findMany({ where: { projectId }, select: { id: true, url: true } });
  const featureByUrl = new Map(features.filter((f) => f.url).map((f) => [normalizeUrl(f.url!), f.id]));
  const featureIdFor = (tc: GeneratedCase) => {
    const nav = [...tc.steps].sort((a, b) => a.order - b.order).find((s) => s.action === 'navigate');
    return nav ? featureByUrl.get(normalizeUrl(String(nav.value))) ?? null : null;
  };

  await prisma.$transaction(async (tx) => {
    if (replace) {
      // 이전 실행 결과(TestResult)가 엮인 케이스는 Restrict 외래키 오류 방지를 위해 비활성화(아카이빙)
      // (업로드한 QA 시나리오 시트의 케이스는 건드리지 않음: suiteId: null)
      await tx.testCase.updateMany({ where: { projectId, suiteId: null, results: { some: {} } }, data: { enabled: false } });
      // 실행 이력이 없는 케이스만 삭제
      await tx.testCase.deleteMany({ where: { projectId, suiteId: null, results: { none: {} } } });
    }
    if (generated.length) {
      await tx.testCase.createMany({
        data: generated.map((tc) => ({
          ...tc,
          projectId,
          featureId: featureIdFor(tc),
          testData: tc.testData as any,
          steps: tc.steps as any,
          expected: tc.expected as any,
          metadata: tc.metadata as any
        }))
      });
    }
  });

  const byStrategy: Record<string, number> = {};
  for (const tc of generated) byStrategy[tc.strategy] = (byStrategy[tc.strategy] ?? 0) + 1;
  return { count: generated.length, byStrategy };
}

export async function failAnalysis(jobId: string, reason: string) {
  await prisma.analysisJob.updateMany({
    where: { id: jobId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'FAILED', error: reason.slice(0, 2000), finishedAt: new Date() }
  });
}

/** 서비스 구조 분석(Discovery) → Feature 저장 → TC 생성/저장 */
export async function executeAnalysis(jobId: string): Promise<void> {
  const job = await prisma.analysisJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { environment: { include: { credentials: true } } }
  });
  if (!['QUEUED', 'RUNNING'].includes(job.status)) return;
  await prisma.analysisJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date(), error: null } });

  try {
    const env = job.environment;
    if (!env.webUrl) throw new Error('Web URL 이 필요합니다.');
    const credential = env.credentials[0];
    const policy = targetPolicyFromEnv();
    await assertSafeTarget(env.webUrl, policy);
    const discovery: DiscoveryResult = await discover(
      {
        url: env.webUrl,
        username: credential?.username,
        password: credential ? decryptSecret(credential.encryptedPassword, getEncryptionKey()) : undefined
      },
      Number(process.env.DISCOVERY_MAX_PAGES ?? 20) || 20,
      // 운영 환경은 버튼 클릭 탐색을 하지 않음 (링크 이동만)
      { requestGuard: (url) => isForbiddenRequestUrl(url, policy), production: env.isProduction, exploreClicks: process.env.DISCOVERY_EXPLORE_CLICKS !== 'false' }
    );

    await prisma.$transaction([
      prisma.feature.deleteMany({ where: { projectId: job.projectId } }),
      prisma.environment.update({ where: { id: env.id }, data: { discovery: discovery as any } })
    ]);
    if (discovery.pages.length) {
      await prisma.feature.createMany({
        data: discovery.pages.map((page) => ({
          projectId: job.projectId,
          platform: 'PC_WEB' as const,
          page: page.title,
          url: page.url,
          name: page.title || page.url,
          metadata: page as any
        }))
      });
    }

    const strategies = (Array.isArray(job.strategies) ? job.strategies : ['NORMAL', 'EXCEPTION', 'BOUNDARY']) as TestStrategy[];
    const generated = await createAIProvider().generateTestCases(discovery, strategies);
    const saved = await saveGeneratedCases(job.projectId, generated, job.replace);

    const summary: AnalysisSummary = {
      pages: discovery.pages.length,
      forms: discovery.pages.reduce((n, p) => n + p.forms, 0),
      inputs: discovery.pages.reduce((n, p) => n + p.inputs.length, 0),
      buttons: discovery.pages.reduce((n, p) => n + p.buttons.length, 0),
      apis: discovery.networkEndpoints.length,
      generated: saved.count,
      byStrategy: saved.byStrategy
    };
    await prisma.analysisJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { status: 'COMPLETED', summary: summary as any, finishedAt: new Date() }
    });
  } catch (error) {
    await failAnalysis(jobId, maskSecretText(error instanceof Error ? error.message : String(error)));
  }
}
