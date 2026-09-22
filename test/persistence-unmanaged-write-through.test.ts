import { afterAll, beforeAll, expect, test as bunTest } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setUnownedWriteFallbackForTests } from '../src/core/persistence/unmanaged-mirror.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { withEnv } from './helpers/with-env.ts';

// An unmanaged Postgres brain (managed persistence never activated) with no
// claimed worktree owner keeps the pre-v0.51 behavior: the write commits
// database-only and the legacy write-through mirrors the page file. PGLite
// auto-claims instead, so the decision seam is forced to the Postgres answer.
let engine: PGLiteEngine;
let home: string;
let root: string;
const sourceId = 'unmanaged-write-through-test';
const env = () => ({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });
const ctx = (): OperationContext => ({ engine, remote: false, sourceId, config: { engine: 'pglite' }, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });
const test = (name: string, run: () => Promise<void>) => bunTest(name, () => withEnv(env(), run), 60_000);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-unmanaged-wt-'));
  root = join(home, 'brain'); mkdirSync(root);
  await withEnv(env(), async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
  });
  _resetWriteThroughCacheForTest();
  __setUnownedWriteFallbackForTests(async () => true);
}, 120_000);
afterAll(async () => {
  __setUnownedWriteFallbackForTests(null);
  await disposePersistenceConsumer(engine); await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function receiptWriteThrough(slug: string): Promise<Record<string, unknown>> {
  const [row] = await engine.executeRaw<{ outcome: Record<string, unknown> }>(
    `SELECT outcome FROM persistence_requests WHERE slug=$1 AND source_id=$2 AND state='committed' ORDER BY sequence DESC LIMIT 1`, [slug, sourceId]);
  return row.outcome.write_through as Record<string, unknown>;
}

test('put_page on an unowned source commits database-only and mirrors the file through the legacy writer', async () => {
  const slug = 'notes/unmanaged-put';
  const response = await operationsByName.put_page!.handler(ctx(), {
    slug, content: '---\ntitle: Unmanaged\ntype: note\n---\n\nHello from an unmanaged brain', request_id: randomUUID(),
  }) as Record<string, unknown>;
  expect(response.state).toBe('committed');
  expect(response.write_through).toMatchObject({ written: true, mirror: 'legacy_unmanaged' });
  const file = join(root, `${slug}.md`);
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('Hello from an unmanaged brain');
  expect(await receiptWriteThrough(slug)).toMatchObject({ written: true, mirror: 'legacy_unmanaged' });
  // No worktree was claimed, so no owner markers can fence the legacy sync.
  expect(await getWorktreeBinding(engine, sourceId)).toBeNull();
  expect(existsSync(join(root, '.gbrain-owner.json'))).toBe(false);
});

test('remember with a fenced entity mirrors the appended fact into the page file', async () => {
  const slug = 'people/unmanaged-example';
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    await tx.putPage(slug, { type: 'person', title: 'Example', compiled_truth: 'Existing biography', timeline: '', frontmatter: {} }, { sourceId });
  }));
  const response = await operationsByName.remember!.handler(ctx(), {
    fact: 'Prefers written summaries over calls', provenance: 'test conversation', entity: slug, request_id: randomUUID(),
  }) as Record<string, unknown>;
  expect(response).toMatchObject({ state: 'committed', entity_slug: slug });
  expect(response.write_through).toMatchObject({ written: true, mirror: 'legacy_unmanaged' });
  expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('Prefers written summaries over calls');
});

test('delete_page on an unowned source removes the mirrored file', async () => {
  const slug = 'notes/unmanaged-delete';
  const put = await operationsByName.put_page!.handler(ctx(), {
    slug, content: '---\ntitle: Gone\ntype: note\n---\n\nTo be removed', request_id: randomUUID(),
  }) as Record<string, unknown>;
  const file = join(root, `${slug}.md`);
  expect(existsSync(file)).toBe(true);
  const response = await operationsByName.delete_page!.handler(ctx(), { slug, expected_revision: put.revision, request_id: randomUUID() }) as Record<string, unknown>;
  expect(response.state).toBe('committed');
  expect(response.write_through).toMatchObject({ removed: true, mirror: 'legacy_unmanaged' });
  expect(existsSync(file)).toBe(false);
});

test('sync.write_through=false keeps the write database-only with the config reason', async () => {
  await engine.setConfig('sync.write_through', 'false');
  _resetWriteThroughCacheForTest();
  try {
    const slug = 'notes/unmanaged-db-only';
    const response = await operationsByName.put_page!.handler(ctx(), {
      slug, content: '---\ntitle: DB only\ntype: note\n---\n\nStays in the database', request_id: randomUUID(),
    }) as Record<string, unknown>;
    expect(response.write_through).toMatchObject({ written: false, skipped: 'disabled_by_config' });
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
  } finally {
    await engine.executeRaw(`DELETE FROM config WHERE key='sync.write_through'`).catch(() => engine.setConfig('sync.write_through', 'true'));
    _resetWriteThroughCacheForTest();
  }
});
