/**
 * Doctor-facing regression test for defect 8.
 *
 * The npm_squat check's message must state the executable that ACTUALLY ran
 * this doctor invocation FIRST — not merely append it as a footnote after a
 * PATH-winner statement that still reads as authoritative for this
 * invocation. Exercises the real doctor path (`runDoctor` -> `buildChecks`),
 * not just the pure `assessGbrainBinaries` helper: a conflicting decoy
 * `gbrain` (classified as a real compiled binary, same as an unrelated
 * `/usr/local/bin/gbrain`-shaped install) sits first on $PATH while
 * `process.argv[1]` simulates a Bun-installed absolute gbrain path actually
 * running this process.
 *
 * Hermetic: HOME/GBRAIN_HOME point at scratch tmpdirs (never the real
 * `~/.gbrain`), and PATH is restored via `withEnv`.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { runDoctor } from '../src/commands/doctor.ts';

/** Run doctor (no DB; null engine + --fast) under scratch HOME/GBRAIN_HOME +
 *  PATH, capture the JSON envelope, and return the named check. Mirrors
 *  test/doctor-home-dir-in-worktree.test.ts's `getCheck` helper. */
async function getNpmSquatCheck(
  env: Record<string, string | undefined>,
): Promise<{ name: string; status: string; message: string } | undefined> {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  const origExit = process.exit;
  const origExitCode = process.exitCode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    throw new Error(`__doctor_exit__:${code ?? 0}`);
  };
  try {
    await withEnv(env, async () => {
      try {
        await runDoctor(null, ['--fast', '--json']);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith('__doctor_exit__:')) throw e;
      }
    });
  } finally {
    console.log = origLog;
    process.exit = origExit;
    process.exitCode = origExitCode;
  }
  const text = captured.join('');
  const lines = text.split('\n');
  let jsonStr = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('{"schema_version"')) {
      jsonStr = trimmed;
      break;
    }
  }
  let parsed: { checks: { name: string; status: string; message: string }[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Could not parse doctor JSON; saw: ${text.slice(-500)}`);
  }
  return parsed.checks.find((c) => c.name === 'npm_squat');
}

describe('doctor npm_squat check — self-identification (defect 8 regression)', () => {
  test('Bun-installed absolute argv[1] vs a conflicting /usr/local/bin-shaped decoy on PATH', async () => {
    const home = emptyHome();
    const decoyDir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-squat-decoy-'));
    const decoyPath = join(decoyDir, 'gbrain');
    // ELF magic bytes: classifies as a 'real' compiled binary (same shape a
    // stale `/usr/local/bin/gbrain` install would take), so it wins on PATH
    // with the (previously) authoritative-sounding "is the real binary" text.
    writeFileSync(decoyPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), { mode: 0o755 });

    const selfPath = '/opt/bun-install/global/node_modules/gbrain/bin/gbrain';
    const origArg1 = process.argv[1];
    process.argv[1] = selfPath;
    try {
      const check = await getNpmSquatCheck({
        HOME: home,
        GBRAIN_HOME: home,
        PATH: `${decoyDir}:${process.env.PATH ?? ''}`,
      });
      expect(check).toBeDefined();
      // Must lead with the actually-running executable — not bury it after a
      // PATH-winner claim that would otherwise read as describing this run.
      expect(check!.message.startsWith(`This invocation is actually running from ${selfPath}`)).toBe(true);
      expect(check!.message).toContain(decoyPath);
    } finally {
      process.argv[1] = origArg1;
      rmSync(decoyDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('argv[1] self path equals the PATH winner → no divergence note', async () => {
    const home = emptyHome();
    const decoyDir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-squat-match-'));
    const selfPath = join(decoyDir, 'gbrain');
    writeFileSync(selfPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), { mode: 0o755 });

    const origArg1 = process.argv[1];
    process.argv[1] = selfPath;
    try {
      const check = await getNpmSquatCheck({
        HOME: home,
        GBRAIN_HOME: home,
        PATH: `${decoyDir}:${process.env.PATH ?? ''}`,
      });
      expect(check).toBeDefined();
      expect(check!.message).not.toContain('actually running');
    } finally {
      process.argv[1] = origArg1;
      rmSync(decoyDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
