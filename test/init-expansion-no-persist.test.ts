/**
 * init Tier-3 expansion detection — no-persist for providers with a key-aware
 * tier default.
 *
 * An OPENROUTER_API_KEY-only `gbrain init` used to persist
 * `expansion_model: openrouter:anthropic/claude-haiku-4.5` into config.json.
 * The spec is: resolve the OpenRouter defaults AT RUNTIME when it is the only
 * chat-capable key (model-config.ts resolveTierDefault) and write no model
 * pin — a pin freezes the provider choice and, once the key moves, produces
 * the "[models] configured expansion_model … has no usable provider key" warn.
 * The same rule already governed chat_model (resolveChatByEnv, v0.46.21.0).
 *
 * Providers WITHOUT a runtime default (groq, deepseek, google, …) keep the
 * pin: for them it is the only way expansion runs on that provider at all.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { _exports_for_test, type ResolvedAIOptions } from '../src/commands/init.ts';
import { hasKeyAwareTierDefault, OPENROUTER_TIER_DEFAULTS, PROVIDER_TIER_DEFAULTS } from '../src/core/model-config.ts';
import { PROVIDER_KEY_ENV_NAMES } from '../src/core/ai/provider-env.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

const { resolveExpansionByEnv } = _exports_for_test;

const NO_KEYS = {
  ...Object.fromEntries(Object.values(PROVIDER_KEY_ENV_NAMES).map((n) => [n, undefined])),
  GEMINI_API_KEY: undefined,
  GROQ_API_KEY: undefined,
  DEEPSEEK_API_KEY: undefined,
  MOONSHOT_API_KEY: undefined,
  MISTRAL_API_KEY: undefined,
  ZHIPUAI_API_KEY: undefined,
  MINIMAX_API_KEY: undefined,
  DATABASE_URL: undefined,
  GBRAIN_DATABASE_URL: undefined,
} as Record<string, undefined>;

async function captureErr(fn: () => Promise<void>): Promise<string> {
  const orig = console.error;
  let err = '';
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return err;
}

describe('resolveExpansionByEnv — no-persist contract for key-aware providers', () => {
  test('hasKeyAwareTierDefault mirrors PROVIDER_TIER_DEFAULTS (anthropic, openai, openrouter)', () => {
    for (const entry of PROVIDER_TIER_DEFAULTS) expect(hasKeyAwareTierDefault(entry.provider)).toBe(true);
    expect(hasKeyAwareTierDefault('OpenRouter')).toBe(true);
    expect(hasKeyAwareTierDefault('groq')).toBe(false);
    expect(hasKeyAwareTierDefault('google')).toBe(false);
  });

  test('OPENROUTER_API_KEY alone → detected, runtime default named, NOTHING written', async () => {
    await withEnv({ ...NO_KEYS, GBRAIN_HOME: emptyHome(), OPENROUTER_API_KEY: 'sk-or-test' }, async () => {
      const out: ResolvedAIOptions = {};
      const err = await captureErr(() => resolveExpansionByEnv(out));
      expect(out.expansion_model).toBeUndefined();
      expect(err).toContain('Detected OPENROUTER_API_KEY');
      expect(err).toContain(OPENROUTER_TIER_DEFAULTS.utility);
      expect(err).toContain('nothing written to config');
    });
  });

  test('openrouter_api_key only in config.json (no env key) → same no-persist outcome', async () => {
    const home = emptyHome();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ openrouter_api_key: 'sk-or-file' }));
    await withEnv({ ...NO_KEYS, GBRAIN_HOME: home }, async () => {
      const out: ResolvedAIOptions = {};
      const err = await captureErr(() => resolveExpansionByEnv(out));
      expect(out.expansion_model).toBeUndefined();
      expect(err).toContain(OPENROUTER_TIER_DEFAULTS.utility);
    });
  });

  test('OPENAI_API_KEY alone → also key-aware, no pin', async () => {
    await withEnv({ ...NO_KEYS, GBRAIN_HOME: emptyHome(), OPENAI_API_KEY: 'sk-test' }, async () => {
      const out: ResolvedAIOptions = {};
      const err = await captureErr(() => resolveExpansionByEnv(out));
      expect(out.expansion_model).toBeUndefined();
      expect(err).toContain('nothing written to config');
    });
  });

  test('GROQ_API_KEY alone (no runtime default) keeps persisting the pin — behavior unchanged', async () => {
    await withEnv({ ...NO_KEYS, GBRAIN_HOME: emptyHome(), GROQ_API_KEY: 'gsk-test' }, async () => {
      const out: ResolvedAIOptions = {};
      const err = await captureErr(() => resolveExpansionByEnv(out));
      expect(out.expansion_model).toBe('groq:llama-3.1-8b-instant');
      expect(err).toContain('Using groq:llama-3.1-8b-instant for expansion');
    });
  });

  test('two chat-capable keys → ambiguous → silent, nothing written (D10, unchanged)', async () => {
    await withEnv({ ...NO_KEYS, GBRAIN_HOME: emptyHome(), OPENROUTER_API_KEY: 'sk-or', ANTHROPIC_API_KEY: 'sk-ant' }, async () => {
      const out: ResolvedAIOptions = {};
      const err = await captureErr(() => resolveExpansionByEnv(out));
      expect(out.expansion_model).toBeUndefined();
      expect(err).toBe('');
    });
  });
});
