import type { QueueJob, RunJob, AnalyzeJob } from '@autohands/shared';
import { executeAnalysis, failAnalysis } from './analysis.js';
import { executeRun, failRun } from './orchestrator.js';

/** 큐 작업 1건 처리 (워커와 API 인프로세스 폴백이 공통으로 사용) */
export async function processJob(job: RunJob | AnalyzeJob | QueueJob): Promise<void> {
  if (job.type === 'ANALYZE') return executeAnalysis(job.jobId);
  return executeRun(job.runId, job.onlyCaseIds);
}

/** 재시도를 포기한 작업을 DB 에 실패로 기록 */
export async function failJob(job: RunJob | AnalyzeJob | QueueJob, reason: string): Promise<void> {
  if (job.type === 'ANALYZE') return failAnalysis(job.jobId, reason);
  return failRun(job.runId, reason);
}

export const describeJob = (job: RunJob | AnalyzeJob | QueueJob) =>
  job.type === 'ANALYZE' ? `ANALYZE jobId=${job.jobId}` : `RUN runId=${job.runId}${job.onlyCaseIds ? ` (재테스트 ${job.onlyCaseIds.length}건)` : ''}`;
