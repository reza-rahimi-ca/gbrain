/**
 * Fork compatibility: existing OpenRouter Voyage configurations must resolve
 * dimensions/pricing and reach the rerank endpoint; a one-key install must
 * resolve usable chat tiers. Upstream's recipe tests cover only its shipped
 * catalog. Removing these fork additions fails these public-boundary checks.
 * Uses the existing injected rerank transport, never a live provider.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { embeddingDimsForModel } from '../../src/core/ai/model-resolver.ts';
import { lookupEmbeddingPrice } from '../../src/core/embedding-pricing.ts';
import { resolveTierDefault, TIER_DEFAULTS } from '../../src/core/model-config.ts';
import {
  configureGateway, resetGateway, rerank, RerankError,
  __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';

afterEach(() => resetGateway());

describe('OpenRouter Voyage fork compatibility', () => {
  test('existing Voyage routes resolve native width and an honest cost estimate', () => {
    const recipe = getRecipe('openrouter')!;
    expect(recipe.touchpoints.embedding?.default_model).toBe('voyageai/voyage-4');
    expect(recipe.touchpoints.embedding?.dims_options).toEqual([256, 512, 1024, 2048]);
    expect(recipe.touchpoints.embedding?.max_batch_tokens).toBe(120_000);
    for (const [model, price] of [['voyage-4', 0.06], ['voyage-4-large', 0.12], ['voyage-4-lite', 0.02]] as const) {
      expect(embeddingDimsForModel(recipe, `voyageai/${model}`)).toBe(1024);
      expect(lookupEmbeddingPrice(`openrouter:voyageai/${model}`)).toMatchObject({ kind: 'known', pricePerMTok: price });
    }
    expect(embeddingDimsForModel(recipe, 'voyage/voyage-4')).toBe(0);
  });

  test('an OpenRouter-only key resolves usable tiers without changing native precedence', () => {
    for (const tier of ['utility', 'reasoning', 'deep', 'subagent'] as const) {
      expect(resolveTierDefault(tier, { OPENROUTER_API_KEY: 'test-key' })).toStartWith('openrouter:anthropic/');
      expect(resolveTierDefault(tier, { OPENROUTER_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'test-key' })).toBe(TIER_DEFAULTS[tier]);
      expect(resolveTierDefault(tier, {})).toBe(TIER_DEFAULTS[tier]);
    }
  });

  test.each(['rerank-2.5', 'rerank-2.5-lite', 'rerank-3-lite'])('%s uses the OpenRouter request and response contract', async (model) => {
    configureGateway({ reranker_model: `openrouter:voyageai/${model}`, env: { OPENROUTER_API_KEY: 'test-key' } });
    let calls = 0;
    __setRerankTransportForTests(async (url, init) => {
      calls++;
      expect(String(url)).toBe('https://openrouter.ai/api/v1/rerank');
      expect(new Headers(init!.headers).get('authorization')).toBe('Bearer test-key');
      expect(JSON.parse(String(init!.body))).toEqual({ model: `voyageai/${model}`, query: 'books', documents: ['weather', 'books'], top_n: 1 });
      return Response.json({ results: [{ index: 1, relevance_score: 0.9, document: { text: 'books' } }], usage: { total_tokens: 10 } });
    });
    expect(await rerank({ query: 'books', documents: ['weather', 'books'], topN: 1 })).toEqual([{ index: 1, relevanceScore: 0.9 }]);
    expect(calls).toBe(1);
  });

  test('missing keys and incorrect vendor slugs fail before sending a request', async () => {
    for (const [model, env, reason] of [
      ['openrouter:voyageai/rerank-2.5', {}, 'no_key'],
      ['openrouter:voyage/rerank-2.5', { OPENROUTER_API_KEY: 'test-key' }, 'unknown'],
    ] as const) {
      configureGateway({ reranker_model: model, env });
      let calls = 0;
      __setRerankTransportForTests(async () => { calls++; return Response.json({ results: [] }); });
      const error = await rerank({ query: 'books', documents: ['books'] }).catch(error => error);
      expect(error).toBeInstanceOf(RerankError);
      expect(error.reason).toBe(reason);
      expect(calls).toBe(0);
      resetGateway();
    }
  });
});
