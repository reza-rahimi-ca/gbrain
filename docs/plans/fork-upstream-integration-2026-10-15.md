# Fork integration onto upstream stable, 2026-10-15

## Baseline and scope

- Base: upstream `v0.60.243.0` / `latest-stable`, commit `ab1f28a78590d89e2847ad4ecd3b8eaf68363324`.
- No upstream release/stable branch was published at the time of inspection. The published stable release tag is used instead of development master.
- Integration branch: `feat/gbrain-upstream-integration-20261015`, separate worktree. The original fork checkout is preserved.
- Launcher environment change committed on the original branch as `19c0e24db`, then cherry-picked here as `a134878f0`.
- This is a staged source integration, not a deployed or production-ready upgrade. No live configuration, schema, persistence mode, credentials or services were changed. Nothing has been pushed.

## Ports implemented

| Area | Included behavior | Fork provenance |
| --- | --- | --- |
| OpenRouter embeddings | Voyage 4 family IDs, 1024 default width and pricing; canonical Voyage selection; per-model widths retained for other routes | `ce15f2406`, `22e78a091`, `c32c19dd6` |
| OpenRouter rerank transport | Explicit Voyage 2.5 / 2.5-lite routes accepted and tested; default selection remains pending | `ce15f2406` |
| Model defaults | OpenRouter-only Anthropic chat tiers after native Anthropic/OpenAI precedence; runtime expansion defaults without writing pins | `d94a8a730`, `1e0b8b32b` |
| Configuration | Provider environment-name aliases map to the existing file-plane key table; init and provider diagnostics fold file keys consistently | `fcb3213d4`, `43ac1a2d0`, `caf444dfb` |
| Provider advice | Keep a healthy explicit embedding provider/model; recognize an OpenRouter-only setup; report model-specific dimensions | `f7710ebcb` |
| Self-invocation | Prefer the running executable for worker/wrapper paths, argv-based upgrades and skillify checks, package-local postinstall CLI | `320d85d09` |
| Supervisor detection | Injectable user-session/linger detection without treating unrelated degraded units as no systemd | `59953394e` |
| Google | One per-sweep Gmail pacer across all thread fetch paths; optional loops judge model and OpenRouter DeepSeek reasoning-off option | `dca300258` |
| Loop pricing | Current exact OpenRouter V4.1 Flash catalog rate, not the old fork's stale native-vendor rate | `dca300258` adapted |

The embedding recipe uses the canonical Voyage model's supported dimension choices and conservative 120K aggregate request cap. This corrects stale OpenAI-specific metadata carried by the old fork while preserving explicitly configured models.

## Upstream retained instead of old patches

- OpenClaw compatibility (`0dd961f6a`): upstream already registers both context-engine IDs and includes newer transcript lifecycle support.
- Expired People sync tokens (part of `dca300258`): upstream handles HTTP 400 plus structured token-expiry details. No duplicate message-only patch.
- Persistence JSON serialization (`6146564c2`): upstream casts status and binding epochs/generations to text, and stringifies prepared transfer epochs in ownership.ts.
- Model role names (`49e024b25`): upstream gateway already resolves `models.chat` and `models.expansion`. The fork's automatic file-to-DB migration is not reintroduced; existing explicit role keys remain usable.
- Old baseline-failure notes, stale test repairs, and blanket size-ratchet increases are not replayed. Current tests and guards determine the new baseline.
- The old PATH-diagnostic wording extension is not necessary for correct self-invocation and is not carried.
- Google's upstream eligibility rules, recent-thread sampling, managed-write preflight, daily spend authorization, and bounded 2048/8192 output retry are retained. The old unlimited output change is not replayed.

## Decisions requested, unresolved

1. **OpenRouter-only reranker default:** preserve fork `rerank-2.5`, or adopt upstream's `rerank-3-lite` model family through OpenRouter? Existing explicit overrides must remain untouched. Key-aware search-mode, init and doctor integration awaits this choice (`ffd7a6fea`, `60f34473e`).
2. **Connector activation guard:** keep the fork's hard refusal when connector sources exist, or rely on upstream's newer connector-aware managed persistence? No live activation is authorized (`4024e838e`).
3. **Fork-pinned updater:** current deployment has self-upgrade off and no source pin. Defer the large custom updater, or port its full source-pinning and attestation behavior onto the new upstream upgrade machinery (`efe663533`)?
4. **Unmanaged Postgres write-through:** the old compatibility path is NOT in this branch yet (`cf1f1d9d0`). Upstream still refuses writes to unowned file-backed sources. Include an adapted compatibility port before deployment, or leave this branch staged? This is a deployment blocker for unchanged unmanaged write behavior, not proof that upstream's new persistence is interchangeable.

## Validation

All commands run with an isolated HOME/GBRAIN_HOME and no live DB or provider keys. Google uses a fake API and in-memory PGLite. Provider calls use injected transports. Serial tests run in their own process.

- The new provider compatibility tests failed on upstream's original baseline (5 failures), then passed after porting.
- Provider/config/init/pricing suites: 170 passed across 8 files.
- Operational/path/postinstall suites: 98 passed across 5 files.
- Google units: 47 passed across 4 files; extraction serial suite: 23 passed.
- Model-config serial suite: 46 passed; config-set suite: 51 passed. Extended operational/provider-env suites: 71 passed (includes a repeated thin-client suite).
- 455 focused tests passed across 23 distinct files (repeat runs counted once per file).
- Verification: 77/79 checks initially passed, including typecheck. Both failures were stale generated launcher copies. Regenerating the two persona launchers made plugin-tree and regen-all pass; all 79 checks now have passing results. Shell syntax and git diff whitespace checks also passed.
- Module-size, function-size, test-isolation, recipe-pricing and orphan-module guards passed after the helper extraction and explicit small ceiling updates.
- Full unit matrix, PostgreSQL E2E and real-provider smoke tests have not been run. No deployment readiness is claimed.

Public pricing evidence: [OpenRouter V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash) and its unauthenticated `/api/v1/models` catalog, checked 2026-10-15.
