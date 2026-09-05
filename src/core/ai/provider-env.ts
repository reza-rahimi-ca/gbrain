/**
 * mergedProviderEnv — THE canonical provider-key/env fold.
 *
 * One function owns the mapping from file-plane config keys
 * (`~/.gbrain/config.json`) to the env names the recipes read, the
 * env-wins-for-real-values merge, and the GEMINI alias. Consumers:
 *
 *   - `buildGatewayConfig` (src/core/ai/build-gateway-config.ts) — gateway env
 *   - `detectCapabilities` (src/core/capability.ts) — capability probe
 *   - `resolveTierDefault` / `resolveEffectiveChatModel`
 *     (src/core/model-config.ts) — key-aware model resolution
 *
 * Rules folded in from the two prior copies:
 *   - #1249: process/injected env wins over config-plane fallbacks, but ONLY
 *     for keys carrying a real value. Launchers inject `ANTHROPIC_API_KEY=''`
 *     to neuter subprocess LLM calls; an unconditional spread would let that
 *     empty string clobber a valid config.json key. '' and undefined are
 *     dropped; '0' and 'false' are legitimate values and survive.
 *   - GEMINI_API_KEY alias: Google's docs/SDKs export GEMINI_API_KEY, but the
 *     google recipe reads GOOGLE_GENERATIVE_AI_API_KEY. Precedence: env
 *     GOOGLE_GENERATIVE_AI_API_KEY > env GEMINI_API_KEY > config
 *     google_api_key — the alias is still process-env, so it beats the
 *     config-plane fallback but never the canonical env name.
 *   - Azure OpenAI (keyless/Entra): non-secret endpoint/deployment + the
 *     Entra opt-in fold so the azure-openai recipe works in any shell. The
 *     bearer token is minted at request time via `az`; no secret stored.
 */

import type { GBrainConfig } from '../config.ts';

/**
 * File-plane config key → the env name its recipe reads. THE table behind the
 * API-key half of `mergedProviderEnv` AND the `gbrain config set <ENV_NAME>`
 * alias (`OPENROUTER_API_KEY` → `openrouter_api_key`), so a key that resolves
 * here is by construction one the runtime folds — no surface can accept a
 * spelling the resolver ignores. `FILE_PLANE_API_KEYS` (src/commands/config.ts)
 * is derived from this table. The non-secret Azure endpoint/deployment/Entra
 * fields fold separately below (they are not API keys).
 */
export const PROVIDER_KEY_ENV_NAMES: Readonly<Record<string, string>> = Object.freeze({
  openai_api_key: 'OPENAI_API_KEY',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  zeroentropy_api_key: 'ZEROENTROPY_API_KEY',
  openrouter_api_key: 'OPENROUTER_API_KEY',
  voyage_api_key: 'VOYAGE_API_KEY',
  dashscope_api_key: 'DASHSCOPE_API_KEY',
  // LiteLLM + Together closed alongside litellm's chat touchpoint
  // (v0.42.61.0 made litellm a full chat provider, so the config-plane gap
  // started biting daemon/launchd/MCP contexts the same way voyage's #2662 did).
  litellm_api_key: 'LITELLM_API_KEY',
  together_api_key: 'TOGETHER_API_KEY',
  google_api_key: 'GOOGLE_GENERATIVE_AI_API_KEY',
  // #4031: the Azure key was the only member of the group left unfolded, so a
  // config.json-only setup failed every embed from keyless shells
  // (launchd/cron/MCP) while `config show` looked complete.
  azure_openai_api_key: 'AZURE_OPENAI_API_KEY',
});

/**
 * The file-plane config key whose value the runtime folds into `envName`
 * (`'OPENROUTER_API_KEY'` → `'openrouter_api_key'`), or null when `envName`
 * is not a provider API-key env name. Exact match — env names are
 * case-sensitive, and the GEMINI alias is a READ-side convenience only.
 */
export function fileplaneKeyForProviderEnvName(envName: string): string | null {
  for (const [configKey, name] of Object.entries(PROVIDER_KEY_ENV_NAMES)) {
    if (name === envName) return configKey;
  }
  return null;
}

export function mergedProviderEnv(
  cfg: GBrainConfig | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const fromConfig: Record<string, string> = {};
  for (const [configKey, envName] of Object.entries(PROVIDER_KEY_ENV_NAMES)) {
    const v = (cfg as Record<string, unknown> | null)?.[configKey];
    if (typeof v === 'string' && v) fromConfig[envName] = v;
  }
  if (cfg?.azure_openai_endpoint) fromConfig.AZURE_OPENAI_ENDPOINT = cfg.azure_openai_endpoint;
  if (cfg?.azure_openai_deployment) fromConfig.AZURE_OPENAI_DEPLOYMENT = cfg.azure_openai_deployment;
  if (cfg?.azure_openai_use_entra) fromConfig.AZURE_OPENAI_USE_ENTRA = cfg.azure_openai_use_entra;

  const envReal = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  ) as Record<string, string>;
  const merged = { ...fromConfig, ...envReal };
  if (!envReal.GOOGLE_GENERATIVE_AI_API_KEY && envReal.GEMINI_API_KEY) {
    merged.GOOGLE_GENERATIVE_AI_API_KEY = envReal.GEMINI_API_KEY;
  }
  return merged;
}
