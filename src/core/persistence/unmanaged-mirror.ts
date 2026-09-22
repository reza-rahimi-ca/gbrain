import type { BrainEngine } from '../engine.ts';
import { deletePageThrough, writePageThrough } from '../write-through.ts';
import type { WriteRequest } from './model.ts';
import { managedPersistenceEnabled } from './ownership.ts';

/**
 * Unmanaged Postgres brain without a claimed owner for the target source.
 *
 * v0.51 refuses fenced `remember` / `put_page` writes on Postgres unless the
 * source has a claimed worktree owner. A claim, however, leaves owner markers
 * that fence every legacy filesystem writer (sync, autopilot), and activating
 * managed mode is not possible on a brain with connector sources. So a brain
 * that never activated managed mode keeps the pre-v0.51 behavior instead:
 * the request commits database-only through the coordinator and the page is
 * mirrored to disk afterwards with the legacy write-through, which renders
 * the committed row and takes the ordinary per-source filesystem lock.
 */
export const UNMANAGED_NO_OWNER = 'unmanaged_no_owner';

type FallbackDecider = (engine: BrainEngine) => Promise<boolean>;
const defaultDecider: FallbackDecider = async engine => engine.kind !== 'pglite' && !(await managedPersistenceEnabled(engine));
let decider: FallbackDecider = defaultDecider;

/** True when an unowned write should commit database-only and mirror through the legacy writer. */
export function unownedWriteFallsBackToLegacy(engine: BrainEngine): Promise<boolean> { return decider(engine); }
/** Test seam: PGLite auto-claims, so unit tests force the Postgres decision. */
export function __setUnownedWriteFallbackForTests(next: FallbackDecider | null): void { decider = next ?? defaultDecider; }

const logger = { warn: (msg: string) => { process.stderr.write(`${msg}\n`); } };

/** After a database-only commit for an unowned source, mirror the page file and record the result on the receipt. */
export async function mirrorUnmanagedWrite(engine: BrainEngine, row: WriteRequest): Promise<WriteRequest> {
  if (row.state !== 'committed' || row.authority?.databaseOnlyReason !== UNMANAGED_NO_OWNER) return row;
  // Idempotent: the submitting caller mirrors right after its wait observes the
  // commit (deterministic response), and the coordinator repeats the call as a
  // backstop for callers whose wait timed out. A recorded result ends both.
  if ((row.outcome?.write_through as { mirror?: unknown } | undefined)?.mirror) return row;
  let writeThrough: Record<string, unknown>;
  try {
    const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
    if (!snapshot || snapshot.page.deleted_at) {
      const removed = await deletePageThrough(engine, row.slug, { sourceId: row.source_id, logger });
      writeThrough = { written: false, ...removed };
    } else {
      writeThrough = { ...await writePageThrough(engine, row.slug, { sourceId: row.source_id, logger }) };
    }
  } catch (error) {
    writeThrough = { written: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeThrough.mirror = 'legacy_unmanaged';
  // Positional jsonb bind goes through text so postgres.js cannot double-encode it.
  await engine.executeRaw(`UPDATE persistence_requests SET outcome=jsonb_set(COALESCE(outcome,'{}'::jsonb),'{write_through}',$2::text::jsonb)
    WHERE id=$1::uuid AND state='committed'`, [row.id, JSON.stringify(writeThrough)]);
  return { ...row, outcome: { ...(row.outcome ?? {}), write_through: writeThrough } };
}
