import type { BrainEngine } from '../engine.ts';
import { deletePageThrough, resolvePageWriteTarget, writePageThrough } from '../write-through.ts';
import { withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from './ownership.ts';
import { getWriteRequestById, lockCounters } from './journal.ts';
import { principalKey, requestPrincipal } from './model.ts';
import { declareDurablePersistence } from './protocol.ts';
import { sourceMirrorReadOnly, isMirrorOnlyPage } from './mirror-read-only.ts';
import { isUnboundSourcePage } from './unbound-source.ts';
import { OperationError } from '../ops/contract.ts';
import { jsonBytes } from './digest.ts';
import { EFFECT_BYTES_SQL } from './receipt-bytes.ts';

export const UNMANAGED_NO_OWNER = 'unmanaged_no_owner';

/** Only the classic Postgres path changes. PGLite and managed owners keep upstream behavior. */
export async function unownedWriteFallsBackToLegacy(engine: BrainEngine): Promise<boolean> {
  return engine.kind === 'postgres' && !(await managedPersistenceEnabled(engine))
    && await engine.getConfig('persistence.unbound_write') === null;
}

/** Publication holds the brain/source locks, so activation or a new owner cannot race this decision. */
export async function assertUnmanagedPublication(tx: SqlEngine, row: WriteRequest): Promise<void> {
  if (row.authority.databaseOnlyReason !== UNMANAGED_NO_OWNER) return;
  if (await managedPersistenceEnabled(tx) || await getWorktreeBinding(tx, row.source_id)) {
    throw new OperationError('source_changed', 'The unmanaged source gained an owner or activated managed persistence before publication.',
      'Read the current writer status and retry with a new request_id.');
  }
}

function mirrored(row: WriteRequest): boolean {
  return (row.outcome?.write_through as { mirror?: unknown } | undefined)?.mirror === 'legacy_unmanaged';
}
const logger = { warn: (message: string) => process.stderr.write(`${message}\n`) };

/**
 * Best-effort classic mirror AFTER the journal commit, not atomic managed persistence.
 * The root lock encloses the current-page read and write/delete decision; a late replay
 * never replays old content. Existing receipt results are stable, including failures.
 * Both publication lanes run this for timed-out callers; wait/replay also completes it.
 */
export async function mirrorUnmanagedWrite(engine: BrainEngine, row: WriteRequest): Promise<WriteRequest> {
  if (engine.kind !== 'postgres' || row.state !== 'committed' || row.authority.databaseOnlyReason !== UNMANAGED_NO_OWNER || mirrored(row)
    || (row.outcome?.write_through as { skipped?: string } | undefined)?.skipped !== UNMANAGED_NO_OWNER) return row;
  let result: Record<string, unknown>;
  try {
    const target = await resolvePageWriteTarget(engine, row.slug, row.source_id, { includeDeleted: true });
    result = !target.ok ? { written: false, skipped: target.skipped } : await withSourceFilesystemLock(engine, target.writeRoot, async () => {
      const current = await getWriteRequestById(engine, row.id);
      if (current && mirrored(current)) return current.outcome!.write_through as Record<string, unknown>;
      const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [row.source_id]);
      if (!source || source.archived || source.incarnation !== row.source_incarnation) return { written: false, skipped: 'source_changed' };
      if (!await unownedWriteFallsBackToLegacy(engine) || await getWorktreeBinding(engine, row.source_id)) return { written: false, skipped: 'managed_owner_required' };
      if (await sourceMirrorReadOnly(engine, row.source_id) || await isMirrorOnlyPage(engine, row.source_id, row.slug)
        || await isUnboundSourcePage(engine, row.source_id, row.slug)) return { written: false, skipped: 'database_only' };
      const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      // A purged/recreated page is not the accepted target. Tombstones preserve their recorded path.
      if (!snapshot || (row.page_id !== null && snapshot.page.id !== row.page_id)) return { written: false, skipped: 'page_identity_changed' };
      if (snapshot.page.deleted_at) {
        const deletedTarget = await resolvePageWriteTarget(engine, row.slug, row.source_id, { includeDeleted: true });
        return { written: false, ...await deletePageThrough(engine, row.slug, { sourceId: row.source_id, target: deletedTarget, logger }) };
      }
      return { ...await writePageThrough(engine, row.slug, { sourceId: row.source_id, logger }) };
    });
  } catch (error) {
    result = { written: false, error: String(error instanceof Error ? error.message : error).slice(0, 512) };
  }
  result.mirror = 'legacy_unmanaged';
  // Keep the bounded result within the completion headroom already reserved at admission.
  if (jsonBytes(result) > 2048) result = { written: result.written, removed: result.removed, mirror: 'legacy_unmanaged', warning: 'Mirror detail exceeded receipt limit.' };
  try {
    return await engine.transaction(async tx => {
      await declareDurablePersistence(tx);
      await lockCounters(tx, ['brain', principalKey(requestPrincipal(row))]);
      const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
      if (!current || current.compacted || mirrored(current)) return current ?? row;
      const outcome = { ...current.outcome, write_through: result };
      const bytes = jsonBytes(outcome) + jsonBytes(current.authority) + jsonBytes(current.intent) + 1024;
      const [updated] = await tx.executeRaw<WriteRequest>(`UPDATE persistence_requests SET outcome=$2::text::jsonb,updated_at=now()
        WHERE id=$1::uuid AND state='committed' AND $3::bigint+(SELECT COALESCE(SUM(${EFFECT_BYTES_SQL}),0) FROM persistence_effects WHERE request_id=$1::uuid)<=terminal_reservation RETURNING *`,
      [row.id, JSON.stringify(outcome), bytes]);
      if (!updated) throw new Error('Mirror result could not fit the reserved receipt.');
      return updated;
    });
  } catch {
    // The DB mutation already committed. Never turn a mirror/receipt failure into a failed write.
    return { ...row, outcome: { ...row.outcome, write_through: { ...result, warning: 'Mirror receipt was not saved; retry the same request_id to inspect it.' } } };
  }
}
