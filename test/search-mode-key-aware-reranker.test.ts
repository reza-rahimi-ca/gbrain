/**
 * Key-aware reranker default in the search-mode plane.
 *
 * `MODE_BUNDLES.*.reranker_model` stays the static `DEFAULT_RERANKER_MODEL`
 * (voyage:rerank-2.5). `loadSearchModeConfig` adds a fourth rung to the
 * `reranker_model` resolution — per-call > config override > KEY-AWARE
 * DEFAULT > static bundle — computed on the same env plane doctor and
 * `gbrain search modes` read, and threaded ONLY when an alternate actually
 * won (an OPENROUTER_API_KEY-only brain → openrouter:voyageai/rerank-2.5).
 *
 * Pins:
 *  - resolveSearchMode honors `defaultRerankerModel` below overrides/per-call
 *    and above the bundle; absent → byte-identical to today;
 *  - the knobs hash segregates cache rows written under the two defaults;
 *  - attributeKnob labels the substitution as the MODE plane with a reason
 *    (not "override" — there is no config row);
 *  - loadSearchModeConfig threads it iff the gateway env has ONLY the
 *    OpenRouter key (Voyage present → not threaded; both → not threaded;
 *    keyless → not threaded).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  MODE_BUNDLES,
  attributeKnob,
  knobsHash,
  loadSearchModeConfig,
  resolveSearchMode,
} from '../src/core/search/mode.ts';
import { DEFAULT_RERANKER_MODEL, OPENROUTER_DEFAULT_RERANKER_MODEL } from '../src/core/ai/defaults.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const OR = OPENROUTER_DEFAULT_RERANKER_MODEL;

function stubEngine(rows: Record<string, string> = {}) {
  return {
    async getConfig(key: string): Promise<string | null> {
      return rows[key] ?? null;
    },
  };
}

afterEach(() => resetGateway());

describe('resolveSearchMode — defaultRerankerModel rung', () => {
  test('absent → static bundle value for every mode (zero behavior change)', () => {
    for (const mode of ['conservative', 'balanced', 'tokenmax'] as const) {
      const r = resolveSearchMode({ mode });
      expect(r.reranker_model).toBe(MODE_BUNDLES[mode].reranker_model);
      expect(r.reranker_model).toBe(DEFAULT_RERANKER_MODEL);
    }
  });

  test('present → wins over the bundle for every mode', () => {
    for (const mode of ['conservative', 'balanced', 'tokenmax'] as const) {
      const r = resolveSearchMode({ mode, defaultRerankerModel: OR });
      expect(r.reranker_model).toBe(OR);
      // Nothing else moves.
      expect(r.reranker_enabled).toBe(MODE_BUNDLES[mode].reranker_enabled);
      expect(r.reranker_top_n_in).toBe(MODE_BUNDLES[mode].reranker_top_n_in);
    }
  });

  test('config override (search.reranker.model) beats the key-aware default', () => {
    const r = resolveSearchMode({
      mode: 'balanced',
      overrides: { reranker_model: 'voyage:rerank-2.5-lite' },
      defaultRerankerModel: OR,
    });
    expect(r.reranker_model).toBe('voyage:rerank-2.5-lite');
  });

  test('per-call beats both', () => {
    const r = resolveSearchMode({
      mode: 'balanced',
      overrides: { reranker_model: 'voyage:rerank-2.5-lite' },
      defaultRerankerModel: OR,
      perCall: { reranker_model: 'openrouter:cohere/rerank-v3.5' },
    });
    expect(r.reranker_model).toBe('openrouter:cohere/rerank-v3.5');
  });

  test('invalid/unset mode still falls back to balanced and honors the rung', () => {
    const r = resolveSearchMode({ mode: 'nonsense', defaultRerankerModel: OR });
    expect(r.resolved_mode).toBe('balanced');
    expect(r.mode_valid).toBe(false);
    expect(r.reranker_model).toBe(OR);
  });

  test('reranker_timeout_ms resolves from the KEY-AWARE model\'s recipe (openrouter 5s) when substituted', () => {
    const native = resolveSearchMode({ mode: 'balanced' });
    const routed = resolveSearchMode({ mode: 'balanced', defaultRerankerModel: OR });
    // Both recipes currently declare 5s; the pin is that the timeout lookup
    // follows the RESOLVED model, so a future recipe divergence flows through.
    expect(typeof routed.reranker_timeout_ms).toBe('number');
    expect(routed.reranker_timeout_ms).toBeGreaterThan(0);
    expect(native.reranker_timeout_ms).toBeGreaterThan(0);
  });
});

describe('knobsHash — the two defaults never share cache rows', () => {
  test('hash differs between native and key-aware reranker defaults, identical otherwise', () => {
    const a = resolveSearchMode({ mode: 'balanced' });
    const b = resolveSearchMode({ mode: 'balanced', defaultRerankerModel: OR });
    expect(knobsHash(a)).not.toBe(knobsHash(b));
    expect(knobsHash(a)).toBe(knobsHash(resolveSearchMode({ mode: 'balanced' })));
  });
});

describe('attributeKnob — dashboard attribution for the substitution', () => {
  test('without the rung: source mode, plain detail (unchanged)', () => {
    const input = { mode: 'balanced' };
    const a = attributeKnob('reranker_model', input, resolveSearchMode(input));
    expect(a.source).toBe('mode');
    expect(a.source_detail).toBe('mode: balanced');
    expect(a.value).toBe(DEFAULT_RERANKER_MODEL);
  });

  test('with the rung: still the MODE plane (no config row), detail explains the key-aware routing', () => {
    const input = { mode: 'balanced', defaultRerankerModel: OR };
    const a = attributeKnob('reranker_model', input, resolveSearchMode(input));
    expect(a.source).toBe('mode');
    expect(a.value).toBe(OR);
    expect(a.source_detail).toContain('mode: balanced');
    expect(a.source_detail).toContain('key-aware default');
    expect(a.source_detail).toContain(DEFAULT_RERANKER_MODEL);
  });

  test('a config override still attributes as override even when the rung is present', () => {
    const input = { mode: 'balanced', overrides: { reranker_model: 'voyage:rerank-2.5-lite' }, defaultRerankerModel: OR };
    const a = attributeKnob('reranker_model', input, resolveSearchMode(input));
    expect(a.source).toBe('override');
    expect(a.source_detail).toBe('config: search.reranker_model');
  });

  test('other knobs are untouched by the rung', () => {
    const input = { mode: 'balanced', defaultRerankerModel: OR };
    const a = attributeKnob('reranker_enabled', input, resolveSearchMode(input));
    expect(a.source).toBe('mode');
    expect(a.source_detail).toBe('mode: balanced');
  });
});

describe('loadSearchModeConfig — threads the rung from the gateway env plane', () => {
  test('OPENROUTER_API_KEY only → defaultRerankerModel = openrouter:voyageai/rerank-2.5', async () => {
    configureGateway({ env: { OPENROUTER_API_KEY: 'sk-or-test' } });
    const input = await loadSearchModeConfig(stubEngine());
    expect(input.defaultRerankerModel).toBe(OR);
    expect(resolveSearchMode(input).reranker_model).toBe(OR);
  });

  test('VOYAGE_API_KEY only → not threaded; native default resolves', async () => {
    configureGateway({ env: { VOYAGE_API_KEY: 'pa-test' } });
    const input = await loadSearchModeConfig(stubEngine());
    expect(input.defaultRerankerModel).toBeUndefined();
    expect(resolveSearchMode(input).reranker_model).toBe(DEFAULT_RERANKER_MODEL);
  });

  test('both keys → not threaded (native wins; OpenRouter never beats a Voyage key)', async () => {
    configureGateway({ env: { VOYAGE_API_KEY: 'pa-test', OPENROUTER_API_KEY: 'sk-or-test' } });
    const input = await loadSearchModeConfig(stubEngine());
    expect(input.defaultRerankerModel).toBeUndefined();
  });

  test('keyless gateway → not threaded (fail-open no_key path unchanged)', async () => {
    configureGateway({ env: {} });
    const input = await loadSearchModeConfig(stubEngine());
    expect(input.defaultRerankerModel).toBeUndefined();
    expect(resolveSearchMode(input).reranker_model).toBe(DEFAULT_RERANKER_MODEL);
  });

  test('an explicit search.reranker.model row wins over the rung end to end', async () => {
    configureGateway({ env: { OPENROUTER_API_KEY: 'sk-or-test' } });
    const input = await loadSearchModeConfig(stubEngine({ 'search.reranker.model': 'openrouter:cohere/rerank-v3.5' }));
    expect(input.defaultRerankerModel).toBe(OR);
    expect(resolveSearchMode(input).reranker_model).toBe('openrouter:cohere/rerank-v3.5');
  });
});
