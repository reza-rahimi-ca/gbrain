/**
 * `gbrain config set OPENROUTER_API_KEY sk-or-…` — provider keys by their
 * env-var spelling.
 *
 * The file-plane field is `openrouter_api_key`, but users (and every `export`
 * line in the docs) know the key as `OPENROUTER_API_KEY`. Pre-fix that spelling
 * hit the unknown-key gate ("Unknown config key … re-run with --force"), and a
 * `--force` write would have stored a field nothing reads. Now the env spelling
 * of ANY provider key aliases its canonical field: the write lands where
 * `mergedProviderEnv` looks, `get`/`show` redact it, `unset` removes it, and
 * the 0600 file semantics are unchanged.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { runConfig, FILE_PLANE_API_KEYS, canonicalConfigKey } from '../src/commands/config.ts';
import { PROVIDER_KEY_ENV_NAMES, mergedProviderEnv, fileplaneKeyForProviderEnvName } from '../src/core/ai/provider-env.ts';
import { KNOWN_CONFIG_KEYS, loadConfigFileOnly } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

// `set` on a file-plane key returns before any engine access; `get` reads the
// DB plane once (null = no row) after the file plane answered.
const stubEngine = { getConfig: async () => null } as unknown as BrainEngine;

async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

const NO_PROVIDER_KEYS = Object.fromEntries(
  Object.values(PROVIDER_KEY_ENV_NAMES).map((name) => [name, undefined]),
) as Record<string, undefined>;

describe('config set/get/unset — env-var spelling of a provider key aliases its file-plane field', () => {
  test('OPENROUTER_API_KEY: set succeeds without --force, lands as openrouter_api_key (0600), get/show redact, unset removes', async () => {
    const home = emptyHome();
    await withEnv({ ...NO_PROVIDER_KEYS, GBRAIN_HOME: home }, async () => {
      const set = await capture(() => runConfig(stubEngine, ['set', 'OPENROUTER_API_KEY', 'sk-or-v1-alias-test']));
      expect(set.err).not.toContain('Unknown config key');
      expect(set.err).not.toContain('--force');
      expect(set.out).toContain('Set openrouter_api_key = ***');
      expect(set.out).toContain('file plane');
      // The raw secret never reaches stdout/stderr.
      expect(set.out + set.err).not.toContain('sk-or-v1-alias-test');
      // The alias is announced once, naming the field the runtime reads.
      expect(set.err).toContain('OPENROUTER_API_KEY is the env-var spelling — stored as openrouter_api_key');

      const cfgPath = join(home, '.gbrain', 'config.json');
      const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      expect(raw.openrouter_api_key).toBe('sk-or-v1-alias-test');
      expect(raw.OPENROUTER_API_KEY).toBeUndefined();
      expect(statSync(cfgPath).mode & 0o777).toBe(0o600);

      // The resolver every key-aware surface reads sees it with NO env key set.
      expect(mergedProviderEnv(loadConfigFileOnly(), process.env).OPENROUTER_API_KEY).toBe('sk-or-v1-alias-test');

      // get (redacted by default; --raw opts out), by either spelling.
      const get = await capture(() => runConfig(stubEngine, ['get', 'OPENROUTER_API_KEY']));
      expect(get.out.trim()).toBe('***');
      const getCanonical = await capture(() => runConfig(stubEngine, ['get', 'openrouter_api_key']));
      expect(getCanonical.out.trim()).toBe('***');
      const getRaw = await capture(() => runConfig(stubEngine, ['get', '--raw', 'OPENROUTER_API_KEY']));
      expect(getRaw.out.trim()).toBe('sk-or-v1-alias-test');

      // show redacts the field.
      const show = await capture(() => runConfig(stubEngine, ['show']));
      expect(show.out).toContain('openrouter_api_key: ***');
      expect(show.out).not.toContain('sk-or-v1-alias-test');

      // unset by the env spelling removes the canonical field.
      const unset = await capture(() => runConfig(stubEngine, ['unset', 'OPENROUTER_API_KEY']));
      expect(unset.out).toContain('Unset openrouter_api_key (file plane)');
      const after = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      expect(after.openrouter_api_key).toBeUndefined();
    });
  });

  test('every provider key gets the same treatment (VOYAGE_API_KEY, ANTHROPIC_API_KEY, …)', () => {
    for (const [configKey, envName] of Object.entries(PROVIDER_KEY_ENV_NAMES)) {
      expect(canonicalConfigKey(envName)).toBe(configKey);
      expect(canonicalConfigKey(configKey)).toBe(configKey);
      expect(FILE_PLANE_API_KEYS).toContain(configKey);
      // The canonical field is a registered key — the alias never needs --force.
      expect(KNOWN_CONFIG_KEYS).toContain(configKey);
    }
    expect(fileplaneKeyForProviderEnvName('OPENROUTER_API_KEY')).toBe('openrouter_api_key');
    expect(fileplaneKeyForProviderEnvName('GOOGLE_GENERATIVE_AI_API_KEY')).toBe('google_api_key');
  });

  test('non-provider keys pass through untouched (config keys stay case-sensitive)', () => {
    expect(canonicalConfigKey('search.mode')).toBe('search.mode');
    expect(canonicalConfigKey('embedding_model')).toBe('embedding_model');
    // Not a provider API-key env name → not aliased (GEMINI is a read-side alias only).
    expect(canonicalConfigKey('GEMINI_API_KEY')).toBe('GEMINI_API_KEY');
    expect(canonicalConfigKey('GBRAIN_HOME')).toBe('GBRAIN_HOME');
    expect(fileplaneKeyForProviderEnvName('openrouter_api_key')).toBeNull();
  });
});
