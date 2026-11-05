/**
 * Redis 기반 신뢰성 작업 큐 (Reliable Queue Pattern)
 *
 * - 작업은 공용 대기열(QUEUE_KEY)에 쌓이고, 워커는 BRPOPLPUSH 로 자신의 processing 목록으로 옮겨 처리합니다.
 * - 워커는 주기적으로 하트비트 키(EX 30s)를 갱신합니다.
 * - 하트비트가 끊긴 워커의 processing 목록에 남은 작업은 다른 워커가 대기열로 되돌립니다(reclaim).
 *   → 워커가 비정상 종료돼도 작업이 유실되지 않습니다. 실행 측은 이미 저장된 결과를 건너뛰고 이어서 실행합니다.
 */

export type RunJob = { type: 'RUN'; runId: string; onlyCaseIds?: string[] };
export type AnalyzeJob = { type: 'ANALYZE'; jobId: string };
export type QueueJob = (RunJob | AnalyzeJob) & { enqueuedAt: string; attempt?: number };
/** @deprecated QueueJob 사용 */
export type RunJobPayload = RunJob & { enqueuedAt: string };

export const QA_QUEUE_KEY = 'autohands:qa-runs:queue';
/** @deprecated 단일 processing 목록(구버전). reclaim 시 함께 회수합니다. */
export const QA_LEGACY_PROCESSING_KEY = 'autohands:qa-runs:processing';
export const QA_PROCESSING_PREFIX = 'autohands:qa-runs:processing:';
export const WORKER_HEARTBEAT_PREFIX = 'autohands:worker:heartbeat:';
export const WORKER_HEARTBEAT_TTL_SECONDS = 30;
/** 같은 작업이 이 횟수 이상 회수되면(워커를 반복해서 죽이는 작업) 더 이상 재시도하지 않습니다. */
export const MAX_JOB_ATTEMPTS = 3;

// 하위 호환용 별칭
export const QA_RUN_QUEUE_KEY = QA_QUEUE_KEY;
export const QA_RUN_PROCESSING_KEY = QA_LEGACY_PROCESSING_KEY;

export interface RedisLikeClient {
  lpush(key: string, ...values: (string | number)[]): Promise<number>;
  brpoplpush(source: string, destination: string, timeout: number): Promise<string | null>;
  rpoplpush(source: string, destination: string): Promise<string | null>;
  lrem(key: string, count: number, value: string | number): Promise<number>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  exists(...keys: string[]): Promise<number>;
  scan(cursor: string | number, matchToken: 'MATCH', pattern: string, countToken: 'COUNT', count: number): Promise<[string, string[]]>;
  status?: string;
}

export const processingKeyFor = (workerId: string) => `${QA_PROCESSING_PREFIX}${workerId}`;
export const heartbeatKeyFor = (workerId: string) => `${WORKER_HEARTBEAT_PREFIX}${workerId}`;

export function parseJob(raw: string): QueueJob | null {
  try {
    const parsed = JSON.parse(raw) as Partial<QueueJob> & { runId?: string };
    // 구버전 payload({ runId, onlyCaseIds }) 는 RUN 으로 간주
    if (!parsed.type && parsed.runId) return { ...(parsed as object), type: 'RUN', runId: parsed.runId, enqueuedAt: parsed.enqueuedAt ?? new Date().toISOString() } as QueueJob;
    if (parsed.type === 'RUN' && typeof parsed.runId === 'string') return parsed as QueueJob;
    if (parsed.type === 'ANALYZE' && typeof (parsed as AnalyzeJob).jobId === 'string') return parsed as QueueJob;
    return null;
  } catch {
    return null;
  }
}

export async function enqueueJob(redis: RedisLikeClient, job: RunJob | AnalyzeJob): Promise<void> {
  const payload: QueueJob = { ...job, enqueuedAt: new Date().toISOString() };
  await redis.lpush(QA_QUEUE_KEY, JSON.stringify(payload));
}

/** @deprecated enqueueJob 사용 */
export async function enqueueRun(redis: RedisLikeClient, payload: { runId: string; onlyCaseIds?: string[] }): Promise<void> {
  await enqueueJob(redis, { type: 'RUN', ...payload });
}

export type Dequeued = { job: QueueJob | null; raw: string };

/** 대기열에서 작업을 꺼내 워커 전용 processing 목록으로 원자적으로 옮깁니다. */
export async function dequeueJob(redis: RedisLikeClient, workerId: string, timeoutSeconds = 5): Promise<Dequeued | null> {
  const raw = await redis.brpoplpush(QA_QUEUE_KEY, processingKeyFor(workerId), timeoutSeconds);
  if (!raw) return null;
  return { job: parseJob(raw), raw };
}

/** 처리 완료(성공/실패 무관) 시 processing 목록에서 제거합니다. 원문(raw)으로 제거해야 정확히 일치합니다. */
export async function ackJob(redis: RedisLikeClient, workerId: string, raw: string): Promise<void> {
  await redis.lrem(processingKeyFor(workerId), 1, raw);
}

export async function sendHeartbeat(redis: RedisLikeClient, workerId: string): Promise<void> {
  await redis.set(heartbeatKeyFor(workerId), new Date().toISOString(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS);
}

async function scanKeys(redis: RedisLikeClient, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== '0');
  return keys;
}

/** 하트비트가 살아 있는 워커 수 */
export async function countLiveWorkers(redis: RedisLikeClient): Promise<number> {
  return (await scanKeys(redis, `${WORKER_HEARTBEAT_PREFIX}*`)).length;
}

export type ReclaimResult = { requeued: QueueJob[]; dropped: QueueJob[] };

/**
 * 하트비트가 끊긴 워커의 processing 목록에 남은 작업을 대기열로 되돌립니다.
 * MAX_JOB_ATTEMPTS 를 넘긴 작업은 되돌리지 않고 dropped 로 반환합니다(호출 측에서 FAILED 처리).
 */
export async function reclaimOrphanedJobs(redis: RedisLikeClient, selfWorkerId?: string): Promise<ReclaimResult> {
  const result: ReclaimResult = { requeued: [], dropped: [] };
  const processingKeys = (await scanKeys(redis, `${QA_PROCESSING_PREFIX}*`)).filter((key) => !key.endsWith(':reclaim'));
  const candidates = [QA_LEGACY_PROCESSING_KEY, ...processingKeys];

  for (const key of candidates) {
    if (key !== QA_LEGACY_PROCESSING_KEY) {
      const workerId = key.slice(QA_PROCESSING_PREFIX.length);
      if (workerId === selfWorkerId) continue;
      if (await redis.exists(heartbeatKeyFor(workerId))) continue; // 살아 있는 워커
    }
    // 한 건씩 임시 목록(scratch)으로 옮긴 뒤 판단합니다.
    // 대기열에 먼저 넣고 나서 scratch 에서 지우므로, 중간에 죽어도 작업이 사라지지 않습니다(최악의 경우 중복 → 실행 측 resume 으로 흡수).
    const scratch = `${key}:reclaim`;
    while (await redis.rpoplpush(scratch, key)) { /* 이전 reclaim 중단으로 남은 항목 복구 */ }
    for (;;) {
      const raw = await redis.rpoplpush(key, scratch);
      if (!raw) break;
      const job = parseJob(raw);
      if (job) {
        const attempt = (job.attempt ?? 0) + 1;
        if (attempt >= MAX_JOB_ATTEMPTS) {
          result.dropped.push({ ...job, attempt });
        } else {
          const retried: QueueJob = { ...job, attempt };
          await redis.lpush(QA_QUEUE_KEY, JSON.stringify(retried));
          result.requeued.push(retried);
        }
      }
      await redis.lrem(scratch, 1, raw); // 손상된 payload 도 여기서 폐기
    }
  }
  return result;
}
