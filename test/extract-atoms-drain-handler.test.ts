/**
 * #1685 GAP D — extract-atoms-drain Minion handler: registration + protected
 * gate. Canonical PGLite block (CLAUDE.md R3+R4).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { makeExtractAtomsDrainHandler } from '../src/core/minions/handlers/extract-atoms-drain.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import {
  formatDrainProviderFailure,
  runExtractAtomsDrainForSource,
  type ExtractAtomsDrainResult,
} from '../src/core/cycle/extract-atoms-drain.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
});

describe('extract-atoms-drain handler', () => {
  test('registerBuiltinHandlers registers the handler', async () => {
    const worker = new MinionWorker(engine);
    await registerBuiltinHandlers(worker, engine);
    expect(worker.registeredNames).toContain('extract-atoms-drain');
  });

  test('queue.add rejects an untrusted submission (PROTECTED, CODEX #1)', async () => {
    await expect(queue.add('extract-atoms-drain', { sourceId: 'default' })).rejects.toThrow(
      /protected job name/i,
    );
  });

  test('queue.add accepts a trusted submission (allowProtectedSubmit)', async () => {
    const job = await queue.add(
      'extract-atoms-drain',
      { sourceId: 'default', window: 120 },
      { queue: 'default' },
      { allowProtectedSubmit: true },
    );
    expect(job.id).toBeGreaterThan(0);
    expect(job.name).toBe('extract-atoms-drain');
  });

  // #3813: the provider_failure throw is the job's error_text once it
  // dead-letters. It carried only batches/remaining, so a missing provider key
  // was invisible from every supported surface even though the drain result
  // has carried a sanitized representative `last_error`.
  test('provider_failure error text carries the drain\'s last_error', () => {
    const result = {
      status: 'provider_failure',
      batches: 1,
      remaining: 151,
      last_error: 'concepts/alice-example: Anthropic chat requires ANTHROPIC_API_KEY.',
    } as ExtractAtomsDrainResult;
    const msg = formatDrainProviderFailure(result);
    expect(msg).toContain('batches=1');
    expect(msg).toContain('remaining=151');
    expect(msg).toContain('ANTHROPIC_API_KEY');
    // A clean-run shape (no representative error) keeps the original message.
    expect(formatDrainProviderFailure({ ...result, last_error: null })).not.toContain('last error');
  });

  // The handler's own contract text: a deadline failure is final, so the
  // dead-lettered job's error must not promise a retry.
  test('the final provider_failure text drops "retrying"', () => {
    const result = { status: 'provider_failure', batches: 2, remaining: 5, last_error: null } as ExtractAtomsDrainResult;
    expect(formatDrainProviderFailure(result)).toContain('retrying');
    expect(formatDrainProviderFailure(result, { final: true })).not.toContain('retrying');
  });

  // #5809: at timeout_ms the worker aborts job.signal and dead-letters the
  // row, but an inline handler keeps running (and keeps refreshing the source's
  // cycle lock) unless the drain observes that signal.
  const drainJob = (signal: AbortSignal, deadlineAtMs: number | null = null) => ({
    id: 1, name: 'extract-atoms-drain', attempts_made: 0,
    data: { sourceId: 'default', window: 120 },
    signal, deadlineAtMs, shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
  }) as unknown as MinionJobContext;
  const seedEligiblePage = (slug: string) => engine.putPage(slug, {
    type: 'note', title: slug, compiled_truth: 'A durable decision recorded in prose. '.repeat(20),
  } as never, { sourceId: 'default' });
  const lockRows = () => engine.executeRaw(`SELECT id FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle:default'`);

  test('a job aborted before its deadline throws the abort reason and leaves the cycle lock free', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    const err = await makeExtractAtomsDrainHandler(engine)(drainJob(controller.signal)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('shutdown');
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(await lockRows()).toEqual([]);
  });

  test('the job deadline reaches the in-flight model call, strikes nothing and is final', async () => {
    await seedEligiblePage('notes/deadline-probe');
    const callSignals: Array<AbortSignal | undefined> = [];
    __setChatTransportForTests(async (o) => {
      callSignals.push(o.abortSignal);
      await new Promise<void>((resolve) => o.abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('claude-cli adapter aborted');
    });
    let err: unknown;
    try {
      err = await makeExtractAtomsDrainHandler(engine)(drainJob(new AbortController().signal, Date.now() + 300))
        .then(() => null, (e: unknown) => e);
    } finally {
      __setChatTransportForTests(null);
    }
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain('stopped at the job deadline');
    expect((err as Error).message).not.toContain('retrying');
    expect(callSignals).toHaveLength(1);
    expect(callSignals[0]?.aborted).toBe(true);
    expect(await engine.executeRaw('SELECT page_id FROM extract_atoms_page_state')).toEqual([]);
    expect(await lockRows()).toEqual([]);
  });

  // #5832: withRefreshingLock aborts the signal it hands its work when the
  // cycle lock's lease is lost; that signal must reach the model call even for
  // a caller that passes no signal of its own (gbrain dream --drain).
  test('the cycle lock signal reaches the model call when the caller passes none', async () => {
    await seedEligiblePage('notes/lock-probe');
    const callSignals: Array<AbortSignal | undefined> = [];
    __setChatTransportForTests(async (o) => {
      callSignals.push(o.abortSignal);
      throw new Error('provider unavailable');
    });
    try {
      await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120 });
    } finally {
      __setChatTransportForTests(null);
    }
    expect(callSignals.length).toBeGreaterThan(0);
    for (const signal of callSignals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  // /ship Step 7 coverage extension (G8).
  // Value: protects=queued drain reservations reach execution and terminal failures retain the full durable progress receipt;
  // fails_when=handler drops budgetUsd or final updateProgress, or a terminal job promises an automatic retry;
  // why_new=direct handler fixtures replace updateProgress with a no-op and never run reservation data through the worker;
  // seam=none; no_claim=Postgres or child-process execution (real PGLite queue and inline worker, synthetic provider).
  test('worker enforces a queued reservation and preserves diagnostics when the next drain dead-letters', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-drain-worker' }, async () => {
      const sourceId = 'handler-reservation';
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/reserved', { type: 'note', title: 'Reserved',
        compiled_truth: 'A durable decision recorded in prose. '.repeat(20) } as never, { sourceId });
      await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
      await engine.setConfig('cycle.extract_atoms.budget_usd', '0.3');
      let calls = 0;
      __setChatTransportForTests(async () => { calls++; throw new Error('synthetic provider unavailable'); });
      const worker = new MinionWorker(engine, { queue: 'coverage-drain', pollInterval: 30, concurrency: 1 });
      worker.register('extract-atoms-drain', makeExtractAtomsDrainHandler(engine));
      const submit = (budgetUsd: number) => queue.add('extract-atoms-drain', { sourceId, window: 120, budgetUsd },
        { queue: 'coverage-drain', max_attempts: 1, timeout_ms: 30_000 }, { allowProtectedSubmit: true });
      const reserved = await submit(0.001);
      const running = worker.start();
      try {
        const settled = async (id: number) => {
          await waitFor(async () => ['completed', 'dead', 'failed', 'cancelled'].includes((await queue.getJob(id))!.status),
            { timeoutMs: 15_000, intervalMs: 30, label: 'drain worker settles' });
          return (await queue.getJob(id))!;
        };
        const first = await settled(reserved.id);
        expect(first.status).toBe('completed');
        expect(calls).toBe(0);
        expect(first.result).toMatchObject({ source_id: sourceId, stopped: 'budget', budget_usd: 0.001,
          pages_processed: 0, initial_remaining: 1, remaining: 1 });
        expect(first.progress).toEqual(first.result);
        expect(await engine.getConfig('cycle.extract_atoms.budget_usd')).toBe('0.3');
        const failed = await settled((await submit(0.3)).id);
        expect(failed.status).toBe('dead');
        expect(calls).toBe(1);
        expect(failed.error_text).toContain('synthetic provider unavailable');
        expect(failed.error_text).not.toContain('retrying');
        expect(failed.progress).toMatchObject({ phase: 'extract_atoms', source_id: sourceId,
          status: 'provider_failure', stopped: 'provider_failure', failure_count: 1,
          initial_remaining: 1, remaining: 1, remaining_is_fresh: true,
          pages_processed: 0, budget_usd: 0.3 });
        expect((failed.progress as ExtractAtomsDrainResult).failures).toEqual([
          expect.objectContaining({ batch: 1, source: 'notes/reserved', reason: expect.stringContaining('synthetic provider unavailable') }),
        ]);
        expect((failed.progress as ExtractAtomsDrainResult).spent_usd).toBeGreaterThan(0);
      } finally {
        worker.stop();
        await running;
        __setChatTransportForTests(null);
        await engine.unsetConfig('models.dream.extract_atoms');
        await engine.unsetConfig('cycle.extract_atoms.budget_usd');
      }
    });
  }, 40_000);
});
