/**
 * Item 9 (fork-pin): check-only/notify (`fetchLatestRelease` / `fetchChangelog`
 * in src/commands/check-update.ts) must resolve the configured
 * `self_upgrade.source`, and a malformed/unsupported source must fail closed
 * BEFORE any network call — never silently fall back to checking/fetching
 * upstream `garrytan/gbrain`.
 *
 * Quarantined as *.serial.test.ts: reassigns the process-global `fetch` and
 * mutates GBRAIN_HOME (cross-file-unsafe under the parallel runner).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchChangelog,
  fetchLatestRelease,
  refreshUpdateCache,
  runCheckUpdate,
  upgradeCommandForMethod,
} from '../src/commands/check-update.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { readUpdateCache, updateCachePath, writeUpdateCache } from '../src/core/self-upgrade.ts';
import { VERSION } from '../src/version.ts';
import {
  parseSelfUpgradeSourcePin,
  type SelfUpgradeSourceResult,
} from '../src/core/self-upgrade-source.ts';

const PIN = 'reza-rahimi-ca/gbrain#feat/openrouter-only-install';

const realFetch = globalThis.fetch;
let homeDir: string;
let priorHome: string | undefined;
let priorEnvOverride: string | undefined;

function writeSourceConfig(source: string): void {
  mkdirSync(join(homeDir, '.gbrain'), { recursive: true });
  writeFileSync(join(homeDir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', self_upgrade: { source } }));
}

function stubFetchCapturingUrls(status = 200, body = '9.9.9.0\n'): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url));
    return new Response(body, { status });
  }) as typeof fetch;
  return urls;
}

beforeEach(() => {
  priorHome = process.env.GBRAIN_HOME;
  priorEnvOverride = process.env.GBRAIN_SELF_UPGRADE_SOURCE;
  delete process.env.GBRAIN_SELF_UPGRADE_SOURCE;
  homeDir = mkdtempSync(join(tmpdir(), 'gbrain-checkupdate-pin-'));
  process.env.GBRAIN_HOME = homeDir;
  _resetCliExitVerdictForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  if (priorEnvOverride === undefined) delete process.env.GBRAIN_SELF_UPGRADE_SOURCE;
  else process.env.GBRAIN_SELF_UPGRADE_SOURCE = priorEnvOverride;
  rmSync(homeDir, { recursive: true, force: true });
  // setCliExitVerdict mirrors into process.exitCode directly — reset so this
  // file's assertions don't leak a nonzero exit into the shared test runner.
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('fetchLatestRelease — resolves the configured source', () => {
  test('no config → upstream VERSION URL (unchanged default behavior)', async () => {
    const urls = stubFetchCapturingUrls();
    const res = await fetchLatestRelease();
    expect(res).toMatchObject({ ok: true, tag: '9.9.9.0' });
    expect(urls).toEqual(['https://raw.githubusercontent.com/garrytan/gbrain/master/VERSION']);
  });

  test('pinned config → VERSION URL + release_url resolve against the pinned owner/repo/ref', async () => {
    writeSourceConfig(PIN);
    const urls = stubFetchCapturingUrls();
    const res = await fetchLatestRelease();
    expect(res).toMatchObject({ ok: true, tag: '9.9.9.0' });
    if (res.ok) {
      expect(res.url).toBe(
        'https://github.com/reza-rahimi-ca/gbrain/blob/feat/openrouter-only-install/CHANGELOG.md',
      );
    }
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/reza-rahimi-ca/gbrain/feat/openrouter-only-install/VERSION',
    ]);
    for (const url of urls) expect(url).not.toContain('garrytan');
  });

  test('env override wins over file-plane config', async () => {
    writeSourceConfig('unrelated/other#main');
    process.env.GBRAIN_SELF_UPGRADE_SOURCE = PIN;
    const urls = stubFetchCapturingUrls();
    await fetchLatestRelease();
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/reza-rahimi-ca/gbrain/feat/openrouter-only-install/VERSION',
    ]);
  });

  test('malformed self_upgrade.source → invalid_source, fetch NEVER called (fail closed, no upstream fallback)', async () => {
    writeSourceConfig('not-a-valid-pin-shape');
    let called = false;
    globalThis.fetch = (async (_url: any) => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const res = await fetchLatestRelease();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('invalid_source');
      expect(typeof res.error).toBe('string');
    }
    expect(called).toBe(false);
  });

  test('URL-shaped self_upgrade.source (git remote, not owner/repo) → invalid_source', async () => {
    writeSourceConfig('https://github.com/garrytan/gbrain');
    const res = await fetchLatestRelease();
    expect(res).toMatchObject({ ok: false, reason: 'invalid_source' });
  });
});

describe('fetchChangelog — resolves the configured source', () => {
  test('pinned config → raw CHANGELOG.md URL resolves against the pinned owner/repo/ref', async () => {
    writeSourceConfig(PIN);
    const urls = stubFetchCapturingUrls(200, '## [9.9.9.0] - 2026-01-01\n- fake entry\n');
    await fetchChangelog('0.1.0.0', '9.9.9.0');
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/reza-rahimi-ca/gbrain/feat/openrouter-only-install/CHANGELOG.md',
    ]);
  });

  test('malformed self_upgrade.source → returns "" without ever fetching', async () => {
    writeSourceConfig('a/b/c');
    let called = false;
    globalThis.fetch = (async (_url: any) => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const diff = await fetchChangelog('0.1.0.0', '9.9.9.0');
    expect(diff).toBe('');
    expect(called).toBe(false);
  });
});

describe('runCheckUpdate — invalid source sets a nonzero CLI verdict (item 9 correction: gap #2)', () => {
  function captureLog(): string[] {
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    return lines;
  }
  const realLog = console.log;

  afterEach(() => {
    console.log = realLog;
  });

  test('--json: invalid_source sets process.exitCode = 1 and emits NO actionable upgrade_command', async () => {
    writeSourceConfig('not-a-valid-pin-shape');
    stubFetchCapturingUrls();
    const lines = captureLog();
    await runCheckUpdate(['--json']);
    const out = JSON.parse(lines.join('\n'));
    expect(out.error).toBe('invalid_source');
    expect(out.upgrade_command).toBe('');
    expect(process.exitCode).toBe(1);
  });

  test('non-json: invalid_source ALSO sets process.exitCode = 1 (not just the --json branch)', async () => {
    writeSourceConfig('https://not/owner/repo');
    stubFetchCapturingUrls();
    const lines = captureLog();
    await runCheckUpdate([]);
    expect(lines.join('\n')).toContain('self_upgrade.source is invalid');
    expect(process.exitCode).toBe(1);
  });

  test('network_error / no_releases stay exit 0 (unchanged: check-update fails silently on network errors by design)', async () => {
    // No source configured — an ordinary network failure, not a config error.
    globalThis.fetch = (async (_url: any): Promise<Response> => {
      throw new Error('offline');
    }) as typeof fetch;
    const lines = captureLog();
    await runCheckUpdate(['--json']);
    const out = JSON.parse(lines.join('\n'));
    expect(out.error).toBe('network_error');
    expect(process.exitCode).toBe(0);
  });
});

describe('runCheckUpdate — a genuinely corrupt (unparseable) EXISTING config file fails closed end-to-end (independent acceptance review, item 9 correction: gap #3)', () => {
  function captureLog(): string[] {
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    return lines;
  }
  const realLog = console.log;
  afterEach(() => {
    console.log = realLog;
  });

  function writeCorruptConfig(): void {
    mkdirSync(join(homeDir, '.gbrain'), { recursive: true });
    // Not the "malformed pin string inside valid JSON" case covered above —
    // this is the file itself failing to parse as JSON at all, so the
    // intended pin (if any) is genuinely unknowable.
    writeFileSync(join(homeDir, '.gbrain', 'config.json'), '{ this is not valid json');
  }

  test('--json: corrupt config file → invalid_source, exit 1, fetch NEVER called (never silently checks upstream)', async () => {
    writeCorruptConfig();
    let fetchCalled = false;
    globalThis.fetch = (async (_url: any) => {
      fetchCalled = true;
      return new Response('9.9.9.0\n', { status: 200 });
    }) as typeof fetch;
    const lines = captureLog();
    await runCheckUpdate(['--json']);
    const out = JSON.parse(lines.join('\n'));
    expect(out.error).toBe('invalid_source');
    expect(out.upgrade_command).toBe('');
    expect(process.exitCode).toBe(1);
    expect(fetchCalled).toBe(false);
  });

  test('non-json: corrupt config file → actionable error, never "up to date", never installs/fetches anything', async () => {
    writeCorruptConfig();
    let fetchCalled = false;
    globalThis.fetch = (async (_url: any) => {
      fetchCalled = true;
      return new Response('9.9.9.0\n', { status: 200 });
    }) as typeof fetch;
    const lines = captureLog();
    await runCheckUpdate([]);
    const out = lines.join('\n');
    expect(out).toContain('self_upgrade.source is invalid');
    expect(out).not.toContain('up to date');
    expect(process.exitCode).toBe(1);
    expect(fetchCalled).toBe(false);
  });

  test('fetchLatestRelease directly: corrupt config file resolves invalid_source before any network call', async () => {
    writeCorruptConfig();
    let fetchCalled = false;
    globalThis.fetch = (async (_url: any) => {
      fetchCalled = true;
      return new Response('9.9.9.0\n', { status: 200 });
    }) as typeof fetch;
    const res = await fetchLatestRelease();
    expect(res).toMatchObject({ ok: false, reason: 'invalid_source' });
    expect(fetchCalled).toBe(false);
  });
});

describe('update-cache marker source binding (item 9 correction: gap #3)', () => {
  test('refreshUpdateCache: unpinned source writes the exact LEGACY marker shape (no source token)', async () => {
    stubFetchCapturingUrls(200, '9.9.9.0\n');
    await refreshUpdateCache();
    const raw = readFileSync(updateCachePath(), 'utf8').trim();
    expect(raw).toBe(`UPGRADE_AVAILABLE ${VERSION} 9.9.9.0`);
    // No 4th token at all — exactly 3 space-separated fields.
    expect(raw.split(/\s+/).length).toBe(3);
  });

  test('refreshUpdateCache: pinned source stamps the marker with the source identity token', async () => {
    writeSourceConfig(PIN);
    stubFetchCapturingUrls(200, '9.9.9.0\n');
    await refreshUpdateCache();
    const raw = readFileSync(updateCachePath(), 'utf8').trim();
    const parts = raw.split(/\s+/);
    expect(parts[0]).toBe('UPGRADE_AVAILABLE');
    expect(parts.length).toBe(4);
    expect(parts[3]).toBe('reza-rahimi-ca/gbrain#feat/openrouter-only-install');
    const entry = readUpdateCache();
    expect(entry?.marker.source).toBe('reza-rahimi-ca/gbrain#feat/openrouter-only-install');
  });

  test('refreshUpdateCache: a refresh FAILURE does not preserve/refresh a marker written for a DIFFERENT source', async () => {
    // Prior marker written while pinned to the fork...
    writeSourceConfig(PIN);
    writeUpdateCache({ kind: 'upgrade_available', current: '0.1.0.0', latest: '9.9.9.0', source: 'reza-rahimi-ca/gbrain#feat/openrouter-only-install' });
    const before = readFileSync(updateCachePath(), 'utf8');

    // ...then the pin changes to a DIFFERENT fork, and the refresh fails (offline).
    writeSourceConfig('someone-else/gbrain#main');
    globalThis.fetch = (async (_url: any): Promise<Response> => {
      throw new Error('offline');
    }) as typeof fetch;
    await refreshUpdateCache();

    // The stale, WRONG-source marker must be left exactly as it was — not
    // re-written/re-freshened under the new (different) source's identity.
    const after = readFileSync(updateCachePath(), 'utf8');
    expect(after).toBe(before);
  });

  test('refreshUpdateCache: a refresh FAILURE DOES preserve a same-source marker (regression guard for #486)', async () => {
    writeUpdateCache({ kind: 'upgrade_available', current: '0.1.0.0', latest: '9.9.9.0' });
    globalThis.fetch = (async (_url: any): Promise<Response> => {
      throw new Error('offline');
    }) as typeof fetch;
    await refreshUpdateCache();
    const entry = readUpdateCache();
    expect(entry?.marker).toEqual({ kind: 'upgrade_available', current: '0.1.0.0', latest: '9.9.9.0' });
  });
});

describe('upgradeCommandForMethod — never advises replacing a pinned source from upstream (item 9 second correction pass, gap #1)', () => {
  const UNPINNED: SelfUpgradeSourceResult = {
    ok: true,
    pinned: false,
    source: { owner: 'garrytan', repo: 'gbrain', ref: 'master' },
  };
  const INVALID: SelfUpgradeSourceResult = { ok: false, error: 'fixture: invalid source' };

  function pinnedResult(pin: string): SelfUpgradeSourceResult {
    const parsed = parseSelfUpgradeSourcePin(pin);
    if (!parsed.ok) throw new Error('fixture pin must parse');
    return { ok: true, pinned: true, source: parsed.source };
  }
  const PINNED = pinnedResult(PIN);

  test('clawhub + unpinned → ordinary `clawhub update gbrain` (unchanged upstream default)', () => {
    expect(upgradeCommandForMethod('clawhub', UNPINNED)).toBe('clawhub update gbrain');
  });

  test('clawhub + PINNED → the pinned Bun GitHub target, NEVER `clawhub update gbrain` (the fix: ClawHub has no fork/branch concept and would silently replace from upstream)', () => {
    const cmd = upgradeCommandForMethod('clawhub', PINNED);
    expect(cmd).toBe('bun add -g github:reza-rahimi-ca/gbrain#feat/openrouter-only-install');
    expect(cmd).not.toContain('clawhub');
    expect(cmd).not.toContain('garrytan');
  });

  test('clawhub + INVALID source → null (no actionable upstream command; caller must fail closed)', () => {
    expect(upgradeCommandForMethod('clawhub', INVALID)).toBeNull();
  });

  test('bun + PINNED → the pinned Bun GitHub target (still correct after the fix)', () => {
    expect(upgradeCommandForMethod('bun', PINNED)).toBe(
      'bun add -g github:reza-rahimi-ca/gbrain#feat/openrouter-only-install',
    );
  });

  test('bun + INVALID source → null, never falls back to `bun update gbrain`', () => {
    expect(upgradeCommandForMethod('bun', INVALID)).toBeNull();
  });

  test('binary + INVALID source → null', () => {
    expect(upgradeCommandForMethod('binary', INVALID)).toBeNull();
  });

  test('binary + PINNED → `gbrain self-upgrade` (safe regardless of pinning: the binary lane resolves the SAME pin internally)', () => {
    expect(upgradeCommandForMethod('binary', PINNED)).toBe('gbrain self-upgrade');
  });

  test('unknown method + INVALID source → null', () => {
    expect(upgradeCommandForMethod('bun-link', INVALID)).toBeNull();
    expect(upgradeCommandForMethod('nonsense-method', INVALID)).toBeNull();
  });

  test('unknown/default method + PINNED → `gbrain upgrade` (safe regardless of pinning: its dispatch resolves the SAME pin per-lane)', () => {
    expect(upgradeCommandForMethod('unknown', PINNED)).toBe('gbrain upgrade');
  });
});
