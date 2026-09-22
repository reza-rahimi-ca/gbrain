# Connect GBrain to OpenClaw

> This page is the MCP-registration reference card. For the full brain install
> — CLI, engine, skills, dream cycle — follow
> [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md); the README covers the
> bootstrap and connect paths.

Two supported shapes, both stdio.

## Option 1: ClawHub bundle plugin

GBrain ships [`openclaw.plugin.json`](../../openclaw.plugin.json) at the repo
root. Installing the bundle plugin registers the MCP server for you — the
manifest carries an `mcpServers.gbrain` entry that runs the bundled
`.agents/gbrain-launcher serve` (the same launcher the Codex and Claude Code
plugins use; it resolves your installed `gbrain` via `GBRAIN_BIN`, then
`~/.bun/bin/gbrain`, then `PATH`, so it works under launchd's bare PATH and
never needs a build step) plus the bundled skills — and declares the
`gbrain-context` context engine. To route OpenClaw's context-engine slot
through gbrain, two steps, in this order:

1. Install and enable the plugin by its own id, `gbrain-context-engine`
   (the `id` in `openclaw.plugin.json`). Accept the declared capabilities
   when the CLI asks (`--accept-capabilities`).
2. Set the slot to the plugin id:

   ```
   plugins.slots.contextEngine = gbrain-context-engine
   ```

**The bundled server runs with a scrubbed environment.** OpenClaw spawns the
plugin's `gbrain serve` with only a handful of process variables (`HOME`,
`PATH`, `TMPDIR`, …) — no `DATABASE_URL`, no vendor API keys, no
`GBRAIN_SOURCE`, even when the gateway itself has them. Put the connection and
keys in gbrain's own config file instead, which every `gbrain` process reads:

```bash
gbrain config set database_url postgresql://...     # file plane: ~/.gbrain/config.json
gbrain config set openrouter_api_key ...            # or openai_api_key / anthropic_api_key / voyage_api_key
gbrain sources default <source-id>                  # write target when no GBRAIN_SOURCE pin is possible
```

A PGLite brain needs none of this. If a tool call answers `gbrain database URL
missing`, the bundled server started before the config landed — reload the
plugin and, if the old `gbrain serve` child survives, stop it; the harness
reconnects on the next request. Do not ALSO keep a hand-registered
`mcp.servers.gbrain` entry next to the plugin: that runs a second, identical
tool set under the same server name.

OpenClaw resolves the slot value as a plugin id: it force-activates that
plugin for every agent turn and then looks the engine up under the same id.
The plugin registers its engine under both `gbrain-context-engine` and the
legacy engine id `gbrain-context`, so either value works, but only the plugin
id also triggers activation on 2026.9+ hosts. If the slot names an id no
active plugin registered, the gateway logs `context engine "..." is not
registered` and degrades to `legacy` on every turn without changing your
config. `openclaw plugins doctor` warns `slot references missing plugin` for
the same mismatch.

## Option 2: `openclaw mcp add`

OpenClaw keeps MCP servers under `mcp.servers` in `~/.openclaw/openclaw.json`
(`openclaw config schema` shows the key path). Register gbrain with the CLI:

```bash
openclaw mcp add gbrain --command "$(command -v gbrain)" --arg serve --env GBRAIN_HOME=$HOME
```

Use an absolute `--command` path: the launchd-started gateway's `PATH` does
not include `~/.bun/bin`, so a bare `gbrain` fails to spawn. `--env` is
optional: a PGLite brain needs no `DATABASE_URL`
(`--env DATABASE_URL=postgresql://...` for Postgres), and `GBRAIN_HOME` only
matters when the brain home isn't `~/.gbrain`. For the seven-verb memory
protocol ([MEMORY_VERBS v1](../protocol/MEMORY_VERBS_v1.md)) instead of the
full operation catalog, pass `--surface verbs` as additional `--arg` values
(check `openclaw mcp add --help` for your version's spelling).

Leave `GBRAIN_SOURCE` unset in the MCP env unless you deliberately want
single-source retrieval: a pin scopes every tool (search, `get_brain_identity`
counts, …) to that one source, and nothing warns on reads.

## Verify

`openclaw mcp list` should show `gbrain`. Then start an agent turn and ask it
to use the brain:

```
Call get_brain_identity, then search my brain for [topic].
```

If the tools respond, the wiring works. `list_skills` shows everything the
brain can do (gated by `mcp.publish_skills` on the host).

OpenClaw 2026.9+ also requires a "durable admitted turn" contract from any
non-legacy engine: `info.transcriptSemantics` must declare
`currentTurnFence: "before-current-turn-entry-v1"` and
`turnAdvancementIdempotency: "atomic-idempotent-v1"`, and the engine must
implement `commitTurn()`. gbrain declares both and commits through a small
per-session idempotency ledger under `~/.gbrain/transcripts/turn-advancement/`
(the host transcript stays canonical; gbrain stores no turn content). If the
log says `degraded to "legacy" ... transcript fencing is not declared`, the
gateway is running an older gbrain plugin source — reload it.

For the context engine: after `openclaw plugins reload gbrain-context-engine`,
`openclaw gateway call plugins.inspect --params '{"pluginId":"gbrain-context-engine"}'`
should report the plugin as active, and `openclaw logs --plain` should stop
printing the `degraded to "legacy"` warning on the next turn.

## Remove

Delete `mcp.servers.gbrain` from `~/.openclaw/openclaw.json` (or run
`openclaw mcp remove gbrain` if your version has it), or uninstall the bundle
plugin.
