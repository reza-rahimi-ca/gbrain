import { VERSION } from '../version.ts';
import { detectInstallMethod } from './upgrade.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import {
  isMinorOrMajorBump,
  isNewerVersion,
  isValidVersionString,
  parseSemver,
  semverGt,
  semverLte,
} from '../core/semver.ts';
import { readUpdateCache, writeUpdateCache, type UpdateMarker } from '../core/self-upgrade.ts';
import {
  bunGithubInstallTarget,
  changelogRawUrl,
  changelogWebUrl,
  resolveConfiguredSelfUpgradeSource,
  sourceIdentityToken,
  sourceTokenMatchesResolved,
  versionFileUrl,
  type SelfUpgradeSourceResult,
} from '../core/self-upgrade-source.ts';

/** Best-effort cache write — a read-only ~/.gbrain must never make the check throw. */
function safeWriteCache(marker: UpdateMarker): void {
  try {
    writeUpdateCache(marker);
  } catch {
    /* fail-open: no cache this run, next invocation re-checks */
  }
}

// Back-compat re-exports: these used to live here; moved to ../core/semver.ts
// so the self-upgrade decision module can depend on them without an import
// cycle. Existing importers (`test/check-update.test.ts`, etc.) keep working.
export { parseSemver, isMinorOrMajorBump, isNewerVersion };

interface CheckUpdateResult {
  current_version: string;
  current_source: 'package-json';
  latest_version: string;
  update_available: boolean;
  upgrade_command: string;
  release_url: string;
  changelog_diff: string;
  published_at: string;
  error?: string;
}

/**
 * The upgrade command to advise for `method`. Never emits a command that
 * would silently replace a pinned fork/branch with upstream (item 9
 * correction pass, gap #1).
 *
 *   - Invalid configured source (`source.ok === false`) → `null`: resolution
 *     itself already fails closed before anything could run, so recommending
 *     ANY command would be misleading actionable-looking guidance for a
 *     config that can't currently upgrade anything. Callers must treat
 *     `null` as "no actionable command", never coalesce it to a guess.
 *   - PINNED to a valid non-upstream source: `bun` shows the pinned GitHub
 *     install target, not the plain `bun update gbrain` (which re-resolves
 *     whatever the local `package.json` dependency spec says — the "Bun's
 *     upgrade lane can also replace a GitHub-branch install with the
 *     upstream package" failure mode this feature closes). `clawhub` ALSO
 *     shows the pinned Bun target rather than `clawhub update gbrain` —
 *     ClawHub has no fork/branch concept at all, so it can only ever track
 *     upstream; recommending it for a pinned install would be unsafe
 *     guidance (mirrors the actual apply-time refusal in
 *     `src/commands/upgrade.ts`'s `clawhub` lane).
 *   - `binary` and the generic fallback are safe to recommend regardless of
 *     pinning: both independently resolve and respect the SAME configured
 *     source internally (`runBinarySelfUpdate` / `runUpgrade`'s per-lane
 *     checks), so `gbrain self-upgrade` / `gbrain upgrade` do the right
 *     thing (or fail closed with an actionable message of their own)
 *     whether pinned or not.
 */
export function upgradeCommandForMethod(method: string, source: SelfUpgradeSourceResult): string | null {
  if (!source.ok) return null;
  switch (method) {
    case 'bun':
      return source.pinned ? `bun add -g ${bunGithubInstallTarget(source.source)}` : 'bun update gbrain';
    case 'clawhub':
      return source.pinned ? `bun add -g ${bunGithubInstallTarget(source.source)}` : 'clawhub update gbrain';
    case 'binary': return 'gbrain self-upgrade';
    default: return 'gbrain upgrade';
  }
}

/** Extract a version from the raw VERSION file body: first line, optional `v`
 * prefix, optional `-suffix` channel tag (`0.31.1.1-fixwave` compares as its
 * numeric base — fail-safe: a suffix-only bump never prompts). Body is bounded
 * before parsing so a malformed/huge response can't blow up the check. */
export function parseVersionFileBody(body: string): string | null {
  const firstLine = body.slice(0, 256).trim().split('\n')[0].trim();
  const m = firstLine.match(/^v?(\d+\.\d+\.\d+(?:\.\d+)?)(?:[-+][0-9A-Za-z.-]+)?$/);
  return m && isValidVersionString(m[1]) ? m[1] : null;
}

export type LatestReleaseResult =
  | { ok: true; tag: string; published_at: string; url: string; source: string; pinned: boolean }
  | { ok: false; reason: 'network_error' | 'no_releases' | 'invalid_source'; error?: string };

/**
 * Resolve the latest published gbrain version (from the `VERSION` file on
 * the configured source's ref — the ordinary upstream default is
 * `garrytan/gbrain` on `master`; see `src/core/self-upgrade-source.ts`).
 * Exported (v0.42) so the self-upgrade refresh path and tests can reuse it.
 * 5s timeout — this runs on the detached refresh, never the hot path.
 * Failures are discriminated: `network_error` (offline/timeout), `no_releases`
 * (endpoint answered but no usable version), and `invalid_source` (the
 * configured `self_upgrade.source` — or `GBRAIN_SELF_UPGRADE_SOURCE` — is
 * malformed/unsupported; fails CLOSED before any fetch, never falls back to
 * upstream).
 *
 * This deliberately does NOT read `releases/latest`: it was a permanent 404
 * before releases existed (#3520) and can still lag the branch tip. An npm
 * fallback was rejected: the `gbrain` package on npm is an unrelated GPU
 * library (#505), so it would produce false upgrade prompts pointing at a
 * stranger's package.
 */
export async function fetchLatestRelease(): Promise<LatestReleaseResult> {
  const resolved = resolveConfiguredSelfUpgradeSource();
  if (!resolved.ok) {
    return { ok: false, reason: 'invalid_source', error: resolved.error };
  }
  const source = resolved.source;
  let res: Response;
  try {
    res = await fetch(versionFileUrl(source), {
      headers: { 'User-Agent': `gbrain/${VERSION}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { ok: false, reason: 'network_error' };
  }
  try {
    if (!res.ok) return { ok: false, reason: 'no_releases' };
    const tag = parseVersionFileBody(await res.text());
    if (!tag) return { ok: false, reason: 'no_releases' };
    return {
      ok: true,
      tag,
      published_at: '',
      url: changelogWebUrl(source),
      source: sourceIdentityToken(source),
      pinned: resolved.pinned,
    };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}

export async function fetchChangelog(currentVersion: string, latestVersion: string): Promise<string> {
  const resolved = resolveConfiguredSelfUpgradeSource();
  // Fail closed: an invalid configured source must not fall back to fetching
  // upstream's changelog. A missing changelog is already a no-op (empty
  // string, best-effort), so this degrades the same way a network failure
  // does — just without ever making the request.
  if (!resolved.ok) return '';
  try {
    const res = await fetch(changelogRawUrl(resolved.source), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return '';
    const text = await res.text();
    return extractChangelogBetween(text, currentVersion, latestVersion);
  } catch {
    return '';
  }
}

export function extractChangelogBetween(changelog: string, from: string, to: string): string {
  const lines = changelog.split('\n');
  const entries: string[] = [];
  let capturing = false;
  const fromParsed = parseSemver(from);
  if (!fromParsed) return '';

  for (const line of lines) {
    const versionMatch = line.match(/^## \[(\d+\.\d+\.\d+(?:\.\d+)?)\]/);
    if (versionMatch) {
      const verParsed = parseSemver(versionMatch[1]);
      if (!verParsed) {
        if (capturing) entries.push(line);
        continue;
      }
      if (!capturing) {
        // Start capturing at any version newer than current
        if (semverGt(verParsed, fromParsed)) {
          capturing = true;
          entries.push(line);
        }
      } else {
        // Stop capturing when we hit the current version or older
        if (semverLte(verParsed, fromParsed)) {
          break;
        }
        entries.push(line);
      }
    } else if (capturing) {
      entries.push(line);
    }
  }

  return entries.join('\n').trim();
}

/**
 * A failed check must NEVER write `up_to_date` — that was #486: the fetch
 * failed permanently (dead releases API) and every user was told "you're
 * current" forever. Instead, re-write the last-known-good marker (bumping its
 * mtime so the cache TTL still throttles retries and a network blip can't
 * erase a pending upgrade_available notice). No prior marker → write nothing;
 * the next invocation retries.
 *
 * Source-scoped (item 9 correction pass): a prior marker written for a
 * DIFFERENT source than the one currently configured must NOT be preserved —
 * "preserving" it (bumping its mtime, keeping it fresh) would keep a
 * wrong-source result alive across a source change (e.g. switching
 * `self_upgrade.source` from unset to a fork). It is simply left untouched
 * on disk; `readUpdateCache` consumers already re-validate the source token
 * themselves, so an untouched (now-stale-by-mtime) foreign-source entry is
 * inert either way, but not re-freshening it is the honest behavior — there
 * is no "last-known-good" data for the newly configured source yet.
 */
function preserveCacheOnFailedCheck(): void {
  try {
    const prior = readUpdateCache();
    if (!prior) return;
    const resolved = resolveConfiguredSelfUpgradeSource();
    if (!sourceTokenMatchesResolved(prior.marker.source, resolved)) return;
    safeWriteCache(prior.marker);
  } catch {
    /* best-effort */
  }
}

/**
 * Fetch the latest version and write the self-upgrade cache (the marker line
 * read by the CLI startup hook). On fetch failure the last-known-good marker is
 * preserved (see preserveCacheOnFailedCheck) — never a fabricated `up_to_date`.
 * This is the function the detached single-flight refresh (`gbrain
 * check-update --refresh-cache`) invokes.
 */
export async function refreshUpdateCache(): Promise<void> {
  const release = await fetchLatestRelease();
  if (!release.ok) {
    preserveCacheOnFailedCheck();
    return;
  }
  // Only PINNED sources stamp the marker's source field — an unpinned
  // (ordinary upstream) result keeps writing the exact legacy marker shape
  // for maximum compatibility with older gbrain binaries reading the same
  // cache file (see docs/guides/upgrades-auto-update.md).
  const markerSource = release.pinned ? release.source : undefined;
  const latestVersion = release.tag.replace(/^v/, '');
  if (!isValidVersionString(latestVersion) || !isNewerVersion(VERSION, latestVersion)) {
    safeWriteCache({ kind: 'up_to_date', current: VERSION, source: markerSource });
    return;
  }
  safeWriteCache({ kind: 'upgrade_available', current: VERSION, latest: latestVersion, source: markerSource });
}

export async function runCheckUpdate(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain check-update [--json] [--refresh-cache]\n\nCheck for new GBrain versions.\n\nReports any strictly newer release, including patch and micro updates.\nFails silently on network errors.\n\n--refresh-cache  Fetch + update the self-upgrade cache, print nothing (used by\n                 the CLI startup hook\'s detached refresh).');
    return;
  }

  // Detached refresh path: warm the cache for the next invocation, emit nothing.
  // Single-flight via the refresh lock so many simultaneous stale-cache
  // invocations don't stampede GitHub. If another refresh holds the lock, exit.
  if (args.includes('--refresh-cache')) {
    const { tryAcquireRefreshLock, releaseRefreshLock } = await import('../core/self-upgrade.ts');
    const lock = tryAcquireRefreshLock();
    if (!lock) return; // another refresh is in flight
    try {
      await refreshUpdateCache();
    } finally {
      releaseRefreshLock(lock);
    }
    return;
  }

  const json = args.includes('--json');
  const method = detectInstallMethod();
  const sourceResult = resolveConfiguredSelfUpgradeSource();
  const upgradeCmd = upgradeCommandForMethod(method, sourceResult);

  const release = await fetchLatestRelease();

  if (!release.ok) {
    preserveCacheOnFailedCheck();
    // A malformed/unsupported configured source is a config error, not a
    // transient network blip — it must set a nonzero verdict regardless of
    // --json (the JSON branch below reports it as data, not a thrown error,
    // so the exit code has to be set explicitly here rather than relying on
    // a catch/throw path).
    if (release.reason === 'invalid_source') setCliExitVerdict(1);
    if (json) {
      console.log(JSON.stringify({
        current_version: VERSION,
        current_source: 'package-json',
        latest_version: '',
        update_available: false,
        // null (invalid source) coalesces to '' — never a guessed command;
        // `error`/`error_detail` already say why nothing is actionable.
        upgrade_command: upgradeCmd ?? '',
        release_url: '',
        changelog_diff: '',
        published_at: '',
        error: release.reason,
        ...(release.reason === 'invalid_source' ? { error_detail: release.error } : {}),
      }, null, 2));
    } else if (release.reason === 'network_error') {
      console.log(`GBrain ${VERSION} — could not check for updates (network unavailable).`);
    } else if (release.reason === 'invalid_source') {
      // Fail closed, no upstream fallback: a malformed/unsupported
      // self_upgrade.source must be fixed by the operator, not silently
      // ignored in favor of checking garrytan/gbrain.
      console.log(`GBrain ${VERSION} — self_upgrade.source is invalid: ${release.error}`);
      console.log('Fix self_upgrade.source (or unset GBRAIN_SELF_UPGRADE_SOURCE) and retry.');
    } else {
      console.log(`GBrain ${VERSION} — could not determine the latest published version.`);
    }
    return;
  }

  const latestVersion = release.tag.replace(/^v/, '');
  const updateAvailable = isValidVersionString(latestVersion) && isNewerVersion(VERSION, latestVersion);

  // Warm the self-upgrade cache so the next `gbrain <cmd>` startup hook can emit
  // the marker without a network call. Only PINNED sources stamp the
  // marker's source field (see refreshUpdateCache for why).
  const markerSource = release.pinned ? release.source : undefined;
  safeWriteCache(
    updateAvailable
      ? { kind: 'upgrade_available', current: VERSION, latest: latestVersion, source: markerSource }
      : { kind: 'up_to_date', current: VERSION, source: markerSource },
  );

  let changelogDiff = '';
  if (updateAvailable) {
    changelogDiff = await fetchChangelog(VERSION, latestVersion);
  }

  const result: CheckUpdateResult = {
    current_version: VERSION,
    current_source: 'package-json',
    latest_version: latestVersion,
    update_available: updateAvailable,
    // Guards a theoretical race (sourceResult and release.ok resolved from
    // two independent reads of the same config): never coalesce a null
    // (invalid-source) command to a guessed string.
    upgrade_command: upgradeCmd ?? '',
    release_url: release.url,
    changelog_diff: changelogDiff,
    published_at: release.published_at,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (updateAvailable) {
    console.log(`GBrain update available: ${VERSION} → ${latestVersion}`);
    if (upgradeCmd) console.log(`Run: ${upgradeCmd}`);
    console.log(`Release: ${release.url}`);
  } else {
    console.log(`GBrain ${VERSION} is up to date.`);
  }
}
