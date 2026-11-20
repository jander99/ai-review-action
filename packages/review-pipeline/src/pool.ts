/**
 * A small bounded worker pool.
 *
 * Judgements are independent API calls, so running them concurrently is
 * the whole point — but the provider's rate limit is shared, so the
 * concurrency is capped and results keep input order for stable output.
 */

export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function runPool<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  const results: Settled<R>[] = new Array(items.length);
  let next = 0;

  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
