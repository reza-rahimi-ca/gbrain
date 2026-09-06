/**
 * Item 9 (fork-pin): binary release assets + build-provenance/attestation
 * identity must resolve the configured `self_upgrade.source`, and a
 * malformed/unsupported source must fail closed BEFORE any network call —
 * never silently fall back to fetching/verifying against upstream
 * `garrytan/gbrain`.
 *
 * Uses `withEnv` (GBRAIN_HOME mutation) — kept as .serial.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  defaultFetchAttestation,
  runBinarySelfUpdate,
  type ParsedAttestation,
} from '../src/core/binary-self-update.ts';

const PIN = 'reza-rahimi-ca/gbrain#feat/openrouter-only-install';
const PINNED_BUILDER =
  'https://github.com/reza-rahimi-ca/gbrain/.github/workflows/release.yml@refs/heads/feat/openrouter-only-install';
const UPSTREAM_BUILDER = 'https://github.com/garrytan/gbrain/.github/workflows/release.yml@refs/heads/master';

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), 'gb-binswu-pin-'));
}

function writeSourceConfig(home: string, source: string): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', self_upgrade: { source } }));
}

const FAKE_DIGEST = 'a'.repeat(64);

function passingDeps(assetName: string, builderId: string) {
  return {
    computeDigest: () => FAKE_DIGEST,
    fetchAttestation: async (): Promise<ParsedAttestation[]> => [
      { subjects: [{ name: assetName, sha256: FAKE_DIGEST }], builderId },
    ],
    fetchRelease: async () => ({ tag: 'v9.9.9', assets: [{ name: assetName, url: 'https://example.com/asset' }] }),
    download: async (_url: string, destPath: string) => {
      writeFileSync(destPath, 'PRETEND BINARY BYTES\n');
    },
    smoke: () => true,
    checkVersion: () => true,
  };
}

describe('runBinarySelfUpdate — fail-closed on invalid source (before any fetch)', () => {
  test('malformed self_upgrade.source → invalid_source, fetchRelease never called', async () => {
    const home = scratchHome();
    writeSourceConfig(home, 'https://not/a/valid/pin');
    let fetchReleaseCalls = 0;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const res = await runBinarySelfUpdate('/tmp/does-not-matter/gbrain', {
        platform: 'linux',
        arch: 'x64',
        fetchRelease: async () => {
          fetchReleaseCalls++;
          return { tag: 'v9.9.9', assets: [] };
        },
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('invalid_source');
      expect(typeof res.error).toBe('string');
    });
    expect(fetchReleaseCalls).toBe(0);
  });

  test('unsupported platform still resolves source first but is reported as unsupported_platform, not invalid_source', async () => {
    const home = scratchHome();
    // no config written — ordinary upstream default, valid.
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const res = await runBinarySelfUpdate('/tmp/does-not-matter/gbrain', {
        platform: 'win32',
        arch: 'x64',
      });
      expect(res).toEqual({ ok: false, reason: 'unsupported_platform' });
    });
  });
});

describe('runBinarySelfUpdate — provenance identity follows the configured source', () => {
  test('pinned source: attestation from the PINNED repo/ref verifies successfully', async () => {
    const home = scratchHome();
    writeSourceConfig(home, PIN);
    const dir = mkdtempSync(join(tmpdir(), 'gb-binswu-target-'));
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const res = await runBinarySelfUpdate(join(dir, 'gbrain'), {
        platform: 'linux',
        arch: 'x64',
        ...passingDeps('gbrain-linux-x64', PINNED_BUILDER),
      });
      expect(res.ok).toBe(true);
    });
  });

  test('pinned source: a TAG-triggered attestation (refs/tags/<ref>) also verifies (item 9 correction pass, gap #5)', async () => {
    const home = scratchHome();
    writeSourceConfig(home, PIN);
    const dir = mkdtempSync(join(tmpdir(), 'gb-binswu-target-'));
    const tagBuilder =
      'https://github.com/reza-rahimi-ca/gbrain/.github/workflows/release.yml@refs/tags/feat/openrouter-only-install';
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const res = await runBinarySelfUpdate(join(dir, 'gbrain'), {
        platform: 'linux',
        arch: 'x64',
        ...passingDeps('gbrain-linux-x64', tagBuilder),
      });
      expect(res.ok).toBe(true);
    });
  });

  test('a builder id for the right repo/ref but wrong TRIGGER-KIND spelling is still rejected (not a wildcard accept)', async () => {
    const home = scratchHome();
    writeSourceConfig(home, PIN);
    const dir = mkdtempSync(join(tmpdir(), 'gb-binswu-target-'));
    const wrongKind =
      'https://github.com/reza-rahimi-ca/gbrain/.github/workflows/release.yml@refs/pull/feat/openrouter-only-install';
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const res = await runBinarySelfUpdate(join(dir, 'gbrain'), {
        platform: 'linux',
        arch: 'x64',
        ...passingDeps('gbrain-linux-x64', wrongKind),
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('integrity_failed');
    });
  });

  test('pinned source: an attestation carrying the UPSTREAM builder id is REJECTED (never silently accepted as this fork\'s provenance)', async () => {
    const home = scratchHome();
    writeSourceConfig(home, PIN);
    const dir = mkdtempSync(join(tmpdir(), 'gb-binswu-target-'));
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const res = await runBinarySelfUpdate(join(dir, 'gbrain'), {
        platform: 'linux',
        arch: 'x64',
        ...passingDeps('gbrain-linux-x64', UPSTREAM_BUILDER),
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('integrity_failed');
    });
  });

  test('unpinned (default) source: upstream builder id verifies, pinned-repo builder id does NOT', async () => {
    const home = scratchHome();
    // no config → upstream default
    const dir = mkdtempSync(join(tmpdir(), 'gb-binswu-target-'));
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
      const okRes = await runBinarySelfUpdate(join(dir, 'gbrain'), {
        platform: 'linux',
        arch: 'x64',
        ...passingDeps('gbrain-linux-x64', UPSTREAM_BUILDER),
      });
      expect(okRes.ok).toBe(true);

      const failRes = await runBinarySelfUpdate(join(dir, 'gbrain'), {
        platform: 'linux',
        arch: 'x64',
        ...passingDeps('gbrain-linux-x64', PINNED_BUILDER),
      });
      expect(failRes.ok).toBe(false);
      expect(failRes.reason).toBe('integrity_failed');
    });
  });
});

describe('default fetch helpers use the configured owner/repo/ref (network stubbed)', () => {
  const REAL_FETCH = globalThis.fetch;
  function stubFetch(impl: (url: string) => Response) {
    (globalThis as any).fetch = (input: any) => Promise.resolve(impl(String(input)));
  }
  function restoreFetch() {
    (globalThis as any).fetch = REAL_FETCH;
  }

  test('defaultFetchRelease (via runBinarySelfUpdate) hits the pinned releases/latest URL, never garrytan', async () => {
    const home = scratchHome();
    writeSourceConfig(home, PIN);
    const requestedUrls: string[] = [];
    stubFetch((url) => {
      requestedUrls.push(url);
      return new Response(JSON.stringify({ tag_name: 'v9.9.9', assets: [] }), { status: 200 });
    });
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_SOURCE: undefined }, async () => {
        const res = await runBinarySelfUpdate('/tmp/does-not-matter/gbrain', { platform: 'linux', arch: 'x64' });
        // No published assets in the stub → no_asset, but the release fetch itself must have happened against the pin.
        expect(res.reason).toBe('no_asset');
      });
    } finally {
      restoreFetch();
    }
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      expect(url).toContain('reza-rahimi-ca/gbrain');
      expect(url).not.toContain('garrytan');
    }
  });

  test('defaultFetchAttestation(digest, source) builds the URL from the given source', async () => {
    const parsed = { owner: 'reza-rahimi-ca', repo: 'gbrain', ref: 'feat/openrouter-only-install' };
    let requestedUrl = '';
    stubFetch((url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ attestations: [] }), { status: 200 });
    });
    try {
      await defaultFetchAttestation(FAKE_DIGEST, parsed);
    } finally {
      restoreFetch();
    }
    expect(requestedUrl).toBe(`https://api.github.com/repos/reza-rahimi-ca/gbrain/attestations/sha256:${FAKE_DIGEST}`);
  });
});
