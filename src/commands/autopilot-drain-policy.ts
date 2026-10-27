/** Durable, conservative accounting for automatic atom-drain continuations. */
import type { BrainEngine } from '../core/engine.ts';
import { STRUCTURAL_REFUSAL_PREFIX } from '../core/cycle/extract-atoms-drain.ts';

export interface DrainJobReceipt {
  id: number;
  status: string;
  data: Record<string, unknown>;
  result: Record<string, unknown>;
  attempts_started: number;
  max_attempts: number;
  error_text: string | null;
  idempotency_key: string | null;
}

const terminal = new Set(['completed', 'failed', 'dead', 'cancelled']);
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function object(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return object(JSON.parse(v));
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** Include carry-over active work and work finishing today, not just newly submitted jobs. */
export async function loadDrainDay(engine: BrainEngine, utcDay: string, perAttemptUsd: number): Promise<{
  jobs: DrainJobReceipt[]; chargedUsd: number;
}> {
  const rows = await engine.executeRaw<DrainJobReceipt>(
    `SELECT id, status, data, result, attempts_started, max_attempts, error_text, idempotency_key
       FROM minion_jobs WHERE name = 'extract-atoms-drain'
       AND (created_at >= $1::timestamptz OR finished_at >= $1::timestamptz
         OR status NOT IN ('completed','failed','dead','cancelled')) ORDER BY id`,
    [`${utcDay}T00:00:00Z`],
  );
  const jobs = rows.map(row => ({ ...row, data: object(row.data), result: object(row.result) }));
  let chargedUsd = 0;
  for (const job of jobs) {
    const started = Math.max(0, Number(job.attempts_started));
    if (!Number.isFinite(started)) throw new Error('Cannot account for atom-drain attempts.');
    if (job.status === 'dead' && started <= 1 && job.error_text?.startsWith(STRUCTURAL_REFUSAL_PREFIX)) continue;
    const cap = nonnegative(job.data.budgetUsd) && job.data.budgetUsd > 0 ? job.data.budgetUsd : perAttemptUsd;
    if (!terminal.has(job.status)) {
      // Older jobs may still retry: reserve ALL remaining attempts before admitting more work.
      chargedUsd += cap * Math.max(1, started, Number(job.max_attempts));
    } else if (job.status === 'completed' && nonnegative(job.result.spent_usd)) {
      chargedUsd += cap * Math.max(0, started - 1) + job.result.spent_usd;
    } else if (job.status !== 'cancelled' || started > 0) {
      // A crash, legacy receipt or provider failure has no reliable final usage.
      chargedUsd += cap * Math.max(1, started);
    }
  }
  if (!Number.isFinite(chargedUsd)) throw new Error('Cannot account for atom-drain spend.');
  return { jobs, chargedUsd };
}

/** Only a clean, measured partial completion may create another paid window. */
export function canContinueDrain(job: DrainJobReceipt): boolean {
  if (job.status !== 'completed') return false;
  const r = job.result;
  if (r.deferred === true && r.reason === 'cycle_already_running') return true;
  return r.status === 'ok' && r.source_id === job.data.sourceId
    && ['window', 'max_batches', 'budget'].includes(String(r.stopped))
    && r.remaining_is_fresh === true
    && nonnegative(r.initial_remaining) && nonnegative(r.remaining)
    && r.remaining > 0 && r.remaining < r.initial_remaining
    && nonnegative(r.pages_processed) && r.pages_processed > 0
    && nonnegative(r.spent_usd)
    && ['failure_count', 'held_failed', 'write_pending', 'input_truncated', 'tombstoned_for_failures', 'malformed_outputs', 'stopped_outputs']
      .every(key => r[key] === 0);
}

export function nextDrainWindow(jobs: DrainJobReceipt[], sourceId: string, utcDay: string, maxWindows: number): number | null {
  const sourceJobs = jobs.filter(job => job.data.sourceId === sourceId);
  if (sourceJobs.some(job => !terminal.has(job.status))) return null;
  const prefix = `autopilot-extract-atoms-drain:${sourceId}:${utcDay}`;
  const today = sourceJobs.filter(job => job.idempotency_key === prefix || job.idempotency_key?.startsWith(`${prefix}:`));
  if (today.length >= maxWindows) return null;
  if (today.length && !canContinueDrain(today[today.length - 1])) return null;
  return today.length + 1;
}
