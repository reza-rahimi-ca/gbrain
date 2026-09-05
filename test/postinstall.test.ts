/**
 * Regression test for scripts/postinstall.ts (defect 4).
 *
 * The postinstall hook used to resolve the CLI to run migrations against via
 * `which('gbrain')` — a PATH lookup that can resolve to a completely
 * different `gbrain` install than the one `bun install` just wrote to disk
 * (a stale global copy, an unrelated npm-squatted package, or simply nothing
 * on a fresh clone). It now resolves its own sibling entrypoint (`bin.gbrain`
 * from the package.json next to this script) and spawns THAT path directly.
 *
 * This test builds a scratch "package" directory containing a copy of the
 * REAL production script (so we exercise the shipped resolution logic, not a
 * re-implementation) plus a stub `src/cli.ts` that records how it was
 * invoked. A decoy `gbrain` shim is placed first on $PATH; if postinstall
 * still did a PATH lookup, the decoy — not the stub — would run.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REAL_POSTINSTALL = join(import.meta.dir, '..', 'scripts', 'postinstall.ts');

function buildScratchPackage(): { pkgRoot: string; marker: string } {
  const pkgRoot = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-pkg-'));
  mkdirSync(join(pkgRoot, 'scripts'), { recursive: true });
  mkdirSync(join(pkgRoot, 'src'), { recursive: true });

  // Copy the real production script verbatim — the resolution logic under
  // test lives there, not in a test double.
  writeFileSync(join(pkgRoot, 'scripts', 'postinstall.ts'), readFileSync(REAL_POSTINSTALL, 'utf-8'));

  writeFileSync(
    join(pkgRoot, 'package.json'),
    JSON.stringify({ name: 'gbrain', bin: { gbrain: 'src/cli.ts' } }),
  );

  // Stub CLI: records its own argv to `marker`, exits 0. Never touches any
  // brain/config — this is a fake entrypoint, not the real gbrain CLI.
  const marker = join(pkgRoot, 'invoked.json');
  writeFileSync(
    join(pkgRoot, 'src', 'cli.ts'),
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
  );

  return { pkgRoot, marker };
}

describe('scripts/postinstall.ts — self-resolution (defect 4 regression)', () => {
  test('spawns the sibling cli.ts, never a decoy on $PATH', () => {
    const { pkgRoot, marker } = buildScratchPackage();
    const decoyDir = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-decoy-'));
    const decoyMarker = join(pkgRoot, 'decoy-invoked.json');
    try {
      // A DIFFERENT gbrain, first on $PATH. If postinstall ever regresses to
      // a PATH lookup, this decoy runs instead of the sibling stub.
      writeFileSync(
        join(decoyDir, 'gbrain'),
        `#!/bin/sh\necho invoked > ${decoyMarker}\n`,
        { mode: 0o755 },
      );

      const result = spawnSync(
        process.execPath,
        ['run', join(pkgRoot, 'scripts', 'postinstall.ts')],
        {
          env: { ...process.env, PATH: `${decoyDir}:${process.env.PATH ?? ''}` },
          encoding: 'utf-8',
          timeout: 30_000,
        },
      );

      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(JSON.parse(readFileSync(marker, 'utf-8'))).toEqual([
        'apply-migrations',
        '--yes',
        '--non-interactive',
      ]);
      expect(existsSync(decoyMarker)).toBe(false);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  test('skips cleanly (exit 0, no throw) when the sibling entrypoint is missing', () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-missing-'));
    try {
      mkdirSync(join(pkgRoot, 'scripts'), { recursive: true });
      writeFileSync(join(pkgRoot, 'scripts', 'postinstall.ts'), readFileSync(REAL_POSTINSTALL, 'utf-8'));
      writeFileSync(
        join(pkgRoot, 'package.json'),
        JSON.stringify({ name: 'gbrain', bin: { gbrain: 'src/cli.ts' } }),
      );
      // No src/cli.ts written — simulates a vendored/partial tree.

      const result = spawnSync(
        process.execPath,
        ['run', join(pkgRoot, 'scripts', 'postinstall.ts')],
        { env: process.env, encoding: 'utf-8', timeout: 30_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('[gbrain] postinstall skipped');
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });
});
