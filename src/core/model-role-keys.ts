/**
 * Dependency-free model-role key metadata.
 *
 * Split out of model-config.ts (defect-1 fix) so `commands/config.ts` can
 * read this metadata without statically importing model-config.ts, which
 * itself imports config.ts. commands/config.ts is a very early-loaded CLI
 * entry point; giving it a static edge into model-config.ts's larger
 * transitive graph (config.ts, ai/provider-env.ts, ai/recipes/index.ts,
 * ai/openai-latest.ts, ...) is a shared-process module-initializer hazard
 * this file exists to avoid. This module must stay leaf-level: no import of
 * config.ts or model-config.ts, ever.
 */

/** Model routing tier. Kept here (not in model-config.ts) because the
 *  role-key tables below are typed against it; model-config.ts re-exports
 *  this so existing `import type { ModelTier } from './model-config.ts'`
 *  call sites are unaffected. */
export type ModelTier = 'utility' | 'reasoning' | 'deep' | 'subagent';

/** The flat file-plane model-role keys, deprecated in favor of the
 *  canonical DB-plane role keys. */
export type ModelRoleFlatKey = 'expansion_model' | 'chat_model';

/**
 * Single source for the flat-key -> canonical-key mapping (and back). Read by
 * `migrateFlatModelRoleKey` (model-config.ts, the runtime migration) and by
 * `gbrain config set/get/unset` (commands/config.ts) — one table so the
 * CLI's deprecation message and the migration's target key can never drift
 * apart.
 */
export const DEPRECATED_MODEL_ROLE_KEYS: Readonly<Record<string, { canonicalKey: string; tier: ModelTier }>> = {
  expansion_model: { canonicalKey: 'models.expansion', tier: 'utility' },
  chat_model: { canonicalKey: 'models.chat', tier: 'reasoning' },
};

/** Reverse of `DEPRECATED_MODEL_ROLE_KEYS`: canonical key -> flat key + tier. */
export const MODEL_ROLE_CANONICAL_KEYS: Readonly<Record<string, { flatKey: ModelRoleFlatKey; tier: ModelTier }>> = {
  'models.expansion': { flatKey: 'expansion_model', tier: 'utility' },
  'models.chat': { flatKey: 'chat_model', tier: 'reasoning' },
};
