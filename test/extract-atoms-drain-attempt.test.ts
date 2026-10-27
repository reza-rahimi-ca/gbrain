/**
 * #5856: one extract-atoms-drain attempt is one budget. Its batches share one
 * BudgetTracker, so the per-run dollar cap holds for the whole attempt
 * instead of once per batch.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { __setChatTransportForTests(null); await engine.disconnect(); resetGateway(); });

test('a three-batch drain attempt stops at its per-run cap (one BudgetTracker per attempt)', async () => {
  for (const n of [1, 2, 3]) {
    await engine.putPage(`notes/decision-${n}`, { type: 'note', title: `Decision ${n}`,
      compiled_truth: `Decision ${n}: a durable choice recorded in prose. `.repeat(20) } as never, { sourceId: 'default' });
  }
  await engine.setConfig('cycle.extract_atoms.page_discovery_budget', '1');
  await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
  // Haiku: $1/M input, $5/M output. Each call reserves ~$0.021 (4,096 output
  // tokens) and records $0.015 (15,000 input tokens): one call fits the
  // $0.03 cap, a second reservation on the same tracker does not.
  await engine.setConfig('cycle.extract_atoms.budget_usd', '0.03');
  let calls = 0;
  __setChatTransportForTests(async (opts) => {
    calls++;
    const text = JSON.stringify([{ title: `Measured progress ${calls}`, atom_type: 'insight', body: `Measure progress against clear exit criteria ${calls}.` }]);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 15_000, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model!, providerId: 'anthropic' };
  });
  try {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-atom-budget' }, async () => {
      const result = await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, maxBatches: 3 });
      expect(calls).toBe(1);
      expect(result.extracted).toBe(1);
      expect(result.remaining).toBe(2);
      // #6425: the per-run cap stopped the attempt, not an empty or failing backlog.
      expect(result.stopped).toBe('budget');
      expect(result.status).toBe('ok');
      expect(result.budget_usd).toBe(0.03);
      expect(result.spent_usd).toBeGreaterThan(0);
      expect(result.batches).toBe(2);
      expect(result.source_id).toBe('default');
      expect(result.initial_remaining).toBe(3);
      expect(result.pages_processed).toBe(1);
    });
  } finally { __setChatTransportForTests(null); }
  expect(await engine.executeRaw("SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL")).toHaveLength(1);
});

test('a scheduler reservation lowers the configured attempt cap without changing config', async () => {
  await engine.putPage('notes/reserved', { type: 'note', title: 'Reserved',
    compiled_truth: 'A durable decision recorded in prose. '.repeat(20) } as never, { sourceId: 'default' });
  await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
  await engine.setConfig('cycle.extract_atoms.budget_usd', '0.3');
  let calls = 0;
  __setChatTransportForTests(async () => { calls++; throw new Error('must be blocked before transport'); });
  try {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-atom-budget' }, async () => {
      const result = await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, budgetUsd: 0.001 });
      expect(result.stopped).toBe('budget');
      expect(result.budget_usd).toBe(0.001);
      expect(result.pages_processed).toBe(0);
      expect(calls).toBe(0);
      expect(await engine.getConfig('cycle.extract_atoms.budget_usd')).toBe('0.3');
    });
  } finally { __setChatTransportForTests(null); }
});

// /ship Step 7 coverage extension (G5).
// Value: protects=automatic reservations reject invalid or unpriceable budgets and never raise the configured attempt cap;
// fails_when=reservation validation is removed, the cap is raised, or an unpriced reserved route falls back to uncapped work;
// why_new=existing reservation test covers only a smaller positive cap on a priced route;
// seam=none; no_claim=live pricing or provider billing (real admission with synthetic transport).
test('invalid, oversized and unpriced scheduler reservations never admit uncapped work', async () => {
  await engine.putPage('notes/reservation-boundary', { type: 'note', title: 'Reservation boundary',
    compiled_truth: 'A durable decision recorded in prose. '.repeat(20) } as never, { sourceId: 'default' });
  await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
  await engine.setConfig('cycle.extract_atoms.budget_usd', '0.001');
  let calls = 0;
  __setChatTransportForTests(async () => { calls++; throw new Error('reservation must refuse before transport'); });
  try {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-atom-budget' }, async () => {
      for (const budgetUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, budgetUsd }))
          .rejects.toThrow('Atom drain budget must be finite and positive.');
        expect(calls).toBe(0);
        expect(await engine.getConfig('cycle.extract_atoms.budget_usd')).toBe('0.001');
      }
      const capped = await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, budgetUsd: 1 });
      expect(capped).toMatchObject({ stopped: 'budget', budget_usd: 0.001, pages_processed: 0 });
      expect(calls).toBe(0);
      expect(await engine.getConfig('cycle.extract_atoms.budget_usd')).toBe('0.001');
      await engine.unsetConfig('cycle.extract_atoms.budget_usd');
      await engine.setConfig('models.dream.extract_atoms', 'openrouter:synthetic/unpriced-reserved-model');
      const refused = await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, budgetUsd: 0.01 });
      expect(refused).toMatchObject({ status: 'partial', pages_processed: 0, failure_count: 0, remaining: 1, budget_usd: 0.01 });
      expect(refused.last_error).toContain('no_pricing');
      expect(await engine.getConfig('cycle.extract_atoms.budget_usd')).toBeNull();
      expect(calls).toBe(0);
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE type='atom'")).toEqual([]);
    });
  } finally { __setChatTransportForTests(null); }
});

test('each drain attempt starts a fresh budget: the next attempt extracts the next page', async () => {
  for (const n of [1, 2]) {
    await engine.putPage(`notes/attempt-${n}`, { type: 'note', title: `Attempt ${n}`,
      compiled_truth: `Attempt ${n}: a durable choice recorded in prose. `.repeat(20) } as never, { sourceId: 'default' });
  }
  await engine.setConfig('cycle.extract_atoms.page_discovery_budget', '1');
  await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
  await engine.setConfig('cycle.extract_atoms.budget_usd', '0.03');
  let calls = 0;
  __setChatTransportForTests(async (opts) => {
    calls++;
    const text = JSON.stringify([{ title: `Next step ${calls}`, atom_type: 'insight', body: `Ship the smallest next step ${calls}.` }]);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 15_000, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model!, providerId: 'anthropic' };
  });
  try {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-atom-budget' }, async () => {
      expect((await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, maxBatches: 3 })).extracted).toBe(1);
      expect((await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 120, maxBatches: 3 })).extracted).toBe(1);
    });
  } finally { __setChatTransportForTests(null); }
  expect(calls).toBe(2);
});
