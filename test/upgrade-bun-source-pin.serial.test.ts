/**
 * Item 9 (fork-pin): the `bun` install-method lane in `runUpgrade`
 * (src/commands/upgrade.ts) must invoke the PINNED Bun GitHub install target
 * (`bun add -g github:<owner>/<repo>#<ref>`) when `self_upgrade.source` is
 * configured, instead of the ordinary `bun update gbrain` — and a
 * malformed/unsupported configured source must fail closed (never invoke
 * `bun` at all, never install/upgrade against upstream `garrytan/gbrain`).
 *
 * Mirrors the hermetic-fake-install pattern in
 * test/upgrade.serial.test.ts ("runUpgrade target verification #4366"):
 * `runUpgrade` is driven in a subprocess (Bun snapshots environ at birth, so
 * PATH shims can't be injected in-process) against a fake HOME with a
 * PATH-first `bun` shim that records its argv instead of running the real
 * package manager. `detectInstallMethod()` is forced to 'bun' by placing the
 * driver script under a `node_modules` directory (the same substring check
 * `detectInstallMethod` uses).
 */
import { describe, test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;
const REAL_BUN = process.execPath;

async function runUpgradeBunLane(opts: {
  selfUpgradeSource?: string;
  /** Write this literal content as config.json instead of a JSON.stringify'd
   * `{ self_upgrade: { source } }` — for proving a genuinely unparseable
   * config file (not just a malformed pin string) fails closed too. */
  rawConfigJson?: string;
}): Promise<{ home: string; exitCode: number; stderr: string; argvLog: string[] }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-bun-pin-'));
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });

  const argvLogPath = join(home, 'bun-argv.log');
  // PATH-first `bun` shim: records argv, never touches the network / a real
  // package manager. `$@` is quoted so a compound arg (the github: target)
  // logs as one line.
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$@" >> "${argvLogPath}"\nexit 0\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  // verifyUpgrade() unconditionally shells out to `gbrain --version` after any
  // successful swap — shim it so the upgrade path completes cleanly.
  writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\necho "gbrain 9.9.9.0"\n');
  chmodSync(join(bin, 'gbrain'), 0o755);

  const bunInstallRoot = join(home, 'bun-install');
  mkdirSync(join(bunInstallRoot, 'install', 'global'), { recursive: true });

  if (opts.rawConfigJson !== undefined) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), opts.rawConfigJson);
  } else if (opts.selfUpgradeSource !== undefined) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', self_upgrade: { source: opts.selfUpgradeSource } }),
    );
  }

  // Driver lives under a `node_modules` dir so detectInstallMethod()'s
  // `process.argv[1]?.includes('node_modules')` check selects the 'bun' lane
  // (bun-link's .git/config walk finds nothing under a fresh temp dir, so it
  // falls through here, same as production bun/npm-global installs).
  const driverDir = join(home, 'node_modules');
  mkdirSync(driverDir, { recursive: true });
  const driverPath = join(driverDir, 'driver.ts');
  writeFileSync(
    driverPath,
    `import { runUpgrade } from '${repoRoot}src/commands/upgrade.ts';\n` +
      `await runUpgrade(['--swap-only'], {});\n`,
  );

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    GBRAIN_HOME: home,
    BUN_INSTALL: bunInstallRoot,
    PATH: `${bin}:${process.env.PATH}`,
    GBRAIN_SELF_UPGRADE_SOURCE: undefined,
  };
  delete env.GBRAIN_SELF_UPGRADE_SOURCE;

  // Outer interpreter uses the REAL bun binary by absolute path (bypassing
  // PATH lookup) so the shimmed `bun` on PATH only intercepts the
  // execFileSync('bun', ...) call INSIDE runUpgrade, not this invocation.
  const proc = Bun.spawn([REAL_BUN, 'run', driverPath], {
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const argvLog = existsSync(argvLogPath)
    ? readFileSync(argvLogPath, 'utf-8').trim().split('\n').filter(Boolean)
    : [];
  return { home, exitCode, stderr, argvLog };
}

describe('runUpgrade — bun lane resolves the configured self-upgrade source', () => {
  test('no source configured → ordinary `bun update gbrain` (unchanged upstream default)', async () => {
    const { home, exitCode, argvLog } = await runUpgradeBunLane({});
    try {
      expect(exitCode).toBe(0);
      expect(argvLog).toEqual(['update gbrain']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('pinned source → `bun add -g github:<owner>/<repo>#<ref>`, never `bun update gbrain`, never garrytan', async () => {
    const { home, exitCode, argvLog, stderr } = await runUpgradeBunLane({
      selfUpgradeSource: 'reza-rahimi-ca/gbrain#feat/openrouter-only-install',
    });
    try {
      expect(exitCode).toBe(0);
      expect(argvLog).toEqual(['add -g github:reza-rahimi-ca/gbrain#feat/openrouter-only-install']);
      expect(argvLog.join('\n')).not.toContain('update gbrain');
      expect(argvLog.join('\n')).not.toContain('garrytan');
      expect(stderr).not.toContain('garrytan/gbrain#v');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('malformed self_upgrade.source → fails closed: bun is NEVER invoked, no install of any kind', async () => {
    const { home, exitCode, argvLog, stderr } = await runUpgradeBunLane({
      selfUpgradeSource: 'https://not-owner-slash-repo.example/x',
    });
    try {
      // No bun invocation happened at all — the shim never ran, so its log
      // file was never created. (stderr may still carry the UNRELATED
      // anti-squatter heuristic's own "not from garrytan/gbrain" warning —
      // that's about verifying the CURRENTLY installed package's origin,
      // not about which source this upgrade would fetch/install from — so
      // this test asserts no bun invocation happened, not that the string
      // never appears anywhere in stderr.)
      expect(argvLog).toEqual([]);
      expect(stderr).toContain('Self-upgrade source is invalid');
      expect(exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('genuinely corrupt (unparseable) EXISTING config.json → fails closed: bun is NEVER invoked (independent acceptance review, item 9 correction: gap #3)', async () => {
    // Distinct from the "malformed pin string inside valid JSON" case above:
    // here the config FILE itself is not valid JSON at all, so the intended
    // pin is unknowable. Must refuse the install the same way, never
    // silently fall back to installing/upgrading against upstream.
    const { home, exitCode, argvLog, stderr } = await runUpgradeBunLane({
      rawConfigJson: '{ this is not valid json',
    });
    try {
      expect(argvLog).toEqual([]);
      expect(stderr).toContain('Self-upgrade source is invalid');
      expect(exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
