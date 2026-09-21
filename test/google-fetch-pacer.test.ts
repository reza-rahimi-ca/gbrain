/**
 * google-fetch-pacer — unit tests for the Gmail threads.get pacing helpers in
 * google-source.ts (createFetchPacer / resolveGmailFetchGapMs).
 *
 * Why these exist: Gmail's per-user quota is a leaky bucket. A burst of ~50
 * `threads.get` in a few seconds is refused even though the same 50 spread
 * over the minute pass, and every retry ladder after that drains the refill.
 * The pacer spaces fetch STARTS by a fixed gap so a sync never bursts.
 *
 * No network, no engine — pure timing on an injectable clock plus one real
 * (short) wall-clock check.
 */
import { describe, expect, test } from 'bun:test';

import { createFetchPacer, resolveGmailFetchGapMs } from '../src/core/google/google-source.ts';

describe('resolveGmailFetchGapMs', () => {
  test('defaults to 1250ms when the env var is absent or blank', () => {
    expect(resolveGmailFetchGapMs({})).toBe(1250);
    expect(resolveGmailFetchGapMs({ GBRAIN_GMAIL_FETCH_GAP_MS: '' })).toBe(1250);
    expect(resolveGmailFetchGapMs({ GBRAIN_GMAIL_FETCH_GAP_MS: '   ' })).toBe(1250);
  });

  test('honors a numeric override, including 0 (disabled)', () => {
    expect(resolveGmailFetchGapMs({ GBRAIN_GMAIL_FETCH_GAP_MS: '0' })).toBe(0);
    expect(resolveGmailFetchGapMs({ GBRAIN_GMAIL_FETCH_GAP_MS: '400' })).toBe(400);
    expect(resolveGmailFetchGapMs({ GBRAIN_GMAIL_FETCH_GAP_MS: '999.9' })).toBe(999);
  });

  test('falls back to the default on garbage or negative values', () => {
    expect(resolveGmailFetchGapMs({ GBRAIN_GMAIL_FETCH_GAP_MS: 'fast' })).toBe(1250);
    expect(resolveGmailFetchGapMs({ GBRAIN_GMAIL_FETCH_GAP_MS: '-5' })).toBe(1250);
    expect(resolveGmailFetchGapMs({ GBRAIN_GMAIL_FETCH_GAP_MS: 'Infinity' })).toBe(1250);
  });
});

describe('createFetchPacer', () => {
  test('first call never waits; a gap of 0 never waits', async () => {
    let t = 1_000;
    const pace = createFetchPacer(0, () => t);
    const start = performance.now();
    await pace();
    await pace();
    await pace();
    expect(performance.now() - start).toBeLessThan(50);
  });

  test('spaces call STARTS by at least the gap on the wall clock', async () => {
    const pace = createFetchPacer(40);
    const start = performance.now();
    await pace(); // immediate
    await pace(); // ~40ms
    await pace(); // ~80ms
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(1_000);
  });

  test('does not wait when enough time has already passed (injected clock)', async () => {
    let t = 0;
    const pace = createFetchPacer(1_250, () => t);
    await pace(); // lastStart = 0
    t = 5_000; // far past the gap — the fetch itself took a while
    const start = performance.now();
    await pace();
    expect(performance.now() - start).toBeLessThan(50);
  });

  test('an already-aborted signal skips the sleep', async () => {
    const pace = createFetchPacer(5_000);
    await pace();
    const ac = new AbortController();
    ac.abort();
    const start = performance.now();
    await pace(ac.signal);
    expect(performance.now() - start).toBeLessThan(50);
  });

  test('aborting mid-sleep releases the pacer promptly', async () => {
    const pace = createFetchPacer(5_000);
    await pace();
    const ac = new AbortController();
    const start = performance.now();
    const pending = pace(ac.signal);
    setTimeout(() => ac.abort(), 20);
    await pending;
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
