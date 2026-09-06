/**
 * Item 9 (fork-pin): the explicit `gbrain self-upgrade [--check-only]` path
 * (src/commands/self-upgrade.ts, shared by the CLI, the gbrain-upgrade agent
 * skill, and the autopilot silent channel) must resolve the configured
 * `self_upgrade.source`, and fail closed — never silently report "up to
 * date" or fetch upstream — when it is malformed/unsupported.
 *
 * Quarantined as *.serial.test.ts: reassigns the process-global `fetch` and
 * mutates GBRAIN_HOME (cross-file-unsafe under the parallel runner).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { runSelfUpgrade } from '../src/commands/self-upgrade.ts';

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
let home: string;
let priorHome: string | undefined;

function writeSourceConfig(source: string): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', self_upgrade: { source } }));
}

function capture(): { log: string[]; err: string[] } {
  const log: string[] = [];
  const err: string[] = [];
  console.log = (...a: unknown[]) => { log.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  return { log, err };
}

beforeEach(() => {
  priorHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-selfupgrade-explicit-pin-'));
  process.env.GBRAIN_HOME = home;
  _resetCliExitVerdictForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
  // setCliExitVerdict mirrors into process.exitCode directly (never read back
  // by the production code) — reset it so this test file's assertions don't
  // leak a nonzero exit code into the shared test-runner process.
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('gbrain self-upgrade --check-only — fail-closed on invalid configured source', () => {
  test('malformed self_upgrade.source: no fetch is ever attempted, --json reports invalid_source', async () => {
    writeSourceConfig('not/a/valid/pin/shape');
    let fetchCalled = false;
    globalThis.fetch = (async (_url: any) => {
      fetchCalled = true;
      return new Response('9.9.9.0\n', { status: 200 });
    }) as typeof fetch;

    const { log } = capture();
    await runSelfUpgrade(['--check-only', '--json']);

    expect(fetchCalled).toBe(false);
    const out = JSON.parse(log.join('\n'));
    expect(out.error).toBe('invalid_source');
    expect(typeof out.error_detail).toBe('string');
    expect(process.exitCode).toBe(1);
  });

  test('malformed self_upgrade.source: non-json mode prints an actionable error, never "up to date"', async () => {
    writeSourceConfig('git@github.com:garrytan/gbrain.git');
    globalThis.fetch = (async (_url: any) => new Response('9.9.9.0\n', { status: 200 })) as typeof fetch;

    const { err, log } = capture();
    await runSelfUpgrade(['--check-only']);

    expect(err.join('\n')).toContain('self_upgrade.source is invalid');
    expect(log.join('\n')).not.toContain('up to date');
    expect(process.exitCode).toBe(1);
  });

  test('malformed self_upgrade.source on the APPLY path (no --check-only): never applies, fails closed the same way', async () => {
    writeSourceConfig('a/b/c');
    let fetchCalled = false;
    globalThis.fetch = (async (_url: any) => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const { err } = capture();
    await runSelfUpgrade([]);

    expect(fetchCalled).toBe(false);
    expect(err.join('\n')).toContain('self_upgrade.source is invalid');
    expect(process.exitCode).toBe(1);
  });
});
