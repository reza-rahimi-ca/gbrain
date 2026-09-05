/**
 * OPENROUTER_API_KEY present ONLY in ~/.gbrain/config.json (`openrouter_api_key`,
 * as `gbrain config set OPENROUTER_API_KEY …` writes it) — NOT in the process
 * env. Every key-aware surface must resolve it through the ONE fold
 * (`mergedProviderEnv`, env > file plane) and agree:
 *
 *   - the chat tiers resolve to the OpenRouter defaults (no `[models] … has no
 *     usable provider key` warning, and a persisted init-era pin stays servable)
 *   - `providers explain` sees the key, marks the openrouter rows ready and
 *     recommends the one-key setup
 *   - the reranker default resolves to the OR-proxied rerank-2.5, ready
 *   - init's Tier-3 detection sees openrouter ready for expansion AND chat
 *
 * Pre-fix `providers explain` and init's expansion/chat detection read bare
 * process.env, so a config.json-keyed brain looked keyless on those surfaces
 * while search, doctor and the gateway resolved the key fine.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveTierDefault,
  resolveEffectiveChatModel,
  resolveEffectiveExpansionModel,
  OPENROUTER_TIER_DEFAULTS,
} from '../src/core/model-config.ts';
import { loadConfig, loadConfigFileOnly } from '../src/core/config.ts';
import { PROVIDER_KEY_ENV_NAMES, mergedProviderEnv } from '../src/core/ai/provider-env.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { OPENROUTER_DEFAULT_RERANKER_MODEL } from '../src/core/ai/defaults.ts';
import { resolveDefaultRerankerModel } from '../src/core/ai/reranker-readiness.ts';
import { providerEnvPlane, detectProviderEnv, envReady, pickRecommended } from '../src/commands/providers.ts';
import { groupReadyByProvider, _exports_for_test } from '../src/commands/init.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

const NO_KEYS_IN_ENV = {
  ...Object.fromEntries(Object.values(PROVIDER_KEY_ENV_NAMES).map((n) => [n, undefined])),
  GEMINI_API_KEY: undefined,
  GROQ_API_KEY: undefined,
  DEEPSEEK_API_KEY: undefined,
  GBRAIN_MODEL: undefined,
  DATABASE_URL: undefined,
  GBRAIN_DATABASE_URL: undefined,
} as Record<string, undefined>;

/** A home whose config.json carries the key (and optionally an init-era expansion pin). */
function homeWithConfigKey(extra: Record<string, unknown> = {}): string {
  const home = emptyHome();
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      openrouter_api_key: 'sk-or-file-plane',
      ...extra,
    }),
  );
  return home;
}

async function captureStderr(fn: () => Promise<void> | void): Promise<string> {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

describe('OPENROUTER_API_KEY only in config.json — one resolver, every surface agrees', () => {
  test('the fold sees it, and the chat tiers resolve to the OpenRouter defaults with no warning', async () => {
    const home = homeWithConfigKey();
    await withEnv({ ...NO_KEYS_IN_ENV, GBRAIN_HOME: home }, async () => {
      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
      const fileCfg = loadConfigFileOnly();
      expect(mergedProviderEnv(fileCfg, process.env).OPENROUTER_API_KEY).toBe('sk-or-file-plane');

      // resolveTierDefault with NO injected env computes the merged plane itself.
      for (const tier of ['utility', 'reasoning', 'deep', 'subagent'] as const) {
        expect(resolveTierDefault(tier)).toBe(OPENROUTER_TIER_DEFAULTS[tier]);
      }

      const err = await captureStderr(() => {
        const chat = resolveEffectiveChatModel(loadConfig(), process.env);
        expect(chat).toEqual({ model: OPENROUTER_TIER_DEFAULTS.reasoning, source: 'tier_default' });
        const expansion = resolveEffectiveExpansionModel(loadConfig(), process.env);
        expect(expansion).toEqual({ model: OPENROUTER_TIER_DEFAULTS.utility, source: 'tier_default' });
      });
      expect(err).not.toContain('[models]');
    });
  });

  test('a brain that already persisted the init-era expansion pin keeps working unchanged (servable file pin, no warning)', async () => {
    const home = homeWithConfigKey({ expansion_model: 'openrouter:anthropic/claude-haiku-4.5' });
    await withEnv({ ...NO_KEYS_IN_ENV, GBRAIN_HOME: home }, async () => {
      const err = await captureStderr(() => {
        const expansion = resolveEffectiveExpansionModel(loadConfig(), process.env);
        expect(expansion).toEqual({ model: 'openrouter:anthropic/claude-haiku-4.5', source: 'file_pin' });
      });
      expect(err).not.toContain('has no usable provider key');
    });
  });

  test('providers explain: env_detected, the openrouter rows, and the recommendation all see the config-plane key', async () => {
    const home = homeWithConfigKey();
    await withEnv({ ...NO_KEYS_IN_ENV, GBRAIN_HOME: home }, async () => {
      const plane = providerEnvPlane();
      expect(plane.OPENROUTER_API_KEY).toBe('sk-or-file-plane');
      const detected = detectProviderEnv(plane);
      expect(detected.OPENROUTER_API_KEY).toBe(true);
      expect(detected.VOYAGE_API_KEY).toBe(false);
      expect(detected.ANTHROPIC_API_KEY).toBe(false);
      // Every openrouter row (embedding / expansion / chat) renders ready.
      expect(envReady(getRecipe('openrouter')!, plane)).toBe(true);
      expect(envReady(getRecipe('voyage')!, plane)).toBe(false);
      expect(envReady(getRecipe('anthropic')!, plane)).toBe(false);
      const rec = pickRecommended(
        [{ id: 'voyage:voyage-4', touchpoint: 'embedding', model: 'voyage-4', env_ready: false, tier: 'native', pros: [], cons: [] },
         { id: 'openrouter:voyageai/voyage-4', touchpoint: 'embedding', model: 'voyageai/voyage-4', env_ready: true, tier: 'native', pros: [], cons: [] }],
        detected,
        false,
      );
      expect(rec.id).toBe('openrouter:voyageai/voyage-4');
    });
  });

  test('the reranker bundle default resolves to the OR-proxied rerank-2.5, ready', async () => {
    const home = homeWithConfigKey();
    await withEnv({ ...NO_KEYS_IN_ENV, GBRAIN_HOME: home }, async () => {
      const r = resolveDefaultRerankerModel(mergedProviderEnv(loadConfigFileOnly(), process.env));
      expect(r.model).toBe(OPENROUTER_DEFAULT_RERANKER_MODEL);
      expect(r.readiness.ready).toBe(true);
      expect(r.keyAware).toBe(true);
    });
  });

  test('init Tier-3 detection sees openrouter ready for expansion AND chat (same fold as the embedding pick)', async () => {
    const home = homeWithConfigKey();
    await withEnv({ ...NO_KEYS_IN_ENV, GBRAIN_HOME: home }, async () => {
      const env = await _exports_for_test.initProviderEnv();
      expect(env.OPENROUTER_API_KEY).toBe('sk-or-file-plane');
      for (const tp of ['embedding', 'expansion', 'chat'] as const) {
        const ready = await groupReadyByProvider(tp, env);
        expect(ready.map((p) => p.recipeId)).toEqual(['openrouter']);
      }
    });
  });

  test('env still wins over the file plane for a real value; an empty env value does not clobber it', async () => {
    const home = homeWithConfigKey();
    await withEnv({ ...NO_KEYS_IN_ENV, GBRAIN_HOME: home, OPENROUTER_API_KEY: 'sk-or-env' }, async () => {
      expect(providerEnvPlane().OPENROUTER_API_KEY).toBe('sk-or-env');
    });
    await withEnv({ ...NO_KEYS_IN_ENV, GBRAIN_HOME: home, OPENROUTER_API_KEY: '' }, async () => {
      expect(providerEnvPlane().OPENROUTER_API_KEY).toBe('sk-or-file-plane');
    });
  });
});
