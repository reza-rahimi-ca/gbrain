import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSystemdUnit } from '../src/commands/autopilot.ts';

const AUTOPILOT_SRC = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');

describe('generateSystemdUnit', () => {
  const unit = generateSystemdUnit('/home/u/.gbrain/autopilot-run.sh');

  test('uses Restart=always (NOT on-failure) so a clean exit-for-relaunch respawns', () => {
    expect(unit).toContain('Restart=always');
    expect(unit).not.toContain('Restart=on-failure');
  });
  test('caps a clean-exit respawn storm with StartLimit*', () => {
    expect(unit).toContain('StartLimitIntervalSec=');
    expect(unit).toContain('StartLimitBurst=');
  });
  test('runs the given wrapper path', () => {
    expect(unit).toContain('ExecStart=/home/u/.gbrain/autopilot-run.sh');
  });
});

describe('autopilot self-upgrade static-shape regressions', () => {
  test('supervisor-relaunch, NOT in-process re-exec (Bun has no execve) — no exec*-call', () => {
    // Match call-shape, not the word (the comments legitimately say "no execve").
    expect(AUTOPILOT_SRC).not.toMatch(/execve\s*\(/);
    expect(AUTOPILOT_SRC).not.toMatch(/execvp\s*\(/);
  });
  test('the silent channel does swap-only, never a blocking full post-upgrade in the tick', () => {
    // Self-invocation (defect 5): spawns the resolved CLI path, never a bare
    // `gbrain` string that a squatted/stale PATH entry could hijack.
    expect(AUTOPILOT_SRC).toContain("execFileSync(resolveGbrainCliPath(), ['upgrade', '--swap-only']");
    // The tick must not invoke the (up-to-30-min) post-upgrade inline.
    expect(AUTOPILOT_SRC).not.toContain("execSync('gbrain post-upgrade'");
  });
  test('boot reconciles the breadcrumb and the tick attempts the channel', () => {
    expect(AUTOPILOT_SRC).toContain('reconcileSelfUpgradeAtBoot()');
    expect(AUTOPILOT_SRC).toContain('attemptAutopilotSelfUpgrade(engine, engineType, lockPath)');
  });
  test('apply path unlinks the lock before exit so the relaunched binary does not self-exit on a stale lock', () => {
    // The exit-for-relaunch block unlinks lockPath then process.exit(0).
    expect(AUTOPILOT_SRC).toMatch(/unlinkSync\(lockPath\)[\s\S]{0,120}process\.exit\(0\)/);
  });
});

describe('autopilot self-upgrade consumes only matching-source cache (item 9 correction pass, gap #3)', () => {
  // attemptAutopilotSelfUpgrade is unexported and needs a real BrainEngine +
  // idle-computation dependency chain to invoke directly (consistent with
  // this file's existing static-shape-regression style above). The
  // underlying source-match predicate itself (`sourceTokenMatchesResolved`)
  // is already exhaustively unit-tested in test/self-upgrade-pending.test.ts
  // and test/self-upgrade-source.serial.test.ts; these pins prove autopilot
  // actually WIRES that predicate in, at the right points, rather than
  // silently trusting whatever readUpdateCache() returns.
  const fn = (() => {
    const start = AUTOPILOT_SRC.indexOf('async function attemptAutopilotSelfUpgrade');
    const end = AUTOPILOT_SRC.indexOf('\nasync function ', start + 1);
    return AUTOPILOT_SRC.slice(start, end > -1 ? end : undefined);
  })();

  test('resolves the configured source before deciding whether the cache is usable', () => {
    expect(fn).toContain('resolveConfiguredSelfUpgradeSource()');
  });

  test('the refresh-trigger condition also fires on a source mismatch, not just staleness', () => {
    // Same `if (!entry || !isCacheFresh(...) || !sourceTokenMatchesResolved(...))`
    // shape — a fresh-by-mtime cache for the WRONG source must trigger a
    // fresh refresh, exactly like a missing/stale one does.
    const refreshTrigger = fn.slice(0, fn.indexOf('refreshUpdateCache'));
    expect(refreshTrigger).toContain('!isCacheFresh(entry, Date.now())');
    expect(refreshTrigger).toContain('!sourceTokenMatchesResolved(entry.marker.source, resolvedSource)');
  });

  test('re-validates source match AFTER the refresh attempt, before reading latestVersion', () => {
    const afterRefresh = fn.slice(fn.indexOf('entry = readUpdateCache();\n      } catch'));
    const latestVersionIdx = afterRefresh.indexOf('const latestVersion = entry.marker.latest;');
    const guardSlice = afterRefresh.slice(0, latestVersionIdx);
    expect(guardSlice).toContain('sourceTokenMatchesResolved(entry.marker.source, resolveConfiguredSelfUpgradeSource())');
  });
});
