/**
 * items 를 최대 limit 개씩 동시에 처리합니다.
 * shouldStop 이 true 를 반환하면 새 항목을 더 이상 시작하지 않습니다(진행 중인 항목은 끝까지 수행).
 * worker 가 던진 첫 번째 오류는 모든 진행 중 작업이 끝난 뒤 다시 던집니다.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop?: () => boolean | Promise<boolean>
): Promise<{ started: number; stopped: boolean }> {
  let next = 0;
  let stopped = false;
  let firstError: unknown;
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));

  const lane = async () => {
    while (!stopped && firstError === undefined) {
      if (shouldStop && (await shouldStop())) { stopped = true; break; }
      const index = next++;
      if (index >= items.length) break;
      try {
        await worker(items[index]!, index);
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, lane));
  if (firstError !== undefined) throw firstError;
  return { started: Math.min(next, items.length), stopped };
}
