/**
 * Self-upgrade source resolver (v0.46 fork-pin wave, item 9).
 *
 * Every self-upgrade surface — release/version discovery, changelog lookup,
 * the Bun package-manager reinstall target, binary release assets, and
 * build-provenance/attestation identity — must resolve the SAME
 * `{owner, repo, ref}` triple through this module. Nothing downstream may
 * hand-roll a hardcoded GitHub URL: that's how a pinned fork installation
 * would silently keep checking/fetching/installing upstream `garrytan/gbrain`
 * instead of the configured source.
 *
 * Resolution order (mirrors `resolveSelfUpgradeMode`): env override
 * (`GBRAIN_SELF_UPGRADE_SOURCE`, the operator/CI escape hatch) > file-plane
 * config (`self_upgrade.source`) > the ordinary upstream default. When no
 * source is configured, callers get the exact upstream behavior unchanged.
 *
 * When a source IS configured, it is validated up front. Malformed or
 * unsupported input (a URL, an scp-style git remote, more than one `#`, an
 * invalid owner/repo/ref segment) fails CLOSED with an actionable error and
 * `pinned` semantics never silently degrade to the upstream default — a
 * caller that can't parse the pin must refuse to fetch/install, not fall
 * back to `garrytan/gbrain`.
 *
 * `resolveConfiguredSelfUpgradeSource()` (bottom of this file) is the ONE
 * entry point every self-upgrade surface should call to get from "nothing
 * but the file-plane config + env" to a validated source: check-only/notify
 * (`commands/check-update.ts`), explicit `gbrain self-upgrade`
 * (`commands/self-upgrade.ts`), the Bun/binary swap
 * (`commands/upgrade.ts`, `core/binary-self-update.ts`), and the autopilot
 * silent channel (which shells out to `gbrain upgrade --swap-only`, so it
 * inherits this resolution for free). Nobody should call
 * `resolveSelfUpgradeSource` directly with a hand-rolled config read.
 */

import { existsSync, readFileSync } from 'node:fs';
import { configPath } from './config.ts';

export interface SelfUpgradeSource {
  owner: string;
  repo: string;
  ref: string;
}

export const DEFAULT_SELF_UPGRADE_OWNER = 'garrytan';
export const DEFAULT_SELF_UPGRADE_REPO = 'gbrain';
export const DEFAULT_SELF_UPGRADE_REF = 'master';

/** The ordinary upstream source — used whenever no pin is configured. */
export const DEFAULT_SELF_UPGRADE_SOURCE: SelfUpgradeSource = {
  owner: DEFAULT_SELF_UPGRADE_OWNER,
  repo: DEFAULT_SELF_UPGRADE_REPO,
  ref: DEFAULT_SELF_UPGRADE_REF,
};

/**
 * Documented default ref for a pin that names only `owner/repo` (no `#ref`):
 * GitHub's current default branch name for newly created repositories. A
 * fork whose default branch is `master` (or anything else) must say so
 * explicitly — `owner/repo#branch-name` — this default is a convenience for
 * the common case, not a guess at any particular repo's actual HEAD.
 */
export const DEFAULT_PINNED_REF = 'main';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Branch/tag names may contain interior slashes (`feat/openrouter-only-install`)
// but never a leading '-' (looks like a flag to shell-adjacent consumers),
// '..' (path traversal shape), or a doubled slash.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/;

export type ParsedSelfUpgradeSource =
  | { ok: true; source: SelfUpgradeSource }
  | { ok: false; error: string };

/**
 * Parse a `owner/repo` or `owner/repo#ref` pin string. Pure; no I/O, no
 * network. Splits on the FIRST `#` only (branch refs with slashes are
 * handled correctly — the ref itself may contain `/`, but the owner/repo
 * portion before `#` must be exactly one `/`).
 */
export function parseSelfUpgradeSourcePin(raw: string): ParsedSelfUpgradeSource {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'self_upgrade.source is set but empty' };
  }

  // Reject URL-shaped / scp-shaped input up front: this pin is `owner/repo[#ref]`
  // only, never a git remote URL (http(s)://, git://, ssh://, or git@host:path).
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) || /^[^/#]+@/.test(trimmed)) {
    return {
      ok: false,
      error: `self_upgrade.source must be "owner/repo" or "owner/repo#ref", not a URL: ${JSON.stringify(raw)}`,
    };
  }

  const firstHash = trimmed.indexOf('#');
  const lastHash = trimmed.lastIndexOf('#');
  if (firstHash !== lastHash) {
    return { ok: false, error: `self_upgrade.source has more than one '#': ${JSON.stringify(raw)}` };
  }

  const repoPart = firstHash === -1 ? trimmed : trimmed.slice(0, firstHash);
  const refPart = firstHash === -1 ? '' : trimmed.slice(firstHash + 1);

  if (firstHash !== -1 && refPart.length === 0) {
    return { ok: false, error: `self_upgrade.source has an empty ref after '#': ${JSON.stringify(raw)}` };
  }

  const slashIdx = repoPart.indexOf('/');
  const lastSlashIdx = repoPart.lastIndexOf('/');
  if (slashIdx === -1 || slashIdx !== lastSlashIdx) {
    return {
      ok: false,
      error: `self_upgrade.source must be exactly "owner/repo" before any '#ref': ${JSON.stringify(raw)}`,
    };
  }
  const owner = repoPart.slice(0, slashIdx);
  const repo = repoPart.slice(slashIdx + 1);

  if (!OWNER_RE.test(owner)) {
    return { ok: false, error: `self_upgrade.source has an invalid owner segment: ${JSON.stringify(owner)}` };
  }
  if (!REPO_RE.test(repo)) {
    return { ok: false, error: `self_upgrade.source has an invalid repo segment: ${JSON.stringify(repo)}` };
  }

  const ref = refPart || DEFAULT_PINNED_REF;
  if (!REF_RE.test(ref) || ref.includes('..') || ref.includes('//')) {
    return {
      ok: false,
      error: `self_upgrade.source has an invalid ref segment: ${JSON.stringify(refPart || ref)}`,
    };
  }

  return { ok: true, source: { owner, repo, ref } };
}

export type SelfUpgradeSourceResult =
  | { ok: true; source: SelfUpgradeSource; pinned: boolean }
  | { ok: false; error: string };

/**
 * Resolve the effective self-upgrade source: env override > file-plane
 * config (`self_upgrade.source`) > upstream default. Takes a loosely-typed
 * config (like `resolveSelfUpgradeMode`) so callers don't need to pull the
 * full `GBrainConfig` type onto the hot path.
 *
 * `pinned: false` with the DEFAULT source means "nothing configured — this
 * is an ordinary upstream install, behave exactly as before." `pinned: true`
 * means a source was explicitly configured (and validated). `ok: false`
 * means a source was configured but is malformed/unsupported — callers MUST
 * treat this as fail-closed: refuse to fetch/install, never substitute the
 * upstream default.
 *
 * Type hardening (item 9 correction pass): `cfg.self_upgrade.source` is typed
 * `unknown`, not `string` — `loadConfigFileOnly()` casts a bare
 * `JSON.parse()` result, so a malformed config file (`"source": 123`, an
 * object, an array) is a perfectly reachable runtime value despite the
 * static `GBrainConfig` type claiming `string | undefined`. A non-string
 * value must fail closed with an actionable error, never reach `.trim()`
 * (which would throw on a number/object and crash the caller) or get
 * silently coerced.
 *
 * Env-var asymmetry: `envOverride` explicitly present but empty (an
 * operator ran `GBRAIN_SELF_UPGRADE_SOURCE= gbrain ...` or a script exported
 * it empty by mistake) fails closed rather than silently falling through to
 * the file-plane config — an explicit environment override that resolves to
 * "nothing" is far more likely a mistake than a deliberate "ignore the env,
 * use the file" signal, and silently reading a possibly-stale config value
 * instead would be a surprising, hard-to-notice behavior change. A file-plane
 * config value of `""` is treated differently (falls through to "nothing
 * configured"): `gbrain config set self_upgrade.source ""` is the documented
 * way to clear a pin, a deliberate visible edit to a file the operator
 * controls, not an ambient/inherited env quirk.
 */
export function resolveSelfUpgradeSource(
  cfg: { self_upgrade?: { source?: unknown } } | null | undefined,
  envOverride: string | undefined = process.env.GBRAIN_SELF_UPGRADE_SOURCE,
): SelfUpgradeSourceResult {
  if (envOverride !== undefined) {
    if (envOverride.trim() === '') {
      return { ok: false, error: 'GBRAIN_SELF_UPGRADE_SOURCE is set but empty' };
    }
    return finishParsing(envOverride);
  }

  const rawCfg: unknown = cfg?.self_upgrade?.source;
  if (rawCfg === undefined) {
    return { ok: true, source: DEFAULT_SELF_UPGRADE_SOURCE, pinned: false };
  }
  if (typeof rawCfg !== 'string') {
    return {
      ok: false,
      error: `self_upgrade.source must be a string ("owner/repo" or "owner/repo#ref"); got ${typeof rawCfg} (${JSON.stringify(rawCfg)})`,
    };
  }
  if (!rawCfg.trim()) {
    return { ok: true, source: DEFAULT_SELF_UPGRADE_SOURCE, pinned: false };
  }
  return finishParsing(rawCfg);
}

function finishParsing(raw: string): SelfUpgradeSourceResult {
  const parsed = parseSelfUpgradeSourcePin(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, source: parsed.source, pinned: true };
}

// ── Derived URLs / identifiers (every surface builds these the same way) ────

export function repoMarker(s: SelfUpgradeSource): string {
  return `${s.owner}/${s.repo}`;
}

/** The `bun add -g` / `bun install -g` github: target for this source. */
export function bunGithubInstallTarget(s: SelfUpgradeSource): string {
  return `github:${s.owner}/${s.repo}#${s.ref}`;
}

/** Raw VERSION file — the release-train source of truth `check-update` reads. */
export function versionFileUrl(s: SelfUpgradeSource): string {
  return `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${s.ref}/VERSION`;
}

/** Raw CHANGELOG.md — used to extract the "what changed" diff. */
export function changelogRawUrl(s: SelfUpgradeSource): string {
  return `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${s.ref}/CHANGELOG.md`;
}

/** Human-facing changelog link (GitHub blob view). */
export function changelogWebUrl(s: SelfUpgradeSource): string {
  return `https://github.com/${s.owner}/${s.repo}/blob/${s.ref}/CHANGELOG.md`;
}

/** Human-facing releases page. */
export function releasesWebUrl(s: SelfUpgradeSource): string {
  return `https://github.com/${s.owner}/${s.repo}/releases`;
}

/** GitHub REST "latest release" endpoint (binary asset discovery). */
export function releasesLatestApiUrl(s: SelfUpgradeSource): string {
  return `https://api.github.com/repos/${s.owner}/${s.repo}/releases/latest`;
}

/** Base for the GitHub attestation REST endpoint (per-subject-digest lookup). */
export function attestationApiBase(s: SelfUpgradeSource): string {
  return `https://api.github.com/repos/${s.owner}/${s.repo}/attestations/sha256:`;
}

/** Prefix a valid build-provenance attestation's builder id must start with. */
export function expectedBuilderIdPrefix(s: SelfUpgradeSource): string {
  return `https://github.com/${s.owner}/${s.repo}/.github/workflows/release.yml@`;
}

/**
 * Builder ids that count as "this source's release workflow, on a trusted
 * ref". `self_upgrade.source#ref` accepts any git ref NAME (`REF_RE`), and
 * git branch/tag names share the same character set, so the ref string
 * alone can't tell us whether the pin names a branch or a tag.
 *
 * Provenance reassessment (item 9 correction pass): THIS project's own
 * `release.yml` only ever triggers on branch pushes (`refs/heads/<ref>`) —
 * that half is verified against our actual workflow file
 * (`test/release-workflow.test.ts`). An arbitrary fork's `release.yml`
 * could instead trigger on a tag push, in which case GitHub Actions sets
 * `github.ref` to `refs/tags/<ref>` — this is standard, documented GitHub
 * Actions ref-trigger behavior (not something specific to gbrain, and not
 * something this module can independently verify for someone else's
 * workflow file). Accepting BOTH forms here does not broaden what's
 * actually trusted: a match still requires the exact same owner/repo, the
 * exact same `release.yml` workflow path, AND the exact same ref string —
 * `refs/heads/X` vs `refs/tags/X` only decides WHICH trigger kind produced
 * that already-fully-scoped attestation. Rejecting a genuine tag-triggered
 * release from a fork whose workflow legitimately uses tags would be
 * fail-closed in a way that just breaks a supported configuration, not a
 * security improvement.
 */
export function expectedBuilderIds(s: SelfUpgradeSource): string[] {
  const prefix = expectedBuilderIdPrefix(s);
  return [`${prefix}refs/heads/${s.ref}`, `${prefix}refs/tags/${s.ref}`];
}

/**
 * Convenience wrapper around `resolveSelfUpgradeSource`: reads the
 * file-plane config and resolves against it + the env override. This is the
 * function every self-upgrade surface should call — see the module header
 * for the list. Centralizing the config read here (rather than each call
 * site doing its own config read) keeps the "one resolver" guarantee from
 * degrading into "one parser, N config reads."
 *
 * Deliberately does NOT delegate to `loadConfigFileOnly()` (item 9
 * correction pass, gap #3): that helper collapses "no config file" and
 * "config file exists but is corrupt/unreadable" into the same `null`,
 * which is fine for its own callers (global config falls open to defaults
 * either way) but is exactly the WRONG ambiguity here — an existing config
 * that fails to read/parse might be hiding a real pin, and degrading that
 * to "nothing configured" would silently un-pin a fork install (falling
 * back to fetching/installing upstream) with no signal to the operator.
 * So the two cases are handled differently:
 *
 *   - No config file at all → ordinary fresh/upstream install; resolves to
 *     the unpinned default, exactly as `loadConfigFileOnly()`-based
 *     resolution always has.
 *   - Config file EXISTS but can't be read or isn't valid JSON → fails
 *     CLOSED (`ok: false`) — the intended pin is unknowable, so no self-
 *     upgrade surface may fetch/install anything until it's fixed.
 *
 * The env override is checked FIRST and short-circuits entirely (never even
 * stats the config file) — env always wins over file-plane config, so a
 * corrupt config must never fail closed when the env var is what actually
 * governs anyway. A `GBRAIN_HOME` itself so malformed that `configPath()`
 * throws is a distinct, pre-existing, unrelated failure mode (breaks far
 * more than just self-upgrade) and degrades the same way this resolver
 * always has for "can't even locate a config": the unpinned default.
 */
export function resolveConfiguredSelfUpgradeSource(): SelfUpgradeSourceResult {
  const envOverride = process.env.GBRAIN_SELF_UPGRADE_SOURCE;
  if (envOverride !== undefined) {
    return resolveSelfUpgradeSource(null, envOverride);
  }

  let path: string;
  try {
    path = configPath();
  } catch {
    return resolveSelfUpgradeSource(null, undefined);
  }

  let exists: boolean;
  try {
    exists = existsSync(path);
  } catch {
    exists = false;
  }
  if (!exists) {
    return resolveSelfUpgradeSource(null, undefined);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return {
      ok: false,
      error: `self_upgrade.source could not be resolved: config file exists but could not be read (${errMessage(e)})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: `self_upgrade.source could not be resolved: config file exists but is not valid JSON (${errMessage(e)})`,
    };
  }
  return resolveSelfUpgradeSource(parsed as { self_upgrade?: { source?: unknown } } | null, undefined);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Update-cache marker source binding (item 9 correction pass) ─────────────

/**
 * Compact identity token embedded in the self-upgrade update-cache marker,
 * binding a cached "latest version" result to the source it was checked
 * against. Same shape as the user-facing pin string (`owner/repo#ref`).
 */
export function sourceIdentityToken(s: SelfUpgradeSource): string {
  return `${s.owner}/${s.repo}#${s.ref}`;
}

/**
 * Whether a cache/marker's (possibly absent) source token is valid for the
 * CURRENTLY resolved source `resolved`.
 *
 *   - `resolved.ok === false` → nothing matches (an invalid configured
 *     source can't validate any cache entry; the caller must fail closed
 *     the same way every other surface does).
 *   - `token === undefined` → a LEGACY marker, written before source pinning
 *     existed (or by an older gbrain binary that never learned about it).
 *     Only trustworthy when NOTHING is pinned right now — the ordinary
 *     upstream case every legacy marker always meant. Once a source is
 *     pinned, a legacy/untagged entry is a cache MISS, never a silent
 *     accept, because it may have been written against upstream before the
 *     pin was introduced.
 *   - otherwise → exact string match against this source's identity token.
 */
export function sourceTokenMatchesResolved(token: string | undefined, resolved: SelfUpgradeSourceResult): boolean {
  if (!resolved.ok) return false;
  if (token === undefined) return !resolved.pinned;
  return token === sourceIdentityToken(resolved.source);
}
