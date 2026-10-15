/** Native Postgres regression for the fork's unmanaged disk compatibility. No provider calls. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer, waitForWrite } from '../../src/core/persistence/service.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { preparePageAdmission } from '../../src/core/persistence/page-mutations.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';

const databaseUrl = process.env.DATABASE_URL;
const home = mkdtempSync(join(tmpdir(), 'gbrain-unmanaged-pg-'));
let engine: BrainEngine;
let close: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ env: {} });
  if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
}, 120_000);
afterAll(async () => {
  if (engine) await disposePersistenceConsumer(engine);
  await close?.(); resetGateway(); rmSync(home, { recursive: true, force: true });
});
async function fixture(run: (ctx: OperationContext, root: string) => Promise<void>) {
  const sourceId = `legacy-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId); mkdirSync(root);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.setConfig('sync.write_through', 'true'); await engine.unsetConfig('persistence.unbound_write'); _resetWriteThroughCacheForTest();
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    const ctx: OperationContext = { engine, sourceId, remote: false, config: { engine: 'postgres' }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } };
    try { await run(ctx, root); }
    finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  });
}
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, params) as Promise<Record<string, any>>;
const content = (body: string) => `---\ntitle: Example\ntype: note\n---\n\n${body}`;
const put = (ctx: OperationContext, slug: string, body = 'Initial body', extra: Record<string, unknown> = {}) =>
  call(ctx, 'put_page', { slug, content: content(body), request_id: randomUUID(), ...extra });

describe.skipIf(!databaseUrl)('unmanaged Postgres write-through', () => {
  test('put, revision-bound update and replay mirror the committed row without claiming or activating', () => fixture(async (ctx, root) => {
    const slug = 'notes/example'; const request_id = randomUUID();
    const first = await put(ctx, slug, 'Initial body', { request_id });
    expect(first.state).toBe('committed'); expect(first.write_through).toMatchObject({ written: true, mirror: 'legacy_unmanaged' });
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Initial body');
    const second = await put(ctx, slug, 'Updated body', { expected_revision: first.revision });
    expect(second.write_through.written).toBe(true);
    await put(ctx, slug, 'Initial body', { request_id });
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Updated body');
    const [stored] = await engine.executeRaw<{ outcome: Record<string, any> }>('SELECT outcome FROM persistence_requests WHERE request_id=$1', [request_id]);
    expect(stored.outcome.write_through).toMatchObject({ written: true, mirror: 'legacy_unmanaged' });
    expect(await getWorktreeBinding(engine, ctx.sourceId!)).toBeNull();
    expect(await managedPersistenceEnabled(engine)).toBe(false);
    expect(existsSync(join(root, '.gbrain-owner.json'))).toBe(false);
    expect(existsSync(join(root, '.gbrain-managed'))).toBe(false);
  }), 30_000);

  test('remember mirrors the appended fact on an existing page', () => fixture(async (ctx, root) => {
    await put(ctx, 'people/example', 'Biography');
    const result = await call(ctx, 'remember', { entity: 'people/example', fact: 'Prefers written summaries', provenance: 'Synthetic fixture', request_id: randomUUID() });
    expect(result.state).toBe('committed'); expect(result.write_through).toMatchObject({ written: true, mirror: 'legacy_unmanaged' });
    expect(readFileSync(join(root, 'people/example.md'), 'utf8')).toContain('Prefers written summaries');
  }), 30_000);

  test('delete removes a recorded custom path and replay never deletes a restored page', () => fixture(async (ctx, root) => {
    const slug = 'notes/delete'; const first = await put(ctx, slug);
    mkdirSync(join(root, 'custom')); writeFileSync(join(root, 'custom/recorded.md'), readFileSync(join(root, `${slug}.md`)));
    rmSync(join(root, `${slug}.md`));
    await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', ['custom/recorded.md', ctx.sourceId, slug]);
    const request_id = randomUUID();
    const deleted = await call(ctx, 'delete_page', { slug, expected_revision: first.revision, request_id });
    expect(deleted.write_through).toMatchObject({ removed: true, mirror: 'legacy_unmanaged' });
    expect(existsSync(join(root, 'custom/recorded.md'))).toBe(false);
    const restored = await call(ctx, 'restore_page', { slug, expected_revision: deleted.revision, request_id: randomUUID() });
    expect(restored.state).toBe('committed');
    await call(ctx, 'delete_page', { slug, expected_revision: first.revision, request_id });
    expect(existsSync(join(root, 'custom/recorded.md'))).toBe(true);
  }), 30_000);

  test('explicit disabled write-through stays database-only', () => fixture(async (ctx, root) => {
    await engine.setConfig('sync.write_through', 'false'); _resetWriteThroughCacheForTest();
    const result = await put(ctx, 'notes/db-only');
    expect(result.write_through).toMatchObject({ written: false, skipped: 'disabled_by_config' });
    expect(existsSync(join(root, 'notes/db-only.md'))).toBe(false);
  }), 30_000);

  test('connector state directories are not page mirrors', () => fixture(async (ctx, root) => {
    await engine.executeRaw("UPDATE sources SET config=$2::text::jsonb WHERE id=$1", [ctx.sourceId, JSON.stringify({ kind: 'google' })]);
    const result = await put(ctx, 'notes/connector');
    expect(result.write_through).toMatchObject({ written: false, skipped: 'connector_database' });
    expect(existsSync(join(root, 'notes/connector.md'))).toBe(false);
  }), 30_000);

  test('managed mode retains upstream owner refusal', () => fixture(async (ctx, root) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await expect(put(ctx, 'notes/managed')).rejects.toMatchObject({ code: 'owner_unavailable' });
    expect(existsSync(join(root, 'notes/managed.md'))).toBe(false);
    expect(await engine.getPage('notes/managed', { sourceId: ctx.sourceId })).toBeNull();
  }), 30_000);

  test('explicit unbound policies override the classic compatibility default', () => fixture(async (ctx, root) => {
    await engine.setConfig('persistence.unbound_write', 'refuse');
    await expect(put(ctx, 'notes/refused')).rejects.toMatchObject({ code: 'owner_unavailable' });
    await engine.setConfig('persistence.unbound_write', 'database_only');
    const result = await put(ctx, 'notes/explicit-db');
    expect(result.write_through).toMatchObject({ written: false, skipped: 'unbound_source' });
    expect(existsSync(join(root, 'notes/explicit-db.md'))).toBe(false);
    await engine.unsetConfig('persistence.unbound_write');
    const updated = await put(ctx, 'notes/explicit-db', 'Still DB only', { expected_revision: result.revision });
    expect(updated.write_through.written).toBe(false);
    expect(existsSync(join(root, 'notes/explicit-db.md'))).toBe(false);
  }), 30_000);

  test('read-only mirror sources keep the disk untouched', () => fixture(async (ctx, root) => {
    await engine.executeRaw("UPDATE sources SET config=$2::text::jsonb WHERE id=$1", [ctx.sourceId, JSON.stringify({ mirror_read_only: true })]);
    const result = await put(ctx, 'notes/read-only');
    expect(result.state).toBe('committed'); expect(result.write_through.written).toBe(false);
    expect(existsSync(join(root, 'notes/read-only.md'))).toBe(false);
    await engine.executeRaw("UPDATE sources SET config='{}'::jsonb WHERE id=$1", [ctx.sourceId]);
    const updated = await put(ctx, 'notes/read-only', 'Still database-only', { expected_revision: result.revision });
    expect(updated.write_through).toMatchObject({ written: false, skipped: 'mirror_read_only' });
    expect(existsSync(join(root, 'notes/read-only.md'))).toBe(false);
  }), 30_000);

  test('zero-wait writes are mirrored by the background publication lane', () => fixture(async (ctx, root) => {
    const result = await put(ctx, 'notes/background', 'Background body', { wait_ms: 0 }).catch(error => error);
    expect(result.code === 'write_pending' || result.state === 'committed').toBe(true);
    await waitFor(() => existsSync(join(root, 'notes/background.md')), { timeoutMs: 15_000 });
    expect(readFileSync(join(root, 'notes/background.md'), 'utf8')).toContain('Background body');
  }), 30_000);

  test('activation after admission refuses publication rather than bypassing the new mode', () => fixture(async (ctx, root) => {
    const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: {
      slug: 'notes/mode-race', content: content('Must not publish'), request_id: randomUUID(),
    } });
    if (!prepared.admission) throw new Error('Expected a new admission');
    const row = await admitWrite(engine, prepared.admission);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const done = await waitForWrite(engine, row, ctx.config, 10_000);
    expect(done.state).toBe('conflict'); expect(done.error_code).toBe('source_changed');
    expect(await engine.getPage('notes/mode-race', { sourceId: ctx.sourceId })).toBeNull();
    expect(existsSync(join(root, 'notes/mode-race.md'))).toBe(false);
  }), 30_000);

  test('remote cross-source writes remain refused before admission', () => fixture(async (ctx, root) => {
    await expect(put({ ...ctx, remote: true }, 'notes/denied', 'No write', { source_id: 'default' })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(existsSync(join(root, 'notes/denied.md'))).toBe(false);
  }), 30_000);

  test('stale revision cannot change the database or mirror', () => fixture(async (ctx, root) => {
    const slug = 'notes/stale'; const first = await put(ctx, slug);
    await put(ctx, slug, 'Current body', { expected_revision: first.revision });
    await expect(put(ctx, slug, 'Stale body', { expected_revision: first.revision })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Current body');
  }), 30_000);

  test('symlink escape is refused by the mirror and reported without losing the committed page', () => fixture(async (ctx, root) => {
    const outside = join(home, `outside-${randomUUID()}`); mkdirSync(outside); symlinkSync(outside, join(root, 'escape'));
    const result = await put(ctx, 'escape/example');
    expect(result.state).toBe('committed');
    expect(result.write_through).toMatchObject({ written: false, skipped: 'path_escapes_source_root', mirror: 'legacy_unmanaged' });
    expect(existsSync(join(outside, 'example.md'))).toBe(false);
    expect(await engine.getPage('escape/example', { sourceId: ctx.sourceId })).not.toBeNull();
  }), 30_000);
});
