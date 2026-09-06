/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` and `runExplain` aren't covered here because they touch the
 * gateway / loadConfig; E2E exercises those. The sunset-aware env block and
 * the shared marker ARE covered — they're pure formatters by design.
 */

import { describe, test, expect } from 'bun:test';
import {
  formatRecipeTable,
  formatEnvOutput,
  sunsetMarker,
  sunsetMarkerText,
  envReady,
  pickRecommended,
  type ProviderOption,
} from '../src/commands/providers.ts';
import { listRecipes, getRecipe } from '../src/core/ai/recipes/index.ts';
import type { Recipe } from '../src/core/ai/types.ts';

/** Minimal embedding rows in the shape runExplain builds (id = provider:canonical). */
function embOpt(id: string, extra: Partial<ProviderOption> = {}): ProviderOption {
  return { id, touchpoint: 'embedding', model: id.split(':').slice(1).join(':'), env_ready: true, tier: 'native', pros: [], cons: [], ...extra };
}
const EXPLAIN_EMBEDDING_ROWS: ProviderOption[] = [
  embOpt('voyage:voyage-4', { dims: 1024 }),
  embOpt('openai:text-embedding-3-small', { dims: 1536 }),
  embOpt('openrouter:voyageai/voyage-4', { dims: 1024, tier: 'openai-compat' }),
  embOpt('google:gemini-embedding-2', { dims: 768 }),
  embOpt('ollama:nomic-embed-text', { dims: 768 }),
  embOpt('zeroentropyai:zembed-1', { dims: 1280, deprecated: { date: '2026-09-04', replacement: 'voyage:voyage-4' } }),
];

describe('pickRecommended (providers explain) — same precedence as init auto-pick', () => {
  const none = { OPENAI_API_KEY: false, GOOGLE_GENERATIVE_AI_API_KEY: false, ANTHROPIC_API_KEY: false, VOYAGE_API_KEY: false, OPENROUTER_API_KEY: false };

  test('OPENROUTER_API_KEY only → openrouter:voyageai/voyage-4, reason says one key covers embeddings + reranker + chat', () => {
    const r = pickRecommended(EXPLAIN_EMBEDDING_ROWS, { ...none, OPENROUTER_API_KEY: true }, false);
    expect(r.id).toBe('openrouter:voyageai/voyage-4');
    expect(r.reason).toContain('OPENROUTER_API_KEY set');
    expect(r.reason).toContain('rerank-2.5');
    expect(r.reason).toContain('1024');
  });

  test('OpenRouter never beats a native key: Voyage / OpenAI / Google / local Ollama all win over it', () => {
    expect(pickRecommended(EXPLAIN_EMBEDDING_ROWS, { ...none, VOYAGE_API_KEY: true, OPENROUTER_API_KEY: true }, false).id).toBe('voyage:voyage-4');
    expect(pickRecommended(EXPLAIN_EMBEDDING_ROWS, { ...none, OPENAI_API_KEY: true, OPENROUTER_API_KEY: true }, false).id).toBe('openai:text-embedding-3-small');
    expect(pickRecommended(EXPLAIN_EMBEDDING_ROWS, { ...none, GOOGLE_GENERATIVE_AI_API_KEY: true, OPENROUTER_API_KEY: true }, false).id).toBe('google:gemini-embedding-2');
    expect(pickRecommended(EXPLAIN_EMBEDDING_ROWS, { ...none, OPENROUTER_API_KEY: true }, /* ollamaReady */ true).id).toBe('ollama:nomic-embed-text');
  });

  test('no keys → the canonical Voyage setup path (unchanged)', () => {
    const r = pickRecommended(EXPLAIN_EMBEDDING_ROWS, none, false);
    expect(r.id).toBe('voyage:voyage-4');
    expect(r.reason).toContain('No provider env detected');
  });

  test('a sunsetting provider is never recommended even when its key is the only one', () => {
    const r = pickRecommended(EXPLAIN_EMBEDDING_ROWS, { ...none, ZEROENTROPY_API_KEY: true }, false);
    expect(r.id).toBe('voyage:voyage-4');
  });
});

describe('pickRecommended — never steer away from a healthy, explicitly configured provider', () => {
  const none = { OPENAI_API_KEY: false, GOOGLE_GENERATIVE_AI_API_KEY: false, ANTHROPIC_API_KEY: false, VOYAGE_API_KEY: false, OPENROUTER_API_KEY: false };

  test('defect 2: configured + healthy OpenRouter beats a locally-detected Ollama', () => {
    const r = pickRecommended(
      EXPLAIN_EMBEDDING_ROWS,
      { ...none, OPENROUTER_API_KEY: true },
      /* ollamaReady */ true,
      /* configured embedding_model */ 'openrouter:voyageai/voyage-4',
    );
    expect(r.id).toBe('openrouter:voyageai/voyage-4');
    expect(r.reason.toLowerCase()).toContain('already configured');
  });

  test('configured but UNHEALTHY (key missing) falls through to the normal precedence', () => {
    // embedding_model pins openai, but OPENAI_API_KEY is not set — openai's
    // row is not env_ready, so the pin must not block the fallback pick.
    const rowsWithUnhealthyOpenai = EXPLAIN_EMBEDDING_ROWS.map(o =>
      o.id === 'openai:text-embedding-3-small' ? { ...o, env_ready: false } : o,
    );
    const r = pickRecommended(
      rowsWithUnhealthyOpenai,
      { ...none, OPENROUTER_API_KEY: true },
      /* ollamaReady */ true,
      /* configured embedding_model */ 'openai:text-embedding-3-small',
    );
    expect(r.id).toBe('ollama:nomic-embed-text');
  });

  test('UNSET (unpinned) embedding_model falls through to the normal precedence', () => {
    const r = pickRecommended(
      EXPLAIN_EMBEDDING_ROWS,
      { ...none, OPENROUTER_API_KEY: true },
      /* ollamaReady */ true,
      /* configured embedding_model */ null,
    );
    expect(r.id).toBe('ollama:nomic-embed-text');
  });

  test('configured provider absent from the option list (e.g. unknown/removed) falls through', () => {
    const r = pickRecommended(
      EXPLAIN_EMBEDDING_ROWS,
      { ...none, OPENROUTER_API_KEY: true },
      /* ollamaReady */ true,
      /* configured embedding_model */ 'some-removed-provider:foo',
    );
    expect(r.id).toBe('ollama:nomic-embed-text');
  });

  test('configured + healthy Voyage beats OpenRouter (native pin still wins over precedence)', () => {
    const r = pickRecommended(
      EXPLAIN_EMBEDDING_ROWS,
      { ...none, VOYAGE_API_KEY: true, OPENROUTER_API_KEY: true },
      false,
      'voyage:voyage-4',
    );
    expect(r.id).toBe('voyage:voyage-4');
  });

  test('configured OpenRouter model pinned to a non-canonical model preserves the exact pin, not the recipe default, and ignores detected Ollama', () => {
    const r = pickRecommended(
      EXPLAIN_EMBEDDING_ROWS,
      { ...none, OPENROUTER_API_KEY: true },
      /* ollamaReady */ true,
      /* configured embedding_model */ 'openrouter:qwen/qwen3-embedding-8b',
    );
    expect(r.id).toBe('openrouter:qwen/qwen3-embedding-8b');
    expect(r.id).not.toBe('openrouter:voyageai/voyage-4');
    expect(r.reason.toLowerCase()).toContain('already configured');
  });
});

describe('envReady', () => {
  test('true when all required env vars set', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
  });

  test('false when required env var missing', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, {})).toBe(false);
  });

  test('false on empty-string env var', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, { OPENAI_API_KEY: '' })).toBe(false);
  });

  test('true for recipes with no required env (local Ollama)', () => {
    // Ollama has no auth_env.required.
    const ollama = getRecipe('ollama');
    expect(ollama).toBeDefined();
    expect(envReady(ollama!, {})).toBe(true);
  });
});

describe('formatRecipeTable', () => {
  test('header row present', () => {
    const out = formatRecipeTable(listRecipes(), {});
    expect(out).toContain('PROVIDER');
    expect(out).toContain('TIER');
    expect(out).toContain('EMBED');
    expect(out).toContain('EXPAND');
    expect(out).toContain('CHAT');
    expect(out).toContain('STATUS');
  });

  test('shows ✓ ready for env-satisfied provider', () => {
    const out = formatRecipeTable(listRecipes(), { OPENAI_API_KEY: 'sk-test' });
    // openai row should be ready
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✓ ready');
  });

  test('shows ✗ missing <ENV> for missing provider', () => {
    const out = formatRecipeTable(listRecipes(), {});
    // openai should show missing OPENAI_API_KEY
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✗ missing OPENAI_API_KEY');
  });

  test('shows keyless Ollama chat as available', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const ollamaLine = out.split('\n').find(line => line.startsWith('ollama'));
    expect(ollamaLine).toBeDefined();
    // Master-skew fixup: on this branch ollama also carries an expansion
    // touchpoint (#4073), so the EXPAND column reads `yes`, not `—`.
    expect(ollamaLine).toMatch(/ollama\s+openai-compat\s+yes\s+yes\s+yes\s+✓ ready/);
  });

  test('each recipe appears at most once', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const recipes = listRecipes();
    for (const r of recipes) {
      const occurrences = out.split('\n').filter(line => line.startsWith(`${r.id} `) || line.startsWith(`${r.id}  `));
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('embedding-only recipe (zeroentropyai) shows yes/—/— for tiers', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const zeLine = out.split('\n').find(line => line.startsWith('zeroentropyai'));
    expect(zeLine).toBeDefined();
    // ZE has embedding but no expansion or chat
    expect(zeLine).toContain('yes');
    expect(zeLine).toContain('—');
  });

  test('isolated subset renders correctly (picker reuses this)', () => {
    const openai = getRecipe('openai');
    const ze = getRecipe('zeroentropyai');
    expect(openai && ze).toBeTruthy();
    const out = formatRecipeTable([openai!, ze!], { OPENAI_API_KEY: 'sk-test' });
    const lines = out.split('\n');
    // header + separator + 2 recipe rows
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain('openai');
    expect(lines[2]).toContain('✓ ready');
    expect(lines[3]).toContain('zeroentropyai');
    // v0.46.3: sunsetting providers show the DEPRECATED annotation instead of
    // key-readiness — "ready" on a dying API is not a state to advertise.
    expect(lines[3]).toContain('DEPRECATED');
    expect(lines[3]).toContain('2026-09-04');
    expect(lines[3]).toContain('voyage:voyage-4');
  });
});

describe('sunsetMarker (the one shared deprecation string)', () => {
  test('null for a living provider', () => {
    expect(sunsetMarker(getRecipe('voyage')!)).toBeNull();
    expect(sunsetMarker(getRecipe('openai')!)).toBeNull();
  });

  test('marker for a sunsetting provider names the date and replacement', () => {
    const m = sunsetMarker(getRecipe('zeroentropyai')!);
    expect(m).toContain('DEPRECATED');
    expect(m).toContain('2026-09-04');
    expect(m).toContain('voyage:voyage-4');
  });

  test('no replacement metadata → date-only marker, never "undefined"', () => {
    const m = sunsetMarker({ sunset: { date: '2027-01-01', message: 'x' } } as Pick<Recipe, 'sunset'>);
    expect(m).toContain('2027-01-01');
    expect(m).not.toContain('undefined');
  });

  test('sunsetMarkerText primitive (explain-row consumer): with and without replacement', () => {
    expect(sunsetMarkerText('2026-09-04', 'voyage:voyage-4')).toBe(
      '⚠ DEPRECATED — hosted API ends 2026-09-04; use voyage:voyage-4',
    );
    expect(sunsetMarkerText('2026-09-04')).toBe('⚠ DEPRECATED — hosted API ends 2026-09-04');
    expect(sunsetMarkerText('2026-09-04', null)).not.toContain('undefined');
  });
});

describe('formatEnvOutput (providers env <id>)', () => {
  test('sunsetting provider: DEPRECATED + migrate command, NO signup funnel', () => {
    const ze = getRecipe('zeroentropyai')!;
    const out = formatEnvOutput(ze, {});
    expect(out).toContain('DEPRECATED');
    expect(out).toContain('2026-09-04');
    expect(out).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run');
    // The signup funnel must be gone three weeks before shutdown:
    expect(out).not.toContain('dashboard.zeroentropy.dev');
    expect(out).not.toContain('Get an API key');
    // Key STATUS still renders so existing users can see what's configured:
    expect(out).toContain('ZEROENTROPY_API_KEY');
    expect(out).toContain('✗ not set');
  });

  test('sunsetting provider with a key set still shows ✓ set', () => {
    const ze = getRecipe('zeroentropyai')!;
    const out = formatEnvOutput(ze, { ZEROENTROPY_API_KEY: 'sk-fake' });
    expect(out).toContain('✓ set');
    expect(out).toContain('DEPRECATED');
  });

  test('living provider control: setup funnel intact', () => {
    const voyage = getRecipe('voyage')!;
    const out = formatEnvOutput(voyage, {});
    expect(out).not.toContain('DEPRECATED');
    expect(out).toContain('Setup:');
  });

  test('sunset recipe without replacement metadata prints no "undefined"', () => {
    const fake = {
      id: 'fake-sunset',
      name: 'Fake Sunset',
      tier: 'native',
      touchpoints: {},
      auth_env: { required: ['FAKE_KEY'] },
      sunset: { date: '2027-01-01', message: 'Fake is shutting down.' },
    } as unknown as Recipe;
    const out = formatEnvOutput(fake, {});
    expect(out).toContain('DEPRECATED');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('Replacement:');
    expect(out).toContain('migrate embeddings');
  });

  test('sunset block positively asserts message + Replacement line (ZE fixture)', () => {
    const out = formatEnvOutput(getRecipe('zeroentropyai')!, {});
    expect(out).toContain('ZeroEntropy is shutting down its hosted API.');
    expect(out).toContain('Replacement: voyage:voyage-4 (embedding), voyage:rerank-2.5 (reranker)');
  });

  test('keyless recipe (ollama): Required: (none) arm renders', () => {
    const ollama = getRecipe('ollama')!;
    const out = formatEnvOutput(ollama, {});
    expect(out).toContain('Required: (none)');
    expect(out).not.toContain('DEPRECATED');
  });

  test('optional-env arm renders when a recipe declares optional vars', () => {
    const fake = {
      id: 'fake-optional',
      name: 'Fake Optional',
      tier: 'native',
      touchpoints: {},
      auth_env: { required: ['FAKE_KEY'], optional: ['FAKE_ORG'], setup_url: 'https://example.com' },
      setup_hint: 'Get a key at example.com.',
    } as unknown as Recipe;
    const out = formatEnvOutput(fake, { FAKE_ORG: 'org-1' });
    expect(out).toContain('Optional:');
    expect(out).toContain('FAKE_ORG');
    expect(out).toContain('✓ set');
    // Living provider keeps its funnel:
    expect(out).toContain('Setup: https://example.com');
    expect(out).toContain('Get a key at example.com.');
  });
});
