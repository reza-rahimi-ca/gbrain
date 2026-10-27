/**
 * #5856: the autopilot atom auto-drain submission pass, driven through the
 * real queue on PGLite (the tick itself is Postgres-gated; see the e2e
 * wrapper). Fairness between checkout-backed and connector sources, the
 * attempt-counted daily cap, the structural-refusal exclusion, the writer
 * pre-check and the opt-in for connector email/meeting pages.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { submitAutoDrains, AUTO_DRAIN_NEXT_KIND_KEY } from '../src/commands/autopilot-dispatch.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: BrainEngine;
let queue: MinionQueue;
let home: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (testBackends().join() === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine;
    closePostgres = pg.close;
  } else {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }
  queue = new MinionQueue(engine);
}, 120_000);
afterAll(async () => { if (closePostgres) await closePostgres(); else await engine.disconnect(); });
async function reset(): Promise<void> {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw("DELETE FROM pages");
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'autopilot.auto_drain.%' OR key LIKE 'cycle.extract_atoms.%'");
}
beforeEach(async () => {
  await reset();
  home = mkdtempSync(join(tmpdir(), 'gbrain-auto-drain-'));
  await engine.setConfig('autopilot.auto_drain.threshold', '1');
});

const DAY1 = Date.parse('2026-09-20T12:00:00Z');
const DAY2 = Date.parse('2026-09-21T12:00:00Z');
const prose = (n: string) => `A durable decision about ${n}, recorded in prose with context. `.repeat(12);

async function gitSource(id: string, pages = 2): Promise<void> {
  const root = join(home, id);
  mkdirSync(root, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  for (let i = 0; i < pages; i++) {
    await engine.putPage(`notes/${id}-${i}`, { type: 'note', title: `${id} ${i}`, compiled_truth: prose(`${id} ${i}`) } as never, { sourceId: id });
  }
}

async function connectorSource(id: string, type: 'email' | 'meeting' = 'email', pages = 2): Promise<void> {
  const state = join(home, `${id}-state`);
  mkdirSync(state, { recursive: true });
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,jsonb_build_object('kind','google'))", [id, state]);
  for (let i = 0; i < pages; i++) {
    await engine.putPage(`${type === 'email' ? 'emails' : 'calendar'}/${id}-${i}`, { type, title: `${id} ${i}`, compiled_truth: prose(`${id} ${i}`) } as never, { sourceId: id });
  }
}

async function tick(now = DAY1): Promise<string> {
  let stderr = '';
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await withEnv({ GBRAIN_HOME: home }, () => submitAutoDrains(engine, queue, { timeoutMs: 60_000, jsonMode: true, now: () => now }));
  } finally { process.stderr.write = write; }
  await engine.executeRaw("UPDATE minion_jobs SET created_at=$1::timestamptz WHERE idempotency_key LIKE '%:' || $2 || '%'",
    [new Date(now).toISOString(), new Date(now).toISOString().slice(0, 10)]);
  return stderr;
}

async function submitted(): Promise<Array<{ source: string; repo: string | null }>> {
  return engine.executeRaw<{ source: string; repo: string | null }>(
    "SELECT data->>'sourceId' AS source, data->>'repoPath' AS repo FROM minion_jobs WHERE name='extract-atoms-drain' ORDER BY id");
}

async function priorJob(sourceId: string, day: number, row: { status: string; attempts: number; error?: string }): Promise<void> {
  const job = await queue.add('extract-atoms-drain', { sourceId, window: 120 },
    { queue: 'default', idempotency_key: `autopilot-extract-atoms-drain:${sourceId}:${new Date(day).toISOString().slice(0, 10)}`, max_attempts: 3 },
    { allowProtectedSubmit: true });
  await engine.executeRaw(`UPDATE minion_jobs SET status=$2, attempts_started=$3, attempts_made=$3, error_text=$4, created_at=$5::timestamptz WHERE id=$1`,
    [job.id, row.status, row.attempts, row.error ?? null, new Date(day).toISOString()]);
}

test('six backlogged git sources and one connector source under the default cap: the connector gets a slot', async () => {
  for (const n of [1, 2, 3, 4, 5, 6]) await gitSource(`git-${n}`);
  await connectorSource('gmail');
  await tick();
  const jobs = await submitted();
  expect(jobs).toHaveLength(6);
  expect(jobs.map(j => j.source)).toEqual(['git-1', 'gmail', 'git-2', 'git-3', 'git-4', 'git-5']);
  expect(jobs.find(j => j.source === 'gmail')!.repo).toBeNull();
  expect(jobs.find(j => j.source === 'git-1')!.repo).toBe(join(home, 'git-1'));
});

test('one slot left with a git and a connector source: the git source is submitted, the connector goes first next day', async () => {
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
  await gitSource('git-a');
  await connectorSource('gmail');
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a']);
  expect(await engine.getConfig(AUTO_DRAIN_NEXT_KIND_KEY)).toBe('connector');
  await engine.executeRaw("UPDATE minion_jobs SET status='completed', attempts_started=1");
  await tick(DAY2);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a', 'gmail']);
  expect(await engine.getConfig(AUTO_DRAIN_NEXT_KIND_KEY)).toBe('checkout');
});

test('a structural refusal frees its slot and is not resubmitted the same day; a provider-failure dead letter keeps its units', async () => {
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
  await gitSource('git-a');
  await gitSource('git-b');
  await priorJob('git-a', DAY1, { status: 'dead', attempts: 1, error: 'structural_refusal: owner_unavailable: Atom maintenance requires the configured canonical owner.' });
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a', 'git-b']);
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a', 'git-b']);

  await reset();
  await engine.setConfig('autopilot.auto_drain.threshold', '1');
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.3');
  await gitSource('git-c');
  await gitSource('git-d');
  await priorJob('git-c', DAY1, { status: 'dead', attempts: 1, error: 'extract-atoms-drain: all provider calls failed this batch (batches=1, remaining=2)' });
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-c']);
});

test('the cap counts attempts: a job retried three times consumes three units', async () => {
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.9');
  await gitSource('git-a');
  await gitSource('git-b');
  await priorJob('git-a', DAY1, { status: 'dead', attempts: 3, error: 'extract-atoms-drain: all provider calls failed this batch (batches=1, remaining=2)' });
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a']);
  await engine.executeRaw("UPDATE minion_jobs SET attempts_started=2, attempts_made=2 WHERE data->>'sourceId'='git-a'");
  await tick(DAY1);
  expect((await submitted()).map(j => j.source)).toEqual(['git-a', 'git-b']);
});

test('connector email and meeting pages drain by default; opted out, a connector backlog submits nothing', async () => {
  await engine.setConfig('cycle.extract_atoms.connector_pages', 'false');
  await connectorSource('gmail', 'email');
  await connectorSource('gcal', 'meeting');
  await tick(DAY1);
  expect(await submitted()).toEqual([]);
  await engine.executeRaw("DELETE FROM config WHERE key='cycle.extract_atoms.connector_pages'");
  await tick(DAY1);
  expect((await submitted()).map(j => j.source).sort()).toEqual(['gcal', 'gmail']);
});

test('managed brain: a source whose writer preflight would refuse is skipped with its reason; an unbound connector is submitted database-only', async () => {
  await gitSource('git-unowned');
  await connectorSource('gmail');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  let stderr: string;
  try { stderr = await tick(DAY1); }
  finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
  expect(await submitted()).toEqual([{ source: 'gmail', repo: null }]);
  const skip = stderr.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.event === 'auto_drain_source_skipped');
  expect(skip).toMatchObject({ source_id: 'git-unowned' });
  expect(skip.reason).toContain('requires the configured canonical owner');
});

// Scheduler-level continuation through the real queue. No existing coverage
// completed a partial window and ticked again; these fail under daily-only dedup.
const cleanWindow = {
  source_id: 'git-a', status: 'ok', stopped: 'window', initial_remaining: 5, remaining: 2,
  remaining_is_fresh: true, pages_processed: 3, failure_count: 0, held_failed: 0,
  write_pending: 0, input_truncated: 0, tombstoned_for_failures: 0, malformed_outputs: 0,
  stopped_outputs: 0, spent_usd: 0.1, budget_usd: 0.3,
};
async function finishWindow(result: Record<string, unknown> = cleanWindow): Promise<void> {
  await engine.executeRaw(`UPDATE minion_jobs SET status='completed', attempts_started=1,
    result=$1::text::jsonb WHERE id=(SELECT max(id) FROM minion_jobs WHERE data->>'sourceId'='git-a')`,
    [JSON.stringify(result)]);
}

test('clean partial windows continue once per tick, never overlap, and stop at the window bound', async () => {
  await gitSource('git-a');
  await engine.setConfig('autopilot.auto_drain.max_windows_per_source_per_day', '2');
  await tick();
  await tick();
  expect(await submitted()).toHaveLength(1);
  await finishWindow();
  // Continuation drains the tail even when it is below the initial threshold.
  await engine.setConfig('autopilot.auto_drain.threshold', '25');
  await tick();
  expect(await submitted()).toHaveLength(2);
  const rows = await engine.executeRaw<{ idempotency_key: string; data: any; max_attempts: number }>('SELECT idempotency_key, data, max_attempts FROM minion_jobs ORDER BY id');
  expect(rows[1].idempotency_key).toBe('autopilot-extract-atoms-drain:git-a:2026-09-20:2');
  expect(rows[1].data.budgetUsd).toBe(0.3);
  expect(rows[1].max_attempts).toBe(1);
  await finishWindow();
  await tick();
  expect(await submitted()).toHaveLength(2);
});

test.each([
  { failure_count: 1 }, { held_failed: 1 }, { write_pending: 1 }, { input_truncated: 1 },
  { tombstoned_for_failures: 1 }, { remaining_is_fresh: false }, { pages_processed: 0 },
  { remaining: 5 }, { spent_usd: null }, { status: 'partial' }, { stopped: 'no_progress' },
])('does not continue an incomplete or failing receipt: %j', async (override) => {
  await gitSource('git-a');
  await tick();
  await finishWindow({ ...cleanWindow, ...override });
  await tick();
  expect(await submitted()).toHaveLength(1);
});

test('cumulative spend plus the next reservation respects the daily cap', async () => {
  await gitSource('git-a');
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.5');
  await tick();
  await finishWindow({ ...cleanWindow, spent_usd: 0.25 });
  await tick();
  expect(await submitted()).toHaveLength(1); // 0.25 spent + 0.30 reserved would exceed 0.50
  await finishWindow({ ...cleanWindow, spent_usd: 0.1 });
  await tick();
  expect(await submitted()).toHaveLength(2);
});

test('configured attempt budgets and pending legacy retries are fully reserved', async () => {
  await gitSource('git-a');
  await gitSource('git-b');
  await engine.setConfig('cycle.extract_atoms.budget_usd', '0.8');
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '1');
  await tick();
  expect(await submitted()).toHaveLength(1);
  await reset();
  await engine.setConfig('autopilot.auto_drain.threshold', '1');
  await engine.setConfig('autopilot.auto_drain.max_usd_per_day', '0.9');
  await gitSource('git-a');
  await gitSource('git-b');
  await priorJob('git-a', DAY1, { status: 'waiting', attempts: 0 });
  await tick();
  expect(await submitted()).toHaveLength(1); // three possible legacy attempts consume the allowance
});

test('an unfinished window from yesterday prevents an overlapping window today', async () => {
  await gitSource('git-a');
  await priorJob('git-a', DAY1, { status: 'waiting', attempts: 0 });
  await tick(DAY2);
  expect(await submitted()).toHaveLength(1);
});

test('an unreadable spend ledger refuses dispatch instead of assuming zero spend', async () => {
  await gitSource('git-a');
  const failedLedger = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async () => { throw new Error('ledger unavailable'); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(submitAutoDrains(failedLedger, queue, { timeoutMs: 60_000, jsonMode: true, now: () => DAY1 }))
    .rejects.toThrow('ledger unavailable');
  expect(await submitted()).toEqual([]);
});
