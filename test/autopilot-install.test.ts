/**
 * Tests for env-aware `gbrain autopilot --install`.
 *
 * Covers:
 *   - detectInstallTarget picks the right target based on env vars +
 *     filesystem sentinels.
 *   - --target flag overrides detection.
 *   - Ephemeral-container path writes the start script + executable bit.
 *   - OpenClaw bootstrap injection is idempotent + creates .bak.
 *   - Uninstall mirrors all four targets and is a no-op when nothing is
 *     installed.
 *
 * Regression guards:
 *   - macOS launchd plist still writes the same shape it always did.
 *   - Linux crontab still writes the same every-5-min line.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve, sep } from 'path';
import { tmpdir, homedir } from 'os';

import {
  detectInstallTarget,
  systemdUserSessionAvailable,
  writeWrapperScript,
  chatBootWarning,
  AUTOPILOT_SYSTEMD_UNIT,
} from '../src/commands/autopilot.ts';
import { gbrainPath } from '../src/core/config.ts';

let tmp: string;
const envSnapshot: Record<string, string | undefined> = {};

function envKeys() {
  return ['HOME', 'GBRAIN_HOME', 'RENDER', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME', 'OPENCLAW_HOME'] as const;
}

/**
 * Fail-fast safety guard for this destructive test file. The incident this
 * guards against: this suite used to `delete process.env.GBRAIN_HOME` in
 * beforeEach and rely on the `process.env.HOME = tmp` mutation above it to
 * redirect config.ts's `configDir()` fallback (`homedir()`). Under bun, an
 * in-process mutation of `process.env.HOME` is NOT reliably observed by
 * `os.homedir()` later in the same process — so any test that forgot to set
 * GBRAIN_HOME explicitly (and several here did) silently fell through to the
 * REAL user's home directory, and writeWrapperScript then wrote
 * autopilot-run.sh / the env file / permission-checked files into the real
 * ~/.gbrain.
 *
 * Deliberately a pure function over plain strings (no env/fs access) so it
 * can be exercised with injected inputs in the regression tests below,
 * independent of whatever this machine's real HOME happens to be.
 */
export function assertSafeTestGbrainHome(
  gbrainHome: string | undefined,
  opts: { tempRoot?: string; realHome?: string } = {},
): void {
  if (!gbrainHome || !gbrainHome.trim()) {
    throw new Error(
      'safety guard: GBRAIN_HOME is not set. Every test in this file must set ' +
        'GBRAIN_HOME to its own scratch temp dir before writeWrapperScript or any ' +
        'install helper can run — falling back to $HOME/os.homedir() risks writing ' +
        'into the real user install.',
    );
  }
  const candidate = resolve(gbrainHome.trim());
  const tempRoot = resolve(opts.tempRoot ?? tmpdir());
  const withinTemp = candidate === tempRoot || candidate.startsWith(tempRoot + sep);
  if (!withinTemp) {
    throw new Error(
      `safety guard: GBRAIN_HOME ("${candidate}") is not contained under the platform ` +
        `temp root ("${tempRoot}"). Refusing to run a destructive autopilot-install ` +
        'test outside a scratch temp dir.',
    );
  }
  const realHome = resolve(opts.realHome ?? homedir());
  if (candidate === realHome || candidate.startsWith(realHome + sep)) {
    throw new Error(
      `safety guard: GBRAIN_HOME ("${candidate}") resolves inside the real user home ` +
        `directory ("${realHome}"). Refusing to run.`,
    );
  }
}

beforeEach(() => {
  for (const k of envKeys()) envSnapshot[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-install-test-'));
  process.env.HOME = tmp;
  // Explicitly scope GBRAIN_HOME to this test's fresh temp root BEFORE any
  // test body can call writeWrapperScript / an install helper. Do NOT delete
  // GBRAIN_HOME and rely on the HOME mutation above to redirect the fallback
  // — see assertSafeTestGbrainHome's doc comment for why that is unsafe.
  process.env.GBRAIN_HOME = tmp;
  assertSafeTestGbrainHome(process.env.GBRAIN_HOME);
  // Start each test with a clean slate for the other ephemeral env vars.
  delete process.env.RENDER;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.FLY_APP_NAME;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  for (const k of envKeys()) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function makeFakeGbrainOnPath(): { binDir: string; restore: () => void } {
  // writeWrapperScript() calls resolveGbrainCliPath(), which shells out to
  // `which gbrain`. Put a harmless shim on PATH so the test is deterministic
  // regardless of whether the CI/dev machine has a real gbrain on PATH.
  const binDir = mkdtempSync(join(tmpdir(), 'gbrain-fake-bin-'));
  writeFileSync(join(binDir, 'gbrain'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  return {
    binDir,
    restore: () => {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

describe('detectInstallTarget', () => {
  test('returns "macos" on darwin regardless of env', () => {
    if (process.platform !== 'darwin') return; // Skip on non-mac CI
    // Even if RENDER is set, darwin wins (user is probably dev-testing).
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('macos');
  });

  test('returns "ephemeral-container" when RENDER is set', () => {
    if (process.platform === 'darwin') return; // darwin shortcircuits first
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when RAILWAY_ENVIRONMENT is set', () => {
    if (process.platform === 'darwin') return;
    process.env.RAILWAY_ENVIRONMENT = 'production';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when FLY_APP_NAME is set', () => {
    if (process.platform === 'darwin') return;
    process.env.FLY_APP_NAME = 'myapp';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  // linux-systemd / linux-cron are also exercised against a real subprocess
  // by the E2E test (test/e2e/autopilot-linux-lifecycle.serial.test.ts) with
  // --target forced explicitly. The signal-injected tests below cover
  // detectInstallTarget's own AUTO-detection branch (no --target), which the
  // E2E suite cannot reach without touching the real host's systemd/loginctl.

  test('defect 6: prefers an existing systemd user unit over crontab even when is-system-running would fail', () => {
    if (process.platform === 'darwin') return; // darwin shortcircuits first
    const unitPath = join(tmp, '.config', 'systemd', 'user', AUTOPILOT_SYSTEMD_UNIT);
    const target = detectInstallTarget({
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      fileExists: (p) => p === '/run/systemd/system' || p === unitPath,
      exec: () => {
        throw new Error('systemctl --user is-system-running: exit 1 (degraded)');
      },
    });
    expect(target).toBe('linux-systemd');
  });

  test('defect 6: falls back to linux-cron only when no systemd user session is available at all', () => {
    if (process.platform === 'darwin') return;
    let execCalls = 0;
    const target = detectInstallTarget({
      env: { USER: 'tester' }, // no XDG_RUNTIME_DIR
      fileExists: (p) => p === '/run/systemd/system', // no existing unit either
      exec: (cmd) => {
        execCalls += 1;
        if (cmd.startsWith('loginctl')) return 'Linger=no\n';
        return '';
      },
    });
    expect(target).toBe('linux-cron');
    // is-system-running must never run once the session probe says unavailable.
    expect(execCalls).toBe(1);
  });

  test('defect 6: selects linux-systemd from a reachable session alone, with no existing unit and a failing exec probe', () => {
    if (process.platform === 'darwin') return;
    let execCalls = 0;
    const target = detectInstallTarget({
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      fileExists: (p) => p === '/run/systemd/system', // no unit yet
      exec: () => {
        execCalls += 1;
        throw new Error('systemctl --user is-system-running: exit 1 (degraded)');
      },
    });
    expect(target).toBe('linux-systemd');
    // XDG_RUNTIME_DIR alone confirms the session; is-system-running must never run.
    expect(execCalls).toBe(0);
  });
});

describe('systemdUserSessionAvailable (defect 6)', () => {
  test('true when XDG_RUNTIME_DIR is set, without shelling out at all', () => {
    let execCalls = 0;
    const result = systemdUserSessionAvailable({
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      exec: () => {
        execCalls += 1;
        return '';
      },
    });
    expect(result).toBe(true);
    expect(execCalls).toBe(0);
  });

  test('true when loginctl reports Linger=yes for the user, no XDG_RUNTIME_DIR', () => {
    const result = systemdUserSessionAvailable({
      env: { USER: 'tester' },
      exec: (cmd) => {
        expect(cmd).toContain("loginctl show-user 'tester' -p Linger");
        return 'Linger=yes\n';
      },
    });
    expect(result).toBe(true);
  });

  test('false when loginctl reports Linger=no', () => {
    const result = systemdUserSessionAvailable({
      env: { USER: 'tester' },
      exec: () => 'Linger=no\n',
    });
    expect(result).toBe(false);
  });

  test('false when there is no USER/LOGNAME to probe and no XDG_RUNTIME_DIR', () => {
    const result = systemdUserSessionAvailable({ env: {} });
    expect(result).toBe(false);
  });

  test('false when the loginctl probe throws (no bus / binary missing)', () => {
    const result = systemdUserSessionAvailable({
      env: { USER: 'tester' },
      exec: () => {
        throw new Error('loginctl: command not found');
      },
    });
    expect(result).toBe(false);
  });
});

// Regression coverage for the fail-fast safety guard above. Pure/injected
// string inputs only — this must never touch the real filesystem or the
// real HOME so the "resolves inside the real home directory" branch is
// actually exercisable without depending on this machine's real user home.
describe('assertSafeTestGbrainHome (safety guard for this destructive test file)', () => {
  test('throws when GBRAIN_HOME is undefined', () => {
    expect(() =>
      assertSafeTestGbrainHome(undefined, { tempRoot: '/tmp', realHome: '/home/real-user' }),
    ).toThrow(/GBRAIN_HOME is not set/);
  });

  test('throws when GBRAIN_HOME is an empty/whitespace string', () => {
    expect(() =>
      assertSafeTestGbrainHome('   ', { tempRoot: '/tmp', realHome: '/home/real-user' }),
    ).toThrow(/GBRAIN_HOME is not set/);
  });

  test('throws when GBRAIN_HOME is outside the temp root entirely', () => {
    expect(() =>
      assertSafeTestGbrainHome('/home/real-user/some-project', {
        tempRoot: '/tmp',
        realHome: '/home/other-user',
      }),
    ).toThrow(/not contained under the platform temp root/);
  });

  test('throws when GBRAIN_HOME resolves inside the real home directory, even if nested under an unrelated temp root', () => {
    expect(() =>
      assertSafeTestGbrainHome('/tmp/real-home-alias/nested', {
        tempRoot: '/tmp',
        realHome: '/tmp/real-home-alias',
      }),
    ).toThrow(/resolves inside the real user home directory/);
  });

  test('throws when GBRAIN_HOME equals the real home directory exactly (even though it is nested under the temp root)', () => {
    expect(() =>
      assertSafeTestGbrainHome('/home/real-user', { tempRoot: '/home', realHome: '/home/real-user' }),
    ).toThrow(/resolves inside the real user home directory/);
  });

  test('accepts a path safely nested under the temp root, distinct from the real home', () => {
    expect(() =>
      assertSafeTestGbrainHome('/tmp/gbrain-install-test-abc123', {
        tempRoot: '/tmp',
        realHome: '/home/real-user',
      }),
    ).not.toThrow();
  });

  test('accepts the temp root itself', () => {
    expect(() =>
      assertSafeTestGbrainHome('/tmp', { tempRoot: '/tmp', realHome: '/home/real-user' }),
    ).not.toThrow();
  });

  test('this file\'s actual beforeEach always leaves a guard-passing GBRAIN_HOME in place', () => {
    // Real (non-injected) call: proves the wiring in beforeEach above, not
    // just the pure function in isolation.
    expect(() => assertSafeTestGbrainHome(process.env.GBRAIN_HOME)).not.toThrow();
    expect(process.env.GBRAIN_HOME).toBe(tmp);
  });
});

// v0.36.1.x (cherry-pick #966): the autopilot wrapper script must source
// ~/.zshenv BEFORE ~/.zshrc. zshenv is the canonical place for env vars in
// non-interactive zsh; zshrc only fires for interactive shells, so vars
// exported in zshrc never reach the LaunchAgent subprocess. Operators who
// exported GBRAIN_DATABASE_URL or {OPENAI,ANTHROPIC}_API_KEY in zshrc and
// expected autopilot to inherit them hit silent missing-secret failures.
describe('autopilot wrapper script — env source order (v0.36.1.x #966)', () => {
  test('wrapper sources ~/.zshenv before ~/.zshrc', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');
    const zshenvIdx = src.indexOf('~/.zshenv');
    const zshrcIdx = src.indexOf('~/.zshrc');
    expect(zshenvIdx).toBeGreaterThan(0);
    expect(zshrcIdx).toBeGreaterThan(0);
    expect(zshenvIdx).toBeLessThan(zshrcIdx);
    // Both should appear inside writeWrapperScript's heredoc as `source ~/.foo`
    expect(src).toMatch(/source\s+~\/\.zshenv/);
    expect(src).toMatch(/source\s+~\/\.zshrc/);
  });
});

// v0.42.x: the wrapper must export PATH with ~/.bun/bin before exec'ing
// gbrain. The exec'd gbrain has a `#!/usr/bin/env bun` shebang, and the
// standard Debian ~/.bashrc ships a non-interactive guard
// (`case $- in *i*) ;; *) return;; esac`) that exits early when cron/launchd/
// systemd invokes bash non-interactively — so the PATH exports that
// operators put in ~/.bashrc never reach this subprocess. Without the
// explicit export the wrapper silently dies with `env: bun: No such file
// or directory`, leaves a stale lockfile, and blocks every subsequent tick
// for the 10-min stale-lock window. Regression: see a downstream agent
// fork's `cron doctor` reports — this caused a 1-week nightly-cycle outage
// on at least one operator machine before being diagnosed.
describe('autopilot wrapper script — bun PATH export (v0.42.x regression)', () => {
  test('wrapper exports ~/.bun/bin onto PATH before the exec', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');
    // The export line must appear inside the writeWrapperScript heredoc, now
    // prefixed with the runtime dir derived at install time (universal), with
    // ~/.bun/bin retained as a fallback.
    expect(src).toMatch(/export PATH=\$\{runtimePathPrefix\}"\$HOME\/\.bun\/bin:\$PATH"/);
    // The runtime dir is derived from the actually-running bun (covers Homebrew /
    // npm -g / Docker / custom BUN_INSTALL / nix), not hardcoded to ~/.bun/bin.
    expect(src).toMatch(/const runtimeDir = dirname\(process\.execPath/);
    // The export must precede the exec line, otherwise env never sees it.
    const exportIdx = src.search(/export PATH=\$\{runtimePathPrefix\}/);
    const execIdx = src.search(/exec\s+'\${safeGbrainPath}'/);
    expect(exportIdx).toBeGreaterThan(0);
    expect(execIdx).toBeGreaterThan(0);
    expect(exportIdx).toBeLessThan(execIdx);
  });
});

// Status detection must recognize the wrapper-based cron line that --install
// actually writes (…/autopilot-run.sh), not just the legacy `gbrain autopilot`
// invocation — otherwise `--status` reports installed:false on every Linux host
// that installed via the wrapper indirection.
describe('autopilot showStatus — wrapper-path detection', () => {
  test('status detects the autopilot-run.sh wrapper line', async () => {
    // The inline crontab.includes check became the pure, unit-tested
    // crontabIndicatesAutopilotInstall (a cron'd status-monitor line must not
    // read as an install). Pin the behavior through the function itself and
    // the detect path's wiring to it.
    const { crontabIndicatesAutopilotInstall } = await import('../src/commands/autopilot.ts');
    expect(crontabIndicatesAutopilotInstall("*/5 * * * * '/h/.gbrain/autopilot-run.sh' >> log 2>&1")).toBe(true);
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');
    expect(src).toMatch(/crontabIndicatesAutopilotInstall\(crontab\)/);
  });
});

// #2608: the wrapper's key channel. The old `source ~/.zshrc || source
// ~/.bashrc` chain only reached bashrc when zshrc FAILED — on machines with
// both files the bash-managed keys never loaded, every LLM phase silently
// no-op'd, and chronicle reported clean no_events runs forever. The wrapper
// now sources both rc files independently; the deterministic env channel is
// the gbrain-owned env file pinned by the suite below.
describe('autopilot wrapper script — key sourcing (#2608)', () => {
  test('wrapper sources zshrc AND bashrc independently (no || chain)', async () => {
    // PATH shim like the env-file suite below: writeWrapperScript resolves
    // the gbrain CLI path and throws on CI runners with no gbrain on PATH.
    const fakeBin = makeFakeGbrainOnPath();
    try {
      const { writeWrapperScript } = await import('../src/commands/autopilot.ts');
      const path = writeWrapperScript(join(tmp, 'fake-repo'), 'linux-cron');
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('[ -f ~/.zshrc ] && source ~/.zshrc');
      expect(text).toContain('[ -f ~/.bashrc ] && source ~/.bashrc');
      expect(text).not.toContain('|| source ~/.bashrc');
    } finally {
      fakeBin.restore();
    }
  });
});

// #2608: the wrapper's ONLY env channel was the shell rc files (zshenv,
// zshrc, bashrc). Non-interactive daemon shells (launchd/systemd/cron) never
// run zshrc-only exports, and the stock Debian ~/.bashrc non-interactive
// guard blocks even the .bashrc fallback — a common config, not a rare one.
// The fix is additive: the wrapper now ALSO sources a gbrain-owned env file
// (same resolved gbrain home the daemon itself uses, so it honors
// GBRAIN_HOME) after the profiles, and silently no-ops when that file is
// absent.
describe('autopilot wrapper script — gbrain-owned env file (#2608)', () => {
  test('wrapper additively sources <gbrainDir>/env after the rc-file profiles, before PATH export/exec', () => {
    const fakeBin = makeFakeGbrainOnPath();
    try {
      const repoDir = join(tmp, 'repo');
      mkdirSync(repoDir, { recursive: true });
      const wrapperPath = writeWrapperScript(repoDir, 'linux-cron');
      const src = readFileSync(wrapperPath, 'utf8');

      // Ground truth: ask the SAME resolver the production code uses for the
      // gbrain-owned home, rather than hand-assuming ~/.gbrain — this is what
      // makes the assertion honor a GBRAIN_HOME override too.
      const envFilePath = gbrainPath('env');
      // set -a wrap: plain KEY=value lines (no `export`) must reach the
      // exec'd daemon too — bare `source` leaves them unexported.
      expect(src).toContain(`[ -f '${envFilePath}' ] && { set -a; source '${envFilePath}' 2>/dev/null; set +a; }`);

      // Existing rc-file sourcing is UNCHANGED (additive fix, not a
      // replacement) and still runs in the same order: zshenv, then
      // zshrc||bashrc.
      const zshenvIdx = src.indexOf('~/.zshenv');
      const zshrcIdx = src.indexOf('~/.zshrc');
      const bashrcIdx = src.indexOf('~/.bashrc');
      expect(zshenvIdx).toBeGreaterThan(-1);
      expect(zshrcIdx).toBeGreaterThan(zshenvIdx);
      expect(bashrcIdx).toBeGreaterThan(zshrcIdx);

      // New sourcing line runs AFTER the profiles (so it wins on conflicts)
      // and BEFORE the PATH export / exec (so the daemon actually sees it).
      const envFileIdx = src.indexOf(`'${envFilePath}'`);
      const pathExportIdx = src.indexOf('export PATH=');
      const execIdx = src.indexOf("exec '");
      expect(envFileIdx).toBeGreaterThan(bashrcIdx);
      expect(envFileIdx).toBeLessThan(pathExportIdx);
      expect(pathExportIdx).toBeGreaterThan(-1);
      expect(pathExportIdx).toBeLessThan(execIdx);
    } finally {
      fakeBin.restore();
    }
  });

  test('honors GBRAIN_HOME: sources <GBRAIN_HOME>/.gbrain/env, not a hardcoded ~/.gbrain', () => {
    const fakeBin = makeFakeGbrainOnPath();
    const customHome = mkdtempSync(join(tmpdir(), 'gbrain-custom-home-'));
    const originalGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = customHome;
    try {
      const repoDir = join(tmp, 'repo-custom');
      mkdirSync(repoDir, { recursive: true });
      const wrapperPath = writeWrapperScript(repoDir, 'linux-cron');
      const src = readFileSync(wrapperPath, 'utf8');
      const expectedEnvFile = join(customHome, '.gbrain', 'env');
      expect(src).toContain(`[ -f '${expectedEnvFile}' ] && { set -a; source '${expectedEnvFile}' 2>/dev/null; set +a; }`);
      // Must NOT fall back to a bare ~/.gbrain/env guess that ignores GBRAIN_HOME.
      expect(src).not.toContain(`[ -f '${join(tmp, '.gbrain', 'env')}'`);
    } finally {
      if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = originalGbrainHome;
      rmSync(customHome, { recursive: true, force: true });
      fakeBin.restore();
    }
  });

  test('behavior: real bash actually sets the var when the file is present, and no-ops (exit 0, var unset) when absent', () => {
    const fakeBin = makeFakeGbrainOnPath();
    try {
      const repoDir = join(tmp, 'repo-behavior');
      mkdirSync(repoDir, { recursive: true });
      const wrapperPath = writeWrapperScript(repoDir, 'linux-cron');
      const fullSrc = readFileSync(wrapperPath, 'utf8');

      // Execute the REAL generated sourcing preamble (everything up to, but
      // excluding, the final `exec '<gbrain>' autopilot ...` line) so this
      // proves runtime behavior of the actual generated code, not a
      // hand-duplicated copy of it — without launching autopilot for real.
      const execIdx = fullSrc.indexOf("exec '");
      expect(execIdx).toBeGreaterThan(-1);
      const preamble = fullSrc.slice(0, execIdx);

      const envFilePath = gbrainPath('env');
      const runPreamble = () => spawnSync('bash', ['-c', `${preamble}\necho "MARKER=[$GBRAIN_TEST_MARKER_2608]"`], {
        env: { HOME: tmp, PATH: process.env.PATH || '' },
        encoding: 'utf8',
        timeout: 15_000,
      });

      // Absent case: no ~/.gbrain/env yet. Must be a clean no-op — exit 0,
      // marker stays unset (not an error, not a partial/garbled sourcing).
      rmSync(envFilePath, { force: true });
      const absent = runPreamble();
      expect(absent.status).toBe(0);
      expect(absent.stdout).toContain('MARKER=[]');
      expect(absent.stderr).toBe('');

      // Present case: write the gbrain-owned env file with a marker export.
      mkdirSync(gbrainPath(), { recursive: true });
      writeFileSync(envFilePath, 'export GBRAIN_TEST_MARKER_2608=from-envfile\n');
      const present = runPreamble();
      expect(present.status).toBe(0);
      expect(present.stdout).toContain('MARKER=[from-envfile]');

      // Dotenv-style case: a plain KEY=value line (no `export`) must ALSO
      // reach the exec'd daemon — the #2608 reporter's env file is exactly
      // this shape. Only the set -a wrap makes the assignment exported.
      writeFileSync(envFilePath, 'GBRAIN_TEST_MARKER_2608=dotenv-style\n');
      const dotenv = runPreamble();
      expect(dotenv.status).toBe(0);
      expect(dotenv.stdout).toContain('MARKER=[dotenv-style]');
    } finally {
      fakeBin.restore();
    }
  });

  // #2608 hardening: --install writes a fully-commented 0600 template at
  // <gbrainDir>/env so the boot warning points at a file that exists, with
  // secret-safe perms from birth. GBRAIN_HOME (not HOME) scopes these tests:
  // config's homedir() fallback ignores runtime HOME mutation under bun, but
  // GBRAIN_HOME is read at call time — proven by the test above.
  test('install creates a 0600 fully-commented env template (no GBRAIN_HOME example), never overwrites', () => {
    const fakeBin = makeFakeGbrainOnPath();
    const customHome = mkdtempSync(join(tmpdir(), 'gbrain-tpl-home-'));
    const originalGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = customHome;
    try {
      const repoDir = join(tmp, 'repo-template');
      mkdirSync(repoDir, { recursive: true });
      writeWrapperScript(repoDir, 'linux-cron');

      const envFile = join(customHome, '.gbrain', 'env');
      expect(existsSync(envFile)).toBe(true);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);

      const body = readFileSync(envFile, 'utf8');
      // Every non-empty line is a comment: the install must never ship a
      // live secret or a live assignment.
      for (const line of body.split('\n')) {
        if (line.trim() === '') continue;
        expect(line.startsWith('#')).toBe(true);
      }
      // Names the key lanes and the process-level vars that justify the file.
      expect(body).toContain('ANTHROPIC_API_KEY');
      expect(body).toContain('NODE_EXTRA_CA_CERTS');
      // GBRAIN_HOME must NOT be offered as an example: the wrapper bakes it
      // AFTER sourcing this file, so a value here is clobbered/divergent.
      expect(body).toContain('Do NOT set GBRAIN_HOME here');
      expect(body).not.toMatch(/^#?\s*export GBRAIN_HOME=/m);

      // Reinstall must never overwrite a user's existing env file.
      writeFileSync(envFile, '# user-owned sentinel\nexport USER_KEY=real\n', { mode: 0o600 });
      writeWrapperScript(repoDir, 'linux-cron');
      expect(readFileSync(envFile, 'utf8')).toContain('user-owned sentinel');
    } finally {
      if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = originalGbrainHome;
      rmSync(customHome, { recursive: true, force: true });
      fakeBin.restore();
    }
  });

  test('install warns on a loose-permission pre-existing env file but never chmods it', () => {
    const fakeBin = makeFakeGbrainOnPath();
    const customHome = mkdtempSync(join(tmpdir(), 'gbrain-perm-home-'));
    const originalGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = customHome;
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const repoDir = join(tmp, 'repo-perms');
      mkdirSync(repoDir, { recursive: true });
      const gbrainDir = join(customHome, '.gbrain');
      mkdirSync(gbrainDir, { recursive: true });
      const envFile = join(gbrainDir, 'env');
      writeFileSync(envFile, 'export USER_KEY=real\n', { mode: 0o644 });

      writeWrapperScript(repoDir, 'linux-cron');

      // File untouched: content AND mode are the user's business.
      expect(readFileSync(envFile, 'utf8')).toContain('USER_KEY=real');
      expect(statSync(envFile).mode & 0o777).toBe(0o644);
      const warned = errSpy.mock.calls.some((c) => String(c[0]).includes('group/world-readable'));
      expect(warned).toBe(true);
    } finally {
      errSpy.mockRestore();
      if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = originalGbrainHome;
      rmSync(customHome, { recursive: true, force: true });
      fakeBin.restore();
    }
  });
});

// #2608: chronicle/dream/enrich gate on isAvailable('chat') and silently
// return empty results when it's false — an ordinary-looking success that
// gives the operator zero signal that the daemon has no LLM credentials.
describe('chatBootWarning (#2608)', () => {
  test('returns null when a chat provider is available', () => {
    expect(chatBootWarning(true, '/custom/.gbrain')).toBeNull();
  });

  test('returns a warning naming the failure mode and the fix when unavailable', () => {
    const warn = chatBootWarning(false, '/custom/.gbrain');
    expect(warn).not.toBeNull();
    expect(warn).toContain('[autopilot]');
    expect(warn).toMatch(/no chat provider/i);
    // Names both remediation paths so the operator isn't left guessing —
    // derived from the passed gbrain dir, never a literal ~/.gbrain guess
    // that lies on GBRAIN_HOME installs.
    expect(warn).toContain('/custom/.gbrain/env');
    expect(warn).toContain('/custom/.gbrain/config.json');
    expect(warn).not.toContain('~/.gbrain');
    // `gbrain config set` is banned for API keys by the canonical install
    // docs — the warning must not teach it.
    expect(warn).not.toContain('config set');
    // Load-bearing: the wrapper sources the env file only at exec and the
    // gateway folds env once pre-dispatch — without a reload nothing changes.
    expect(warn).toContain('gbrain autopilot --install');
  });
});

describe('autopilot wiring: chat-unavailable boot warning (#2608)', () => {
  test('runAutopilot checks isAvailable("chat") and logs chatBootWarning before the daemon loop starts', async () => {
    // Same source-shape regression style as the nightly-probe / parser-probe
    // wiring tests in this suite: runAutopilot's daemon loop runs forever and
    // spawns a real engine + worker supervisor, so it isn't practical to
    // drive end-to-end in a unit test. Pin the wiring instead — the warning
    // logic itself is covered by the direct chatBootWarning() tests above.
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');

    const startingIdx = src.indexOf('Autopilot starting. Repo:');
    const chatCheckIdx = src.indexOf(`isAvailable('chat')`);
    const loopModeIdx = src.indexOf('Mode resolution: Minions dispatch');
    expect(startingIdx).toBeGreaterThan(-1);
    expect(chatCheckIdx).toBeGreaterThan(startingIdx);
    expect(loopModeIdx).toBeGreaterThan(chatCheckIdx);

    expect(src).toContain('chatBootWarning(isAvailable(');
    // console.log, NOT console.error: launchd/systemd route stderr to
    // autopilot.err, which install output and showStatus never reference —
    // stdout is the autopilot.log sink on all four install targets.
    expect(src).toMatch(/if \(warn\) console\.log\(warn\)/);
    // Diagnostic-only: a gateway import failure must never block the loop.
    expect(src).toMatch(/diagnostic only — never blocks the loop/);
  });
});

// #2608 hardening: the boot warning tells users to re-run --install to
// reload the daemon — these pins keep that instruction TRUE. Source-shape
// style (same rationale as the wiring test above): the install functions
// shell out to launchctl/systemctl/crontab, which a unit test cannot drive.
describe('autopilot install — reload-safety (#2608)', () => {
  test('launchd unloads before load, systemd try-restarts, cron/container explain the residual process', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');

    // installLaunchd: bare `launchctl load` on an already-loaded agent errors
    // (aborting reinstall) and never relaunches the running daemon. The
    // unload must precede the load INSIDE installLaunchd — anchor on the
    // function body, not the file-wide first occurrence (uninstall also
    // unloads, much later in the file).
    const launchdFnIdx = src.indexOf('function installLaunchd(');
    expect(launchdFnIdx).toBeGreaterThan(-1);
    const launchdBody = src.slice(launchdFnIdx, src.indexOf('function generateSystemdUnit'));
    // Anchor on the execSync calls, not bare command names — the explanatory
    // comment above the unload also says "launchctl load".
    const unloadIdx = launchdBody.indexOf('execSync(`launchctl unload');
    const loadIdx = launchdBody.indexOf('execSync(`launchctl load');
    expect(unloadIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(-1);
    expect(unloadIdx).toBeLessThan(loadIdx);

    // installSystemd: enable --now does not restart an active unit; only
    // try-restart bounces a running daemon onto the regenerated wrapper.
    const systemdFnIdx = src.indexOf('function installSystemd(');
    expect(systemdFnIdx).toBeGreaterThan(-1);
    const systemdBody = src.slice(systemdFnIdx, src.indexOf('function installEphemeralContainer'));
    const enableIdx = systemdBody.indexOf('enable --now');
    const tryRestartIdx = systemdBody.indexOf('try-restart');
    expect(enableIdx).toBeGreaterThan(-1);
    expect(tryRestartIdx).toBeGreaterThan(enableIdx);

    // cron + container cannot reload a running loop — install must say so
    // (and how to end it) rather than silently pretending the reinstall
    // took effect.
    expect(src).toMatch(/keeps its old environment until it exits/);
    expect(src).toMatch(/keeps its old environment until the container/);
  });
});
