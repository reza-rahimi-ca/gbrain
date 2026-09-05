/**
 * `gbrain init` embedding auto-pick with ONLY `OPENROUTER_API_KEY` set.
 *
 * The one-key install contract: no `--embedding-model`, no
 * `--embedding-dimensions`, and init must still land on a usable semantic
 * search config — `openrouter:voyageai/voyage-4` @ 1024d (the OR recipe's
 * canonical `default_model`, the same embedding space as the native
 * new-install default `voyage:voyage-4`).
 *
 * Precedence is upstream's: when a native Voyage key is ALSO present the
 * non-TTY multi-key path keeps picking the canonical `voyage:voyage-4`;
 * OpenRouter only wins when it is the sole key. Zero keys stays keyless.
 *
 * `resolveEmbeddingByEnv` reads process.env + the file plane at GBRAIN_HOME,
 * so every case pins an empty home (a dev box's real config.json must not
 * fold its keys in) and clears the other provider keys explicitly.
 */
import { describe, expect, test } from 'bun:test';
import { _exports_for_test, type ResolvedAIOptions } from '../src/commands/init.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

const { resolveEmbeddingByEnv } = _exports_for_test;

const NO_OTHER_KEYS = {
  VOYAGE_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  ZEROENTROPY_API_KEY: undefined,
  DASHSCOPE_API_KEY: undefined,
  ZHIPUAI_API_KEY: undefined,
  MINIMAX_API_KEY: undefined,
  TOGETHER_API_KEY: undefined,
  AZURE_OPENAI_API_KEY: undefined,
  AZURE_OPENAI_ENDPOINT: undefined,
  LITELLM_API_KEY: undefined,
  DATABASE_URL: undefined,
  GBRAIN_DATABASE_URL: undefined,
} as const;

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

describe('init embedding auto-pick — OPENROUTER_API_KEY as the only key', () => {
  test('non-interactive: resolves openrouter:voyageai/voyage-4 @ 1024 with no flags', async () => {
    await withEnv({ ...NO_OTHER_KEYS, OPENROUTER_API_KEY: 'sk-or-test', GBRAIN_HOME: emptyHome() }, async () => {
      const out: ResolvedAIOptions = {};
      await quiet(() => resolveEmbeddingByEnv(out, /* nonInteractive */ true));
      expect(out.noEmbedding).toBeUndefined();
      expect(out.embedding_model).toBe('openrouter:voyageai/voyage-4');
      expect(out.embedding_dimensions).toBe(1024);
    });
  });

  test('precedence: OPENROUTER_API_KEY + VOYAGE_API_KEY (non-TTY) → the native canonical voyage:voyage-4 still wins', async () => {
    await withEnv(
      { ...NO_OTHER_KEYS, OPENROUTER_API_KEY: 'sk-or-test', VOYAGE_API_KEY: 'pa-test', GBRAIN_HOME: emptyHome() },
      async () => {
        const out: ResolvedAIOptions = {};
        await quiet(() => resolveEmbeddingByEnv(out, true));
        expect(out.embedding_model).toBe('voyage:voyage-4');
        expect(out.embedding_dimensions).toBe(1024);
      },
    );
  });

  test('zero keys (non-TTY) → keyless continue, unchanged', async () => {
    await withEnv({ ...NO_OTHER_KEYS, OPENROUTER_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const out: ResolvedAIOptions = {};
      await quiet(() => resolveEmbeddingByEnv(out, true));
      expect(out.noEmbedding).toBe(true);
      expect(out.embedding_model).toBeUndefined();
    });
  });

  test('file-plane openrouter_api_key (config.json, no env key) also auto-picks the OR default', async () => {
    const home = emptyHome();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // configDir() appends `.gbrain` to GBRAIN_HOME.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ openrouter_api_key: 'sk-or-file' }));
    await withEnv({ ...NO_OTHER_KEYS, OPENROUTER_API_KEY: undefined, GBRAIN_HOME: home }, async () => {
      const out: ResolvedAIOptions = {};
      await quiet(() => resolveEmbeddingByEnv(out, true));
      expect(out.embedding_model).toBe('openrouter:voyageai/voyage-4');
      expect(out.embedding_dimensions).toBe(1024);
    });
  });
});
