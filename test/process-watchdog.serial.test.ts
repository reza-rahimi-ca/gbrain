/**
 * Bun-pinned integration for the out-of-band watchdog (#1633, plan A4).
 *
 * Bun's worker_threads Worker is flagged "experimental", and the whole #1633
 * fix rests on a worker timer firing + SIGKILLing the process while the MAIN
 * thread is starved by a synchronous loop. These tests spawn a real harness
 * process that starves its own loop and assert the watchdog kills it anyway.
 *
 * Serial because they use real subprocesses + wall-clock timing.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const HARNESS = join(import.meta.dir, 'fixtures', 'watchdog-harness.ts');

interface HarnessRun {
  exitCode: number | null;
  /** Bun's race-free signal attribution — set even when exitCode is also non-null. */
  signalCode: string | null;
  signalled: boolean;
  elapsedMs: number;
  /** wall-clock ms from the child's ARMED marker to exit; -1 if never armed (stall-* modes only). */
  sinceArmedMs: number;
  stdout: string;
  stderr: string;
  killedByTest: boolean;
}

/**
 * Spawn the harness. `hardCapMs` is a spawn-relative failsafe (kept for the
 * hard-deadline modes, which print no marker); stall-* modes additionally
 * print an ARMED marker right before starving, and `sinceArmedMs` measures
 * from that — Bun/worker boot time is otherwise unpredictable noise on a
 * loaded box (same technique as pglite-disconnect-watchdog.serial.test.ts).
 */
async function runHarness(
  mode: string,
  deadlineMs: number,
  graceMs: number,
  hardCapMs: number,
): Promise<HarnessRun> {
  const proc = Bun.spawn(['bun', HARNESS, mode, String(deadlineMs), String(graceMs)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const start = Date.now();
  let killedByTest = false;
  let armedAt = 0;
  const cap = setTimeout(() => { killedByTest = true; proc.kill('SIGKILL'); }, hardCapMs);
  let stdout = '';
  const stdoutReader = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      stdout += dec.decode(chunk);
      if (!armedAt && stdout.includes('ARMED')) armedAt = Date.now();
    }
  })();
  await proc.exited;
  const exitAt = Date.now();
  clearTimeout(cap);
  await stdoutReader;
  const elapsedMs = exitAt - start;
  const stderr = await new Response(proc.stderr).text();
  const signalCode = (proc as unknown as { signalCode: string | null }).signalCode;
  // Bun surfaces signal death via exitCode === null + signalCode, or a negative
  // exitCode on some platforms. Treat "not a clean 0" as signalled for our purpose.
  const signalled = proc.exitCode !== 0;
  return {
    exitCode: proc.exitCode,
    signalCode,
    signalled,
    elapsedMs,
    sinceArmedMs: armedAt ? exitAt - armedAt : -1,
    stdout,
    stderr,
    killedByTest,
  };
}

describe('process-watchdog integration (Bun-pinned)', () => {
  test('starved process IS killed by the watchdog around deadline+grace', async () => {
    // deadline 300 + grace 200 = ~500ms expected death. Hard cap 4s: if the
    // watchdog failed, the test's own SIGKILL fires and the assertion catches it.
    const r = await runHarness('starve-with', 300, 200, 4000);
    expect(r.stdout).not.toContain('SURVIVED'); // the bug symptom
    expect(r.killedByTest).toBe(false);          // watchdog, not the test, killed it
    expect(r.signalled).toBe(true);
    // Died well before the harness's 8s self-exit safety net, near deadline+grace.
    expect(r.elapsedMs).toBeLessThan(3000);
  }, 15000);

  test('control: a starved process WITHOUT the watchdog does not self-exit', async () => {
    // Proves the busy loop genuinely starves (so the death above is the watchdog).
    // No watchdog installed; the test's hard cap (1.2s) is what kills it.
    const r = await runHarness('starve-without', 300, 200, 1200);
    expect(r.killedByTest).toBe(true);   // only the test's SIGKILL stopped it
    expect(r.stdout).not.toContain('SURVIVED');
  }, 15000);

  test('clean dispose: a disposed watchdog never kills the process', async () => {
    // Long deadline, disposed immediately, process exits 0 fast and prints DISPOSED.
    const r = await runHarness('clean-dispose', 60000, 60000, 5000);
    expect(r.exitCode).toBe(0);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).toContain('DISPOSED');
    expect(r.elapsedMs).toBeLessThan(4000);
  }, 15000);
});

describe('loop-stall watchdog integration (Bun-pinned, #4281)', () => {
  const STALL_MS = 300;
  const GRACE_MS = 250;

  test('starved loop with a SIGTERM listener is SIGTERMed then SIGKILLed around stall+grace', async () => {
    // stall 300 + grace 250 = ~550ms expected death (plus worker boot). The
    // harness registers a SIGTERM listener, so only the SIGKILL escalation can
    // actually kill it — exactly the serve-http shape (process-cleanup's
    // handler can't run on a starved loop).
    //
    // NOTE: we do not assert on the worker's in-flight "SIGTERM"/"SIGKILL"
    // stderr lines. The worker's process.stderr is proxied through the main
    // thread's message port; while the main loop is genuinely starved (the
    // premise of this test), that proxied write can never flush before the
    // SIGKILL that ends the process. signalCode + marker-relative timing
    // below are the race-free proof of the escalation instead.
    const r = await runHarness('stall-with', STALL_MS, GRACE_MS, 5000);
    expect(r.stdout).not.toContain('SURVIVED'); // the bug symptom
    expect(r.killedByTest).toBe(false);          // watchdog, not the test, killed it
    expect(r.signalCode).toBe('SIGKILL');
    // Death lands near stall+grace, measured from the child's ARMED marker.
    expect(r.sinceArmedMs).toBeGreaterThanOrEqual(STALL_MS + GRACE_MS - 150);
    expect(r.sinceArmedMs).toBeLessThan(3500);
  }, 15000);

  test('stall-no-handler: without a SIGTERM listener, the FIRST stage kills near the stall threshold, before grace/SIGKILL', async () => {
    // Same armed wedge as stall-with, but with no SIGTERM listener registered.
    // The kernel's default SIGTERM disposition doesn't need the (starved)
    // event loop to run at all, so this process must die at the watchdog's
    // FIRST stage — the mirror-image proof to stall-with's SIGKILL backstop.
    const r = await runHarness('stall-no-handler', STALL_MS, GRACE_MS, 5000);
    expect(r.stdout).not.toContain('SURVIVED'); // the bug symptom
    expect(r.killedByTest).toBe(false);          // watchdog, not the test, killed it
    // signalCode === 'SIGTERM' is the race-free proof of ordering (first
    // stage, not the SIGKILL/grace stage) — timing alone could never
    // distinguish the two as cleanly.
    expect(r.signalCode).toBe('SIGTERM');
    // Unlike pglite-disconnect-watchdog.serial.test.ts's ARMED marker (which
    // is printed BEFORE installProcessWatchdog is even called, so it precedes
    // the worker_threads Worker's own boot time), this harness's ARMED prints
    // AFTER installStall() returns — i.e. AFTER `new Worker(...)` has already
    // been issued. The window this bound has to tolerate is only "worker
    // reaches its first internal tick", not "worker gets created at all", so
    // it's structurally smaller. Measured directly (bun test, fresh scratch
    // HOME, x5): sinceArmedMs lands at ~317-319ms, comfortably inside this
    // bound — kept tight rather than widened to an arbitrary allowance
    // because the margin is real, not assumed.
    expect(r.sinceArmedMs).toBeGreaterThanOrEqual(STALL_MS - 150);
    expect(r.sinceArmedMs).toBeLessThan(STALL_MS + GRACE_MS - 50);
  }, 15000);

  test('healthy petting loop is NEVER killed across multiple stall windows', async () => {
    // The false-positive pin: the harness idles (pets flowing) for well past
    // stall+grace. Any signal is a watchdog bug — a false SIGTERM prints
    // TERMED and exits 1; a false SIGKILL shows as non-zero exit.
    const r = await runHarness('stall-healthy', 300, 200, 6000);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).not.toContain('TERMED');
    expect(r.stdout).toContain('HEALTHY');
    expect(r.exitCode).toBe(0);
  }, 15000);

  test('disposed stall watchdog never kills, even under genuine starvation', async () => {
    // Disposed immediately, then the harness truly starves past stall+grace.
    const r = await runHarness('stall-dispose', 300, 200, 6000);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).toContain('DISPOSED');
    expect(r.exitCode).toBe(0);
  }, 15000);
});
