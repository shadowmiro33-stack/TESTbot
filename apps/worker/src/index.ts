import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  WORKER_HEARTBEAT_TTL_SECONDS, ackJob, dequeueJob, heartbeatKeyFor, reclaimOrphanedJobs, sendHeartbeat, type RedisLikeClient
} from '@autohands/shared';
import { describeJob, failJob, processJob } from '../../api/src/jobs.js';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const HEARTBEAT_INTERVAL_MS = Math.floor((WORKER_HEARTBEAT_TTL_SECONDS * 1000) / 3);
const RECLAIM_INTERVAL_MS = WORKER_HEARTBEAT_TTL_SECONDS * 1000;
const log = (...args: unknown[]) => console.log(`[AUTOHANDS Worker ${workerId}]`, ...args);

const ioredis = (await import('ioredis')) as any;
const Redis = ioredis.default ?? ioredis.Redis;
// lazyConnect 없이 생성 → Redis 가 늦게 떠도 ioredis 가 자동으로 재연결합니다.
const redis: RedisLikeClient & { quit(): Promise<unknown>; del(key: string): Promise<number>; on(e: string, f: (...a: any[]) => void): void } =
  new Redis(url, { maxRetriesPerRequest: null });
redis.on('error', (err: Error) => console.warn(`[AUTOHANDS Worker] Redis 오류: ${err.message}`));

let accepting = true;
let busy = false;

async function heartbeat() {
  await sendHeartbeat(redis, workerId).catch(() => undefined);
}

/** 죽은 워커가 남긴 작업을 회수합니다. 재시도 한도를 넘긴 작업은 실패로 기록합니다. */
async function reclaim() {
  try {
    const { requeued, dropped } = await reclaimOrphanedJobs(redis, workerId);
    for (const job of requeued) log(`중단된 작업 재등록: ${describeJob(job)} (시도 ${job.attempt})`);
    for (const job of dropped) {
      log(`재시도 한도 초과로 작업 중단: ${describeJob(job)}`);
      await failJob(job, `작업을 처리하던 워커가 ${job.attempt}회 연속 비정상 종료되어 재시도를 중단했습니다. 대상 페이지 또는 워커 로그를 확인하세요.`);
    }
  } catch (err) {
    console.warn('[AUTOHANDS Worker] 작업 회수 중 오류:', (err as Error).message);
  }
}

async function loop() {
  await heartbeat();
  await reclaim();
  log(`작업 대기 시작 (Redis ${url})`);
  while (accepting) {
    try {
      const dequeued = await dequeueJob(redis, workerId, 5);
      if (!dequeued) continue;
      if (!dequeued.job) {
        log('알 수 없는 형식의 작업을 폐기합니다:', dequeued.raw.slice(0, 200));
        await ackJob(redis, workerId, dequeued.raw);
        continue;
      }
      busy = true;
      const started = Date.now();
      log(`작업 시작: ${describeJob(dequeued.job)}`);
      try {
        await processJob(dequeued.job);
        log(`작업 종료: ${describeJob(dequeued.job)} (${Date.now() - started}ms)`);
      } catch (err) {
        console.error(`[AUTOHANDS Worker] 작업 실패: ${describeJob(dequeued.job)}`, err);
      } finally {
        await ackJob(redis, workerId, dequeued.raw).catch(() => undefined);
        busy = false;
      }
    } catch (err) {
      console.error('[AUTOHANDS Worker] 소비자 루프 오류, 2초 후 재시도:', (err as Error).message);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}

const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
const reclaimTimer = setInterval(() => void reclaim(), RECLAIM_INTERVAL_MS);

async function shutdown(signal: string) {
  if (!accepting) return;
  accepting = false;
  log(`${signal} 수신: ${busy ? '진행 중인 작업을 마친 뒤' : '즉시'} 종료합니다.`);
  // 진행 중인 작업이 끝날 때까지 하트비트는 유지 (끝나지 못하고 강제 종료되면 다른 워커가 회수)
  while (busy) await new Promise((res) => setTimeout(res, 500));
  clearInterval(heartbeatTimer);
  clearInterval(reclaimTimer);
  await redis.del(heartbeatKeyFor(workerId)).catch(() => undefined);
  await redis.quit().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void loop();
