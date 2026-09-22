/**
 * OpenClaw plugin entry point for gbrain-context engine.
 *
 * Registers a deterministic context engine that injects live temporal/spatial
 * context on every turn. Prevents the "time warp" bug class where compacted
 * sessions lose track of the user's current time, location, and state.
 *
 * Enable in openclaw.json:
 *   plugins.slots.contextEngine: "gbrain-context-engine"
 *
 * The slot value is a PLUGIN id on current OpenClaw hosts (2026.9+): the host
 * force-activates the plugin named by the slot and then resolves the engine
 * under that same id. Older hosts keyed the slot by ENGINE id
 * (`gbrain-context`). `register()` therefore registers the engine under both
 * ids, so either slot value activates and resolves gbrain.
 *
 * @module
 */

/**
 * OpenClaw plugin entry — registers gbrain-context engine.
 *
 * This file is discovered via the `openclaw.extensions` field in package.json.
 * It requires the OpenClaw plugin SDK at runtime (available when loaded by the
 * gateway). The core engine logic in `./core/context-engine.ts` is SDK-free
 * and independently testable.
 */

import { createGBrainContextEngine, ENGINE_ID } from './core/context-engine.ts';
import type { ResolveEntitiesFn } from './core/context/reflex.ts';

/**
 * Plugin-entry shape consumed by the OpenClaw host. The host's plugin loader
 * reads `id`, `name`, `description`, and `register` directly off the default
 * export — pre-v0.32.5 we wrapped this in `definePluginEntry` from the
 * OpenClaw plugin SDK, but that created an unnecessary build-time import of
 * a runtime-only package. The wrapper was a type-tag (no behavior), so the
 * bare object is equivalent at the host's consumption point. Codex outside-
 * voice F1 flagged the SDK import as the gate keeping the e2e test brittle;
 * removing it unblocks `mock.module()`-based plugin-shape testing AND removes
 * a class of module-load failures in non-Node-resolving runtimes.
 */
interface PluginEntry {
  id: string;
  name: string;
  description: string;
  register(api: PluginApi): void;
}

interface PluginApi {
  registerContextEngine(id: string, factory: (ctx: PluginCtx) => unknown): void;
}

interface PluginCtx {
  workspaceDir: string;
  /**
   * Retrieval Reflex (#1981, D1=A): OPTIONAL host-provided resolve capability.
   * When the OpenClaw host supplies it (backed by the gbrain connection the
   * gateway already holds), the deterministic pointer layer resolves through it
   * — works on every engine, including PGLite where a second connection is
   * impossible. Narrow by contract: candidates in, a pointer block out (no raw
   * SQL crosses the boundary). Absent → the engine falls to the serve-IPC /
   * Postgres-direct ladder. Additive + guarded, so older hosts (which don't
   * provide it) keep working unchanged — no pluginApi floor bump needed.
   */
  resolveEntities?: ResolveEntitiesFn;
  /** Back-compat alias some hosts may use for the same capability. */
  brainQuery?: ResolveEntitiesFn;
  [key: string]: unknown;
}

/** Plugin id — must match `id` in `openclaw.plugin.json`. */
export const PLUGIN_ID = 'gbrain-context-engine';

/**
 * Every id `register()` binds the engine to. OpenClaw 2026.9+ pins
 * `plugins.slots.contextEngine` by plugin id and looks the engine up under
 * that id (`resolveSlotSelection` → `pluginId`; `entries.get(slot)` at turn
 * time), so an engine registered ONLY as `gbrain-context` is never activated:
 * the host logs `context engine "gbrain-context" is not registered` and
 * degrades to `legacy` every turn. Older hosts keyed the slot by engine id.
 * Registering both keeps either slot value working.
 */
export const REGISTERED_ENGINE_IDS: readonly string[] = [...new Set([ENGINE_ID, PLUGIN_ID])];

export function register(api: PluginApi) {
  const factory = (ctx: PluginCtx) => {
    const hostResolver =
      typeof ctx.resolveEntities === 'function'
        ? ctx.resolveEntities
        : typeof ctx.brainQuery === 'function'
          ? ctx.brainQuery
          : undefined;
    return createGBrainContextEngine({
      workspaceDir: ctx.workspaceDir,
      resolveEntities: hostResolver,
    });
  };
  for (const id of REGISTERED_ENGINE_IDS) api.registerContextEngine(id, factory);
}

const entry: PluginEntry = {
  id: PLUGIN_ID,
  name: 'GBrain Context Engine',
  description: 'Deterministic temporal/spatial context injection on every turn',
  register,
};

export default entry;
