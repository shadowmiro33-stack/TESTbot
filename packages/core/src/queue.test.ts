import { describe, expect, it } from 'vitest';
import {
  QA_QUEUE_KEY, MAX_JOB_ATTEMPTS, ackJob, countLiveWorkers, dequeueJob, enqueueJob, parseJob, processingKeyFor,
  reclaimOrphanedJobs, runWithConcurrency, sendHeartbeat, type RedisLikeClient
} from '@autohands/shared';

/** 테스트용 최소 인메모리 Redis (list + TTL 없는 키) */
class FakeRedis implements RedisLikeClient {
  lists = new Map<string, string[]>();
  keys = new Map<string, string>();
  private list(key: string) { if (!this.lists.has(key)) this.lists.set(key, []); return this.lists.get(key)!; }
  async lpush(key: string, ...values: (string | number)[]) { const l = this.list(key); for (const v of values) l.unshift(String(v)); return l.length; }
  async rpoplpush(src: string, dst: string) { const v = this.list(src).pop(); if (v === undefined) return null; this.list(dst).unshift(v); return v; }
  async brpoplpush(src: string, dst: string) { return this.rpoplpush(src, dst); }
  async lrem(key: string, _count: number, value: string | number) { const l = this.list(key); const i = l.indexOf(String(value)); if (i < 0) return 0; l.splice(i, 1); return 1; }
  async set(key: string, value: string) { this.keys.set(key, value); return 'OK'; }
  async exists(...keys: string[]) { return keys.filter((k) => this.keys.has(k)).length; }
  async scan(_c: string | number, _m: 'MATCH', pattern: string) {
    const prefix = pattern.replace(/\*$/, '');
    const all = [...this.keys.keys(), ...[...this.lists.entries()].filter(([, v]) => v.length).map(([k]) => k)];
    return ['0', [...new Set(all.filter((k) => k.startsWith(prefix)))]] as [string, string[]];
  }
  len(key: string) { return this.list(key).length; }
}

describe('reliable queue', () => {
  it('moves a job to the worker processing list and acks it by raw payload', async () => {
    const redis = new FakeRedis();
    await enqueueJob(redis, { type: 'RUN', runId: 'r1' });
    const got = await dequeueJob(redis, 'w1');
    expect(got?.job).toMatchObject({ type: 'RUN', runId: 'r1' });
    expect(redis.len(processingKeyFor('w1'))).toBe(1);
    await ackJob(redis, 'w1', got!.raw);
    expect(redis.len(processingKeyFor('w1'))).toBe(0);
  });

  it('parses legacy payloads without type as RUN', () => {
    expect(parseJob('{"runId":"old","enqueuedAt":"x"}')).toMatchObject({ type: 'RUN', runId: 'old' });
    expect(parseJob('not json')).toBeNull();
    expect(parseJob('{"type":"ANALYZE"}')).toBeNull();
  });

  it('requeues jobs left by a dead worker but not by a live one', async () => {
    const redis = new FakeRedis();
    await enqueueJob(redis, { type: 'RUN', runId: 'dead-job' });
    await enqueueJob(redis, { type: 'ANALYZE', jobId: 'live-job' });
    await dequeueJob(redis, 'dead');           // dead-job → dead 워커 (하트비트 없음)
    await dequeueJob(redis, 'live');           // live-job → live 워커
    await sendHeartbeat(redis, 'live');
    expect(await countLiveWorkers(redis)).toBe(1);

    const { requeued, dropped } = await reclaimOrphanedJobs(redis, 'me');
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toMatchObject({ runId: 'dead-job', attempt: 1 });
    expect(dropped).toHaveLength(0);
    expect(redis.len(QA_QUEUE_KEY)).toBe(1);
    expect(redis.len(processingKeyFor('live'))).toBe(1);
    expect(redis.len(processingKeyFor('dead'))).toBe(0);
  });

  it('drops a job after MAX_JOB_ATTEMPTS reclaims (poison job)', async () => {
    const redis = new FakeRedis();
    await enqueueJob(redis, { type: 'RUN', runId: 'poison' });
    let dropped: unknown[] = [];
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) {
      await dequeueJob(redis, `crash-${i}`);
      dropped = (await reclaimOrphanedJobs(redis)).dropped;
    }
    expect(dropped).toHaveLength(1);
    expect(redis.len(QA_QUEUE_KEY)).toBe(0);
  });
});

describe('runWithConcurrency', () => {
  it('never exceeds the concurrency limit and processes every item', async () => {
    let active = 0; let peak = 0; const done: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n); active--;
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('stops starting new items when shouldStop returns true', async () => {
    const done: number[] = [];
    const res = await runWithConcurrency([1, 2, 3, 4, 5], 1, async (n) => { done.push(n); }, () => done.length >= 2);
    expect(res.stopped).toBe(true);
    expect(done).toEqual([1, 2]);
  });

  it('rethrows the first worker error after in-flight work settles', async () => {
    let finished = 0;
    let caught: unknown;
    try {
      await runWithConcurrency([1, 2], 2, async (n) => {
        if (n === 1) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 5)); finished++;
      });
    } catch (e) { caught = e; }
    expect((caught as Error).message).toBe('boom');
    expect(finished).toBe(1);
  });
});
