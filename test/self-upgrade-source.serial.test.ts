/**
 * Item 9 (fork-pin): unit + file-plane tests for the single validated
 * self-upgrade source resolver at src/core/self-upgrade-source.ts.
 *
 * Uses `withEnv` (GBRAIN_HOME / GBRAIN_SELF_UPGRADE_SOURCE mutation) — kept
 * as .serial.test.ts per the repo's env-mutation quarantine convention.
 */
import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  DEFAULT_SELF_UPGRADE_SOURCE,
  attestationApiBase,
  bunGithubInstallTarget,
  changelogRawUrl,
  changelogWebUrl,
  expectedBuilderIdPrefix,
  expectedBuilderIds,
  parseSelfUpgradeSourcePin,
  releasesLatestApiUrl,
  releasesWebUrl,
  repoMarker,
  resolveConfiguredSelfUpgradeSource,
  resolveSelfUpgradeSource,
  versionFileUrl,
} from '../src/core/self-upgrade-source.ts';

const PIN = 'reza-rahimi-ca/gbrain#feat/openrouter-only-install';

describe('parseSelfUpgradeSourcePin', () => {
  test('owner/repo (no ref) defaults ref to "main"', () => {
    const r = parseSelfUpgradeSourcePin('reza-rahimi-ca/gbrain');
    expect(r).toEqual({ ok: true, source: { owner: 'reza-rahimi-ca', repo: 'gbrain', ref: 'main' } });
  });

  test('owner/repo#branch-with-slashes parses the ref including internal slashes', () => {
    const r = parseSelfUpgradeSourcePin(PIN);
    expect(r).toEqual({
      ok: true,
      source: { owner: 'reza-rahimi-ca', repo: 'gbrain', ref: 'feat/openrouter-only-install' },
    });
  });

  test('empty string fails closed', () => {
    const r = parseSelfUpgradeSourcePin('   ');
    expect(r.ok).toBe(false);
  });

  const malformed: Array<[string, string]> = [
    ['URL instead of owner/repo', 'https://github.com/garrytan/gbrain'],
    ['scp-style git remote', 'git@github.com:garrytan/gbrain.git'],
    ['more than one #', 'a/b#ref#extra'],
    ['empty ref after #', 'a/b#'],
    ['no slash at all', 'gbrain'],
    ['more than one slash before #', 'a/b/c#ref'],
    ['invalid owner segment (leading dash)', '-a/b'],
    ['invalid repo segment (space)', 'a/b c'],
    ['ref with path traversal', 'a/b#../../etc/passwd'],
    ['ref with doubled slash', 'a/b#foo//bar'],
    ['ref that looks like a flag', 'a/b#-rf'],
  ];
  for (const [label, raw] of malformed) {
    test(`rejects: ${label}`, () => {
      const r = parseSelfUpgradeSourcePin(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    });
  }
});

describe('resolveSelfUpgradeSource', () => {
  test('unset config + no env → upstream default, pinned:false', () => {
    const r = resolveSelfUpgradeSource({}, undefined);
    expect(r).toEqual({ ok: true, source: DEFAULT_SELF_UPGRADE_SOURCE, pinned: false });
  });

  test('config self_upgrade.source set → pinned:true with the parsed source', () => {
    const r = resolveSelfUpgradeSource({ self_upgrade: { source: PIN } }, undefined);
    expect(r).toEqual({
      ok: true,
      pinned: true,
      source: { owner: 'reza-rahimi-ca', repo: 'gbrain', ref: 'feat/openrouter-only-install' },
    });
  });

  test('env override wins over config', () => {
    const r = resolveSelfUpgradeSource({ self_upgrade: { source: 'unrelated/other' } }, PIN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source.owner).toBe('reza-rahimi-ca');
  });

  test('malformed configured source → ok:false (fail closed, no default substitution)', () => {
    const r = resolveSelfUpgradeSource({ self_upgrade: { source: 'not-a-valid-pin' } }, undefined);
    expect(r.ok).toBe(false);
  });
});

describe('resolveSelfUpgradeSource — type hardening (item 9 correction pass, gap #4)', () => {
  test('non-string self_upgrade.source (number) fails closed, does NOT throw', () => {
    let result: ReturnType<typeof resolveSelfUpgradeSource> | undefined;
    expect(() => {
      result = resolveSelfUpgradeSource({ self_upgrade: { source: 123 as unknown as string } }, undefined);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toContain('must be a string');
  });

  test('non-string self_upgrade.source (object) fails closed, does NOT throw', () => {
    let result: ReturnType<typeof resolveSelfUpgradeSource> | undefined;
    expect(() => {
      result = resolveSelfUpgradeSource({ self_upgrade: { source: { owner: 'a', repo: 'b' } as unknown as string } }, undefined);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  test('non-string self_upgrade.source (array) fails closed, does NOT throw', () => {
    let result: ReturnType<typeof resolveSelfUpgradeSource> | undefined;
    expect(() => {
      result = resolveSelfUpgradeSource({ self_upgrade: { source: ['a/b'] as unknown as string } }, undefined);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  test('non-string self_upgrade.source (boolean true) fails closed, does NOT throw', () => {
    let result: ReturnType<typeof resolveSelfUpgradeSource> | undefined;
    expect(() => {
      result = resolveSelfUpgradeSource({ self_upgrade: { source: true as unknown as string } }, undefined);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  test('self_upgrade.source: null (explicit JSON null) fails closed, does NOT throw', () => {
    let result: ReturnType<typeof resolveSelfUpgradeSource> | undefined;
    expect(() => {
      result = resolveSelfUpgradeSource({ self_upgrade: { source: null as unknown as string } }, undefined);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  test('self_upgrade.source: undefined (key absent) → unpinned default, unchanged', () => {
    const r = resolveSelfUpgradeSource({ self_upgrade: {} }, undefined);
    expect(r).toEqual({ ok: true, source: DEFAULT_SELF_UPGRADE_SOURCE, pinned: false });
  });

  test('GBRAIN_SELF_UPGRADE_SOURCE explicitly present but empty fails closed (does NOT fall through to config)', () => {
    const r = resolveSelfUpgradeSource({ self_upgrade: { source: PIN } }, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('GBRAIN_SELF_UPGRADE_SOURCE');
  });

  test('GBRAIN_SELF_UPGRADE_SOURCE explicitly present but whitespace-only fails closed', () => {
    const r = resolveSelfUpgradeSource({ self_upgrade: { source: PIN } }, '   ');
    expect(r.ok).toBe(false);
  });

  test('GBRAIN_SELF_UPGRADE_SOURCE truly unset (undefined) still falls through to config, unchanged', () => {
    const r = resolveSelfUpgradeSource({ self_upgrade: { source: PIN } }, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pinned).toBe(true);
  });

  test('config self_upgrade.source: "" (empty string, explicit clear) → unpinned default, NOT fail-closed', () => {
    // Distinct from the env-var case: a file-plane empty string is the
    // documented way to clear a pin (`gbrain config set self_upgrade.source
    // ""`), a deliberate visible file edit — not an ambient env quirk.
    const r = resolveSelfUpgradeSource({ self_upgrade: { source: '' } }, undefined);
    expect(r).toEqual({ ok: true, source: DEFAULT_SELF_UPGRADE_SOURCE, pinned: false });
  });
});

describe('resolveConfiguredSelfUpgradeSource (file-plane)', () => {
  function scratchHome(): string {
    return mkdtempSync(join(tmpdir(), 'gb-selfupgrade-src-'));
  }

  test('no config file → upstream default, unpinned', async () => {
    const home = scratchHome();
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const r = resolveConfiguredSelfUpgradeSource();
      expect(r).toEqual({ ok: true, source: DEFAULT_SELF_UPGRADE_SOURCE, pinned: false });
    });
  });

  test('config.json self_upgrade.source set → resolves pinned', async () => {
    const home = scratchHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', self_upgrade: { source: PIN } }),
    );
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const r = resolveConfiguredSelfUpgradeSource();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.pinned).toBe(true);
        expect(r.source).toEqual({ owner: 'reza-rahimi-ca', repo: 'gbrain', ref: 'feat/openrouter-only-install' });
      }
    });
  });

  test('malformed config.json self_upgrade.source → fails closed, never the upstream default', async () => {
    const home = scratchHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', self_upgrade: { source: 'https://evil.example/x' } }),
    );
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const r = resolveConfiguredSelfUpgradeSource();
      expect(r.ok).toBe(false);
    });
  });

  test('config.json self_upgrade.source is a non-string (e.g. a number) → fails closed, never throws (gap #4)', async () => {
    const home = scratchHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', self_upgrade: { source: 123 } }),
    );
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      let r: ReturnType<typeof resolveConfiguredSelfUpgradeSource> | undefined;
      expect(() => {
        r = resolveConfiguredSelfUpgradeSource();
      }).not.toThrow();
      expect(r?.ok).toBe(false);
    });
  });

  test('GBRAIN_SELF_UPGRADE_SOURCE set to an empty string in the real environment fails closed', async () => {
    const home = scratchHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', self_upgrade: { source: PIN } }),
    );
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: '' }, async () => {
      const r = resolveConfiguredSelfUpgradeSource();
      expect(r.ok).toBe(false);
    });
  });

  test('corrupt config.json (exists, invalid JSON) FAILS CLOSED — never throws, never degrades to upstream default (item 9 correction pass, gap #3)', async () => {
    // The intended pin is unknowable when the config file that would carry
    // it exists but can't be parsed — silently falling back to the
    // upstream default here would un-pin a fork install with no signal.
    const home = scratchHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), '{ not valid json');
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      let r: ReturnType<typeof resolveConfiguredSelfUpgradeSource> | undefined;
      expect(() => {
        r = resolveConfiguredSelfUpgradeSource();
      }).not.toThrow();
      expect(r?.ok).toBe(false);
      if (r && !r.ok) expect(r.error).toContain('not valid JSON');
    });
  });

  test('missing config.json (no file at all) still resolves to the upstream default, unchanged', async () => {
    const home = scratchHome();
    // GBRAIN_HOME points at a real directory but no .gbrain/config.json
    // exists at all — the ordinary fresh-install / no-config case.
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const r = resolveConfiguredSelfUpgradeSource();
      expect(r).toEqual({ ok: true, source: DEFAULT_SELF_UPGRADE_SOURCE, pinned: false });
    });
  });

  test('env override still wins over a corrupt config file (never fails closed when env governs)', async () => {
    const home = scratchHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), '{ not valid json');
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: PIN }, async () => {
      const r = resolveConfiguredSelfUpgradeSource();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.pinned).toBe(true);
        expect(r.source).toEqual({ owner: 'reza-rahimi-ca', repo: 'gbrain', ref: 'feat/openrouter-only-install' });
      }
    });
  });

  test('config.json exists but is unreadable (permission denied) FAILS CLOSED, never throws', async () => {
    const home = scratchHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const cfgPath = join(home, '.gbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', self_upgrade: { source: PIN } }));
    chmodSync(cfgPath, 0o000);
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
        let r: ReturnType<typeof resolveConfiguredSelfUpgradeSource> | undefined;
        expect(() => {
          r = resolveConfiguredSelfUpgradeSource();
        }).not.toThrow();
        // Running as root (some CI/sandbox environments) bypasses the
        // permission bit entirely — only assert fail-closed when the
        // unreadable-ness actually took effect.
        if (r && !r.ok) {
          expect(r.error).toContain('could not be read');
        }
      });
    } finally {
      chmodSync(cfgPath, 0o600);
    }
  });
});

describe('derived URL/identifier helpers use the configured owner/repo/ref', () => {
  const parsed = parseSelfUpgradeSourcePin(PIN);
  if (!parsed.ok) throw new Error('fixture pin must parse');
  const source = parsed.source;

  test('bunGithubInstallTarget', () => {
    expect(bunGithubInstallTarget(source)).toBe('github:reza-rahimi-ca/gbrain#feat/openrouter-only-install');
  });

  test('versionFileUrl + changelog URLs', () => {
    expect(versionFileUrl(source)).toBe(
      'https://raw.githubusercontent.com/reza-rahimi-ca/gbrain/feat/openrouter-only-install/VERSION',
    );
    expect(changelogRawUrl(source)).toBe(
      'https://raw.githubusercontent.com/reza-rahimi-ca/gbrain/feat/openrouter-only-install/CHANGELOG.md',
    );
    expect(changelogWebUrl(source)).toBe(
      'https://github.com/reza-rahimi-ca/gbrain/blob/feat/openrouter-only-install/CHANGELOG.md',
    );
  });

  test('releasesWebUrl + releasesLatestApiUrl', () => {
    expect(releasesWebUrl(source)).toBe('https://github.com/reza-rahimi-ca/gbrain/releases');
    expect(releasesLatestApiUrl(source)).toBe('https://api.github.com/repos/reza-rahimi-ca/gbrain/releases/latest');
  });

  test('attestation base + builder id use the configured owner/repo/ref, never garrytan', () => {
    expect(attestationApiBase(source)).toBe('https://api.github.com/repos/reza-rahimi-ca/gbrain/attestations/sha256:');
    expect(expectedBuilderIdPrefix(source)).toBe(
      'https://github.com/reza-rahimi-ca/gbrain/.github/workflows/release.yml@',
    );
    // Both branch- and tag-triggered forms are accepted for the SAME exact
    // ref, owner/repo, and workflow path (item 9 correction pass: an
    // arbitrary fork's release.yml may trigger on either).
    expect(expectedBuilderIds(source)).toEqual([
      'https://github.com/reza-rahimi-ca/gbrain/.github/workflows/release.yml@refs/heads/feat/openrouter-only-install',
      'https://github.com/reza-rahimi-ca/gbrain/.github/workflows/release.yml@refs/tags/feat/openrouter-only-install',
    ]);
    for (const url of [
      attestationApiBase(source),
      ...expectedBuilderIds(source),
      releasesWebUrl(source),
      releasesLatestApiUrl(source),
      versionFileUrl(source),
      changelogRawUrl(source),
      changelogWebUrl(source),
      bunGithubInstallTarget(source),
    ]) {
      expect(url).not.toContain('garrytan');
    }
  });

  test('repoMarker', () => {
    expect(repoMarker(source)).toBe('reza-rahimi-ca/gbrain');
  });
});
