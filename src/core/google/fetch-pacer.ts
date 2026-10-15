/** Per-sweep Gmail fetch spacing. Zero disables it; malformed overrides keep the default. */
export function resolveGmailFetchGapMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GBRAIN_GMAIL_FETCH_GAP_MS;
  if (raw === undefined || raw.trim() === '') return 1_250;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1_250;
}

/** Sequential fetch-start pacing. The caller checks cancellation before making a request. */
export function createFetchPacer(gapMs: number, now: () => number = Date.now): (signal?: AbortSignal) => Promise<void> {
  let lastStartMs = Number.NEGATIVE_INFINITY;
  return async (signal) => {
    const waitMs = lastStartMs + gapMs - now();
    if (waitMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    }
    lastStartMs = now();
  };
}
