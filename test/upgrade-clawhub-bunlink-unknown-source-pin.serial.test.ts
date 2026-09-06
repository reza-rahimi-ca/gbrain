/**
 * Item 9 correction pass, gap #1: every install-method lane in `runUpgrade`
 * (src/commands/upgrade.ts) must honor a configured `self_upgrade.source`
 * and fail closed — not just the `bun` and `binary` lanes.
 *
 *   - clawhub has no fork/branch concept; a pinned source must refuse to run
 *     `clawhub update gbrain` (which would silently track upstream).
 *   - the 'unknown' fallback must not recommend upstream-specific commands
 *     when a source is pinned or invalid.
 *   - bun-link (source-clone dev installs) must recognize a clone of the
 *     PINNED fork (not just upstream `garrytan/gbrain`), and must refuse to
 *     `git pull` a clone whose checked-out ref doesn't match the pin.
 *
 * Mirrors the hermetic-fake-install subprocess pattern in
 * test/upgrade-bun-source-pin.serial.test.ts: `runUpgrade` is driven in a
 * subprocess (Bun snapshots environ at birth) against a fake HOME with
 * PATH-first shims for `git`/`bun`/`clawhub`/`gbrain` that record their argv
 * instead of running the real tools.
 */
import { describe, test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;
const REAL_BUN = process.execPath;

interface LaneOpts {
  selfUpgradeSource?: string;
  /** Content written to the fake clone's `.git/config` (bun-link detection). */
  gitConfigRepoMarker?: string;
  /** Branch name the `git rev-parse --abbrev-ref HEAD` shim reports. */
  gitBranch?: string;
  /** Whether a working `clawhub --version` shim is on PATH. */
  clawhubAvailable?: boolean;
}

interface LaneResult {
  home: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  gitLog: string[];
  bunLog: string[];
  clawhubLog: string[];
}

async function runUpgradeLane(opts: LaneOpts): Promise<LaneResult> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-lane-'));
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });

  const gitLogPath = join(home, 'git-argv.log');
  const bunLogPath = join(home, 'bun-argv.log');
  const clawhubLogPath = join(home, 'clawhub-argv.log');
  const branchFile = join(home, 'branch.txt');
  writeFileSync(branchFile, opts.gitBranch ?? 'master');

  // git shim: argv is always `-C <repoRoot> <subcommand> ...` for both call
  // sites in the bun-link lane. `rev-parse` answers from branchFile; every
  // other subcommand (pull, etc.) just logs + succeeds.
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\n` +
      `shift; shift\n` + // drop "-C" "<repoRoot>"
      `if [ "$1" = "rev-parse" ]; then cat "${branchFile}"; exit 0; fi\n` +
      `echo "$@" >> "${gitLogPath}"\n` +
      `exit 0\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);

  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$@" >> "${bunLogPath}"\nexit 0\n`);
  chmodSync(join(bin, 'bun'), 0o755);

  if (opts.clawhubAvailable) {
    writeFileSync(join(bin, 'clawhub'), `#!/bin/sh\necho "$@" >> "${clawhubLogPath}"\nexit 0\n`);
    chmodSync(join(bin, 'clawhub'), 0o755);
  }

  // verifyUpgrade() shells out to `gbrain --version` after any successful swap.
  writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\necho "gbrain 9.9.9.0"\n');
  chmodSync(join(bin, 'gbrain'), 0o755);

  if (opts.selfUpgradeSource !== undefined) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', self_upgrade: { source: opts.selfUpgradeSource } }),
    );
  }

  // Driver directory layout decides which lane detectInstallMethod() picks:
  //   - bun-link: an ancestor `.git/config` containing gitConfigRepoMarker.
  //   - clawhub/unknown: plain directory, NOT under node_modules, doesn't
  //     end in /gbrain — falls through bun-link/bun/binary checks to the
  //     clawhub-availability probe.
  let driverDir: string;
  if (opts.gitConfigRepoMarker) {
    driverDir = join(home, 'clone', 'src');
    mkdirSync(driverDir, { recursive: true });
    const gitDir = join(home, 'clone', '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/${opts.gitConfigRepoMarker}.git\n`,
    );
  } else {
    driverDir = join(home, 'plain-dir');
    mkdirSync(driverDir, { recursive: true });
  }
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
    PATH: `${bin}:${process.env.PATH}`,
    GBRAIN_SELF_UPGRADE_SOURCE: undefined,
  };
  delete env.GBRAIN_SELF_UPGRADE_SOURCE;

  const proc = Bun.spawn([REAL_BUN, 'run', driverPath], {
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const readLog = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean) : []);
  return {
    home,
    exitCode,
    stdout,
    stderr,
    gitLog: readLog(gitLogPath),
    bunLog: readLog(bunLogPath),
    clawhubLog: readLog(clawhubLogPath),
  };
}

describe('runUpgrade — clawhub lane honors the configured source', () => {
  test('unpinned source → ordinary `clawhub update gbrain` (unchanged upstream default)', async () => {
    const r = await runUpgradeLane({ clawhubAvailable: true });
    try {
      expect(r.exitCode).toBe(0);
      // `detectInstallMethod` unconditionally probes `clawhub --version`
      // first (harmless availability check); the actual upgrade ACTION is
      // the `update gbrain` invocation that follows it.
      expect(r.clawhubLog).toEqual(['--version', 'update gbrain']);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  test('pinned source → refuses; clawhub is NEVER asked to update; points at the pinned Bun target', async () => {
    const r = await runUpgradeLane({
      clawhubAvailable: true,
      selfUpgradeSource: 'reza-rahimi-ca/gbrain#feat/openrouter-only-install',
    });
    try {
      // Only the unavoidable detection probe ran — never the actual update.
      expect(r.clawhubLog).toEqual(['--version']);
      expect(r.clawhubLog).not.toContain('update gbrain');
      expect(r.stderr).toContain('ClawHub cannot install from a specific fork/branch');
      expect(r.stderr).toContain('bun add -g github:reza-rahimi-ca/gbrain#feat/openrouter-only-install');
      expect(r.exitCode).toBe(1);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  test('malformed source → fails closed before any clawhub update invocation', async () => {
    const r = await runUpgradeLane({ clawhubAvailable: true, selfUpgradeSource: 'https://not/owner/repo' });
    try {
      expect(r.clawhubLog).toEqual(['--version']);
      expect(r.clawhubLog).not.toContain('update gbrain');
      expect(r.stderr).toContain('Self-upgrade source is invalid');
      expect(r.exitCode).toBe(1);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });
});

describe('runUpgrade — unknown-method lane honors the configured source', () => {
  test('unpinned source → generic hints (unchanged), exit 0', async () => {
    const r = await runUpgradeLane({ clawhubAvailable: false });
    try {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('bun update gbrain');
      expect(r.stdout).not.toContain('reza-rahimi-ca');
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  test('pinned source → recommends the pinned Bun target, never upstream, exit 1', async () => {
    const r = await runUpgradeLane({
      clawhubAvailable: false,
      selfUpgradeSource: 'reza-rahimi-ca/gbrain#feat/openrouter-only-install',
    });
    try {
      expect(r.stdout).toContain('bun add -g github:reza-rahimi-ca/gbrain#feat/openrouter-only-install');
      expect(r.stdout).not.toContain('bun update gbrain');
      expect(r.exitCode).toBe(1);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  test('malformed source → invalid_source message, exit 1', async () => {
    const r = await runUpgradeLane({ clawhubAvailable: false, selfUpgradeSource: 'a/b/c' });
    try {
      expect(r.stderr).toContain('Self-upgrade source is invalid');
      expect(r.exitCode).toBe(1);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });
});

describe('runUpgrade — bun-link lane is source-aware and validates the checked-out ref', () => {
  test('unpinned source, clone of upstream, ANY branch → pulls (unchanged: no ref check when unpinned)', async () => {
    const r = await runUpgradeLane({ gitConfigRepoMarker: 'garrytan/gbrain', gitBranch: 'some-local-feature-branch' });
    try {
      expect(r.exitCode).toBe(0);
      expect(r.gitLog).toContain('pull --ff-only');
      expect(r.bunLog).toContain('install');
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  test('pinned source, clone of the PINNED fork, checked out on the PINNED ref → pulls successfully', async () => {
    const r = await runUpgradeLane({
      gitConfigRepoMarker: 'reza-rahimi-ca/gbrain',
      gitBranch: 'feat/openrouter-only-install',
      selfUpgradeSource: 'reza-rahimi-ca/gbrain#feat/openrouter-only-install',
    });
    try {
      expect(r.exitCode).toBe(0);
      expect(r.gitLog).toContain('pull --ff-only');
      expect(r.bunLog).toContain('install');
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  test('pinned source, clone checked out on a DIFFERENT branch than the pin → refuses to pull, exit 1', async () => {
    const r = await runUpgradeLane({
      gitConfigRepoMarker: 'reza-rahimi-ca/gbrain',
      gitBranch: 'some-other-branch',
      selfUpgradeSource: 'reza-rahimi-ca/gbrain#feat/openrouter-only-install',
    });
    try {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('checked out on');
      expect(r.stderr).toContain('some-other-branch');
      // Refused BEFORE the pull — only the (harmless) rev-parse call ran.
      expect(r.gitLog).toEqual([]);
      expect(r.bunLog).toEqual([]);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  test('malformed source, clone matches upstream (detection fallback) → fails closed before any git operation', async () => {
    const r = await runUpgradeLane({
      gitConfigRepoMarker: 'garrytan/gbrain',
      selfUpgradeSource: 'not-a-valid-pin-shape',
    });
    try {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('Self-upgrade source is invalid');
      expect(r.gitLog).toEqual([]);
      expect(r.bunLog).toEqual([]);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });
});
