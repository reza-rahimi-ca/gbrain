# Upgrades and Auto-Update Notifications

## Goal

Users get notified of new GBrain features conversationally, and the agent walks them through upgrading with post-upgrade migrations that make the new version actually work.

## What the User Gets

Without this: GBrain ships updates but nobody knows. The user stays on an old
version with stale skills and missing features. Or worse, someone runs
`gbrain upgrade` but skips the post-upgrade steps, leaving new code with old
agent behavior.

With this: the agent checks for updates daily, sells the upgrade with punchy
benefit-focused bullets, waits for explicit permission, then runs the full
upgrade flow including re-reading skills, running migrations, and syncing
schema. The user gets new capabilities automatically.

## Self-upgrade modes

gbrain stays current the way gstack does: it rides invocation frequency. A
throttled, cache-read-only check runs at the start of every `gbrain` invocation
(CLI and MCP) and emits an `UPGRADE_AVAILABLE <old> <new>` marker on stderr. The
raw marker line is suppressed when stderr is an interactive TTY (a human sees
only the plain `gbrain X -> Y available` sentence, not the machine token); set
`GBRAIN_FORCE_UPGRADE_MARKER=1` if an agent harness parses the token but runs
under a PTY. `<old>` is always the RUNNING binary's version, so a stale or
foreign-written cache never nags about an upgrade this binary already has. No
host cron required — every agent kind (Claude Code, Codex, OpenClaw, Hermes, the
`gbrain serve` host behind a Perplexity thin client) converges to current by
construction. The behavior is governed by one file-plane config key,
`self_upgrade.mode`:

| Mode | Behavior | Who it's for |
|------|----------|--------------|
| `notify` (default) | Emit the marker + a 4-option prompt; never apply without confirmation. | Interactive installs / anyone with a human in the loop. |
| `auto` (opt-in) | Apply silently, but ONLY during quiet hours, ONLY when the brain is idle, doctor-gated, and never re-trying a known-bad version. | Headless / always-on installs (autopilot daemon, the `gbrain serve` host). |
| `off` | Never check. | Air-gapped / pinned installs. |

Enable hands-off upgrades on an always-on install with one line:

```bash
gbrain config set self_upgrade.mode auto
```

`auto` is deliberately NOT a default anywhere — it's an explicit autonomy grant,
because applying code from GitHub unattended is, by design, remote code
execution. The trust model is TLS + GitHub (same as `gbrain upgrade`);
signature verification is a tracked follow-up. Apply manually any time with
`gbrain self-upgrade`.

The `auto` quiet-hours window is configured via the
`self_upgrade.quiet_hours` config key
(`gbrain config set self_upgrade.quiet_hours '{"start":23,"end":8,"tz":"US/Pacific"}'`).
The quiet-hours *pattern* itself — gating any notification or background
action on the user's local sleep window — is owned by
[quiet-hours.md](quiet-hours.md); this doc only covers the self-upgrade
hook into it.

### Pinning to a fork/branch (`self_upgrade.source`)

By default every self-upgrade surface — version/release discovery, the
changelog diff, the Bun package-manager reinstall target, binary release
assets, and build-provenance/attestation identity — resolves against
upstream `garrytan/gbrain` on `master`. A fork that wants to stay on its own
branch (rather than eventually drifting back onto upstream) can pin all of
that to a specific GitHub `owner/repo` with an optional `#ref`:

```bash
gbrain config set self_upgrade.source reza-rahimi-ca/gbrain#feat/openrouter-only-install
```

- **Format:** `owner/repo` or `owner/repo#ref` (a git ref name; branch names
  containing `/`, like `feat/openrouter-only-install`, work correctly —
  everything after the first `#` is the ref). Omitting `#ref` defaults to
  `main` (GitHub's default branch name for new repos) — a fork whose default
  branch is something else (e.g. `master`) must say so explicitly. `ref` can
  name either a branch or a tag: the release-asset/changelog/Bun-install
  surfaces don't care which, and binary provenance verification accepts a
  build-provenance attestation triggered by either a branch push
  (`refs/heads/<ref>`) or a tag push (`refs/tags/<ref>`) for that exact ref
  string — see "Provenance and refs" below.
- **Type-strict, not just shape-strict.** A non-string `self_upgrade.source`
  in a hand-edited (or corrupted) `config.json` — a number, object, array,
  `null` — fails closed with an actionable error instead of crashing or being
  silently coerced. `GBRAIN_SELF_UPGRADE_SOURCE` set to an empty string
  (present in the environment but empty) ALSO fails closed rather than
  silently falling through to the file-plane config — an explicit env
  override that resolves to "nothing" is far more likely a mistake than a
  deliberate "ignore the env" signal. A file-plane `self_upgrade.source: ""`
  is different: that's the documented way to CLEAR a pin
  (`gbrain config set self_upgrade.source ""`), a deliberate file edit, so it
  degrades to "nothing configured," not a failure.
- **Escape hatch:** `GBRAIN_SELF_UPGRADE_SOURCE` env var overrides the
  file-plane config (same precedence pattern as `self_upgrade.mode`).
- **Every surface resolves the SAME source:** `gbrain check-update`, `gbrain
  self-upgrade [--check-only]`, `gbrain upgrade` (the `bun`, `bun-link`,
  `binary`, and `clawhub` install-method lanes, and the generic
  "could not detect install method" fallback), and the autopilot silent
  channel (which shells out to `gbrain upgrade --swap-only`, so it inherits
  this automatically) — see `src/core/self-upgrade-source.ts`.
- **Fails closed, never falls back to upstream.** A malformed or unsupported
  value (a URL instead of `owner/repo`, more than one `#`, an invalid
  owner/repo/ref segment, a non-string type) is rejected up front: the
  affected command refuses to fetch or install anything, prints an
  actionable error, AND exits non-zero — rather than silently
  checking/fetching upstream `garrytan/gbrain` or exiting 0 as if nothing
  were wrong. Unset (the default) behaves exactly as before this feature
  existed, including the exit code (an ordinary network hiccup still exits 0
  — `gbrain check-update` fails silently on THOSE by design; only a
  configuration problem is treated as a hard failure).
- **Missing config file vs. an existing-but-unreadable one are NOT the same
  failure mode.** `resolveConfiguredSelfUpgradeSource()` treats them
  differently on purpose:
  - **No `~/.gbrain/config.json` at all** (a fresh install, or one that has
    never touched config) is the ordinary unpinned case — resolves to the
    upstream default exactly as it always has. There is no pin to lose here.
  - **The file EXISTS but can't be read or isn't valid JSON** (disk
    corruption, a `chmod`-locked file, a botched hand-edit that leaves
    truncated/invalid JSON) fails CLOSED instead — it does NOT degrade to
    "nothing configured." A config file that exists might be hiding a real
    `self_upgrade.source` pin; silently falling back to the upstream default
    would un-pin a fork install with no signal to the operator, exactly the
    failure mode this whole feature exists to prevent. Every self-upgrade
    surface (check-update, `gbrain self-upgrade`, `gbrain upgrade`'s
    `bun`/`bun-link`/`binary`/`clawhub` lanes) refuses to fetch or install
    anything until the file is fixed or removed.
  - The `GBRAIN_SELF_UPGRADE_SOURCE` env override, when set, is checked
    FIRST and short-circuits entirely — it never even stats the config file,
    so a corrupt config never blocks a caller whose pin actually comes from
    the environment.
- **Bun installs:** when pinned, `gbrain upgrade` runs `bun add -g
  github:<owner>/<repo>#<ref>` explicitly (reinstalling from the pinned
  fork/branch) instead of the ordinary `bun update gbrain`, which re-resolves
  whatever the local `package.json` dependency spec currently says and could
  otherwise silently replace a pinned GitHub-branch install with the
  upstream package.
- **Bun-link (source-clone dev installs):** detection recognizes a `bun
  link`ed clone of the PINNED fork (not just upstream `garrytan/gbrain`) by
  matching the clone's `.git/config` remote against the resolved
  `owner/repo`. When pinned, `gbrain upgrade` additionally refuses to `git
  pull` a clone that isn't actually checked out on the pinned ref — a `git
  pull --ff-only` fast-forwards whatever branch is CURRENTLY checked out
  from ITS OWN upstream, which may not be the pinned ref, so an unchecked
  pull could silently track the wrong branch. The unpinned/default case is
  unchanged (no ref check), so an ordinary upstream dev clone on an
  arbitrary local branch keeps working as before.
- **ClawHub installs:** ClawHub has no fork/branch concept — it can only
  track the published upstream package. When pinned, `gbrain upgrade`
  refuses to run `clawhub update gbrain` (which would silently install
  upstream instead) and points at the pinned Bun GitHub target instead.
- **The generic "could not detect install method" fallback:** when pinned,
  the printed recovery hint names the pinned Bun target, never a bare `bun
  update gbrain` / upstream releases URL.
- **Binary installs:** the atomic binary swap fetches release assets from,
  and verifies build-provenance/attestation identity against, the pinned
  `owner/repo`'s own release workflow — never upstream's.

#### Provenance and refs

Binary-install integrity verification checks the downloaded asset's
build-provenance attestation against an EXPECTED builder id naming this
project's `.github/workflows/release.yml` on the configured ref. Because
`self_upgrade.source#ref` accepts any git ref name, and branch/tag names
share the same character set, the ref string alone can't say which kind it
is. This project's own `release.yml` only ever triggers on branch pushes
(pinned by `test/release-workflow.test.ts`); an arbitrary fork's workflow
could instead trigger on a tag push. Verification therefore accepts EITHER
`refs/heads/<ref>` or `refs/tags/<ref>` for the configured ref — this does
not broaden what's trusted (a match still requires the exact owner/repo, the
exact `release.yml` workflow path, AND the exact ref string; the trigger
kind is the only thing left open), it just avoids incorrectly rejecting a
genuine tag-triggered release from a fork whose workflow legitimately uses
tags.

#### Update-cache is bound to the configured source

The file-plane update-cache marker (`~/.gbrain/last-update-check`, read by
the CLI startup hook, `gbrain doctor`, the advisor, and `get_brain_identity`,
and written by `gbrain check-update` / `gbrain self-upgrade`) is bound to the
`self_upgrade.source` it was resolved against, so a marker written for one
source can never be silently consumed after the pin changes:

- An ordinary (unpinned) write keeps the EXACT legacy marker shape — no
  extra token — for maximum backward/forward compatibility with older
  gbrain binaries reading the same cache file.
- A PINNED write appends a compact `owner/repo#ref` identity token.
- A legacy (untagged) marker is valid ONLY when nothing is currently pinned
  — once a source is pinned, an untagged or mismatched-source entry is
  treated exactly like a missing cache (re-checked, never acted on), both by
  the CLI startup notify path and by the autopilot silent channel.
- A refresh that fails (offline, `invalid_source`, …) never "preserves"
  (bumps the mtime of) a prior marker written for a DIFFERENT source than
  the one currently configured — there is no last-known-good data for a
  newly configured source yet, so the stale foreign-source entry is left
  untouched rather than kept artificially fresh.

## Implementation

### The Check (cron-initiated)

```
check_for_update():
  result = run("gbrain check-update --json")

  if not result.update_available:
    exit_silently()  // do NOT message the user

  // Sell the upgrade — lead with what they can DO, not what changed
  message = compose_upgrade_message(
    current: result.current_version,
    latest: result.latest_version,
    changelog: result.changelog
  )
  send_to_user(message, respect_quiet_hours=true)
```

### The Upgrade Message

Sell the upgrade. The user should feel "hell yeah, I want that." Lead with
what they can DO now that they couldn't before, not what files changed.

```
> **GBrain vX.Y.Z is available** (you're on vX.Y.W)
>
> What's new:
> - Your brain never falls behind. Live sync keeps the vector DB current
>   automatically, so edits show up in search within minutes
> - New verification runbook catches silent failures before they bite you
> - New installs set up live sync automatically. No more manual setup step
>
> Want me to upgrade? I'll update everything and refresh my playbook.
>
> (Reply **yes** to upgrade, **not now** to skip, **weekly** to check
> less often, or **stop** to turn off update checks)
```

### Handling Responses

| User says | Action |
|-----------|--------|
| yes / y / sure / ok / do it / upgrade | Run the full upgrade flow (below) |
| not now / later / skip / snooze | Acknowledge, check again next cycle |
| weekly | Store preference, switch cron to weekly |
| daily | Store preference, switch cron back to daily |
| stop / unsubscribe / no more | Disable the cron. Tell user how to resume |

**In `notify` mode (the default), never auto-upgrade — always wait for explicit
confirmation.** The `auto` mode (opt-in, see "Self-upgrade modes" above) is the
only path that applies without a prompt, and only under its conservative gates
(quiet hours + idle + doctor-gate). This per-cron-prompt flow is the `notify`
experience.

### The Full Upgrade Flow (after user says yes)

```
full_upgrade():
  // Step 1: Update the binary/package
  run("gbrain upgrade")

  // Step 2: Re-read all updated skills
  for skill in find("skills/*/SKILL.md"):
    read_and_internalize(skill)  // updated skills = better agent behavior

  // Step 3: Re-read production reference docs
  read("docs/GBRAIN_SKILLPACK.md")
  read("docs/GBRAIN_RECOMMENDED_SCHEMA.md")

  // Step 4: Check for version-specific migration directives
  for version in range(old_version, new_version):
    migration = find(f"skills/migrations/v{version}.md")
    if migration exists:
      read_and_execute(migration)  // in order, don't skip

  // Step 5: Schema sync — suggest new, respect declined
  state = read("~/.gbrain/upgrade-state.json")
  for recommendation in new_schema_recommendations:
    if recommendation not in state.declined:
      suggest_to_user(recommendation)
  update(state, new_choices)

  // Step 6: Report what changed
  summarize_to_user(actions_taken)
```

### Migration Files

Migration files live at `skills/migrations/vX.Y.Z.md`. They contain agent
instructions (not scripts) for post-upgrade actions that make the new version
work for existing users. Example: a migration that sets up live sync and
runs the verification runbook.

The agent reads migration files in version order and executes them step by
step. Without migrations, the agent has new code but the user's environment
hasn't changed.

### Cron Registration

```
Name: gbrain-update-check
Default schedule: 0 9 * * * (daily 9 AM)
Weekly schedule: 0 9 * * 1 (Monday 9 AM)
Prompt: "Run gbrain check-update --json. If update_available is true,
  summarize the changelog and message me asking if I'd like to upgrade.
  If false, stay silent."
```

### Frequency Preferences

Default: daily. Store in agent memory as `gbrain_update_frequency: daily|weekly|off`.
Also persist in `~/.gbrain/upgrade-state.json` so it survives agent context resets
(the runtime's own bookkeeping lives beside it as `~/.gbrain/last-update-check`
and `~/.gbrain/update-snoozed`).

### Standalone Skillpack Users

If you loaded this SKILLPACK directly (copied or read from GitHub) without
installing gbrain, you can still stay current. Both GBRAIN_SKILLPACK.md and
GBRAIN_RECOMMENDED_SCHEMA.md carry a `<!-- source: ... -->` header pointing
at their canonical copies, and GBRAIN_RECOMMENDED_SCHEMA.md also carries a
version marker:

```bash
curl -s https://raw.githubusercontent.com/garrytan/gbrain/master/docs/GBRAIN_RECOMMENDED_SCHEMA.md | head -1
# Returns: <!-- schema-version: X.Y.Z -->
```

If the remote version is newer (or the remote SKILLPACK content differs from
your local copy), fetch the full file and replace your local copy. Set up a
weekly cron to check automatically.

## Tricky Spots

1. **In `notify` mode, never auto-install.** The upgrade waits for the user's
   explicit "yes." Even if the check detects an update and the changelog looks
   great, the agent messages the user and waits. The `auto` mode (opt-in) exists
   for headless/always-on installs where there's no human to prompt — it applies
   only during quiet hours, only when idle, doctor-gated, never retrying a
   known-bad version. Don't enable `auto` on an interactive workstation; the
   prompt-first `notify` flow is the right default there.

2. **Migration files are agent instructions, not scripts.** They tell the agent
   what to do step by step in plain language. They are NOT bash scripts to
   execute blindly. The agent reads them, understands the context, and adapts
   to the user's specific environment (e.g., skip a step if the user already
   has live sync configured).

3. **check-update should run on a daily cron.** Don't rely on the user
   remembering to check for updates. The cron runs `gbrain check-update --json`
   daily at 9 AM (respecting quiet hours). If there's nothing new, it stays
   completely silent. The user only hears about updates when there IS something
   worth upgrading to.

## How to Verify

1. **Run check-update and verify detection.** Execute
   `gbrain check-update --json`. Verify it returns the current version and
   correctly reports whether an update is available. If `update_available`
   is false, verify the version matches the latest release on GitHub.

2. **Verify migration files are readable.** List `skills/migrations/` and
   check that each file follows the naming convention `vX.Y.Z.md`. Open one
   and verify it contains step-by-step agent instructions, not raw scripts.
   The agent should be able to read and execute each step.

3. **Test the full upgrade flow end-to-end.** If an update is available, say
   "yes" and watch the agent execute the full flow: upgrade, re-read skills,
   run migrations, sync schema, report. Verify each step completes and the
   agent reports what changed.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
