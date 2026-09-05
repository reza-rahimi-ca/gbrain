/**
 * OpenRouter-proxied VoyageAI rerankers — wire-shape pin for `gateway.rerank()`.
 *
 * The response fixture below is a VERBATIM capture from
 * `POST https://openrouter.ai/api/v1/rerank` with `model: voyageai/rerank-2.5`
 * (2026-09-05; only the generation id is shortened). It differs from the
 * ZeroEntropy/Voyage-native fixtures the other rerank tests use in two ways
 * that this test exists to pin:
 *   - every result item carries an extra `document: { text }` echo, which the
 *     parser must ignore (only `index` + `relevance_score` are read);
 *   - the envelope carries `usage`, `provider` and `id` top-level fields,
 *     none of which may confuse the `results[]` / `data[]` dialect sniff.
 *
 * Also pins the request side an OPENROUTER_API_KEY-only brain relies on:
 *   - URL is `https://openrouter.ai/api/v1/rerank` (base already ends in
 *     `/api/v1`; recipe `path: '/rerank'`) — not `/api/v1/models/rerank`;
 *   - body `{ model: 'voyageai/rerank-2.5', query, documents, top_n }` —
 *     the recipe declares no `top_param`, so the default `top_n` key is sent
 *     (OR honors it; live probe with `top_n: 1` returned exactly one item);
 *   - `Authorization: Bearer $OPENROUTER_API_KEY`;
 *   - the `-lite` variant passes the allowlist; the non-existent `voyage/`
 *     vendor slug is rejected BEFORE any HTTP call.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  rerank,
  RerankError,
  __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';

const OPENROUTER_KEY = 'sk-or-v1-test-key';

/** Verbatim OpenRouter response for `voyageai/rerank-2.5` (2026-09-05). */
const LIVE_FIXTURE = {
  model: 'rerank-2.5',
  results: [
    { index: 0, relevance_score: 0.58203125, document: { text: 'Split-K works well for small M on MI300X' } },
    { index: 2, relevance_score: 0.310546875, document: { text: 'ROCm 6.4 kernel tuning notes' } },
    { index: 1, relevance_score: 0.2294921875, document: { text: 'The weather is sunny today' } },
  ],
  usage: { total_tokens: 48, cost: 0.0000024 },
  provider: 'VoyageAI by MongoDB',
  id: 'gen-rerank-1788571637-test',
};

const DOCS = [
  'Split-K works well for small M on MI300X',
  'The weather is sunny today',
  'ROCm 6.4 kernel tuning notes',
];

function configureOpenRouter(model = 'openrouter:voyageai/rerank-2.5'): void {
  configureGateway({
    reranker_model: model,
    env: { OPENROUTER_API_KEY: OPENROUTER_KEY },
  });
}

function mockResp(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('gateway.rerank() — openrouter:voyageai/rerank-2.5 (live wire fixture)', () => {
  test('request: OR /api/v1/rerank URL, voyageai/ model slug, top_n key, Bearer OPENROUTER_API_KEY', async () => {
    configureOpenRouter();
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    __setRerankTransportForTests(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return mockResp(LIVE_FIXTURE);
    });

    await rerank({ query: 'GEMM on MI300X', documents: DOCS, topN: 3 });

    expect(seenUrl).toBe('https://openrouter.ai/api/v1/rerank');
    const body = JSON.parse(String(seenInit!.body));
    expect(body).toEqual({
      model: 'voyageai/rerank-2.5',
      query: 'GEMM on MI300X',
      documents: DOCS,
      top_n: 3,
    });
    const headers = new Headers(seenInit!.headers as HeadersInit);
    expect(headers.get('authorization')).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
  });

  test('response: `document` echo + usage/provider/id envelope are ignored; index/relevance_score map through in provider order', async () => {
    configureOpenRouter();
    __setRerankTransportForTests(async () => mockResp(LIVE_FIXTURE));

    const out = await rerank({ query: 'GEMM on MI300X', documents: DOCS });

    expect(out).toEqual([
      { index: 0, relevanceScore: 0.58203125 },
      { index: 2, relevanceScore: 0.310546875 },
      { index: 1, relevanceScore: 0.2294921875 },
    ]);
    // Nothing from the echo leaks into the RerankResult shape.
    for (const r of out) expect(Object.keys(r).sort()).toEqual(['index', 'relevanceScore']);
  });

  test('the -lite variant passes the allowlist and reaches the wire', async () => {
    configureOpenRouter('openrouter:voyageai/rerank-2.5-lite');
    let calls = 0;
    __setRerankTransportForTests(async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init!.body)).model).toBe('voyageai/rerank-2.5-lite');
      return mockResp({ ...LIVE_FIXTURE, model: 'rerank-2.5-lite', results: LIVE_FIXTURE.results.slice(0, 1) });
    });
    const out = await rerank({ query: 'q', documents: DOCS, topN: 1 });
    expect(calls).toBe(1);
    expect(out).toEqual([{ index: 0, relevanceScore: 0.58203125 }]);
  });

  test('`openrouter:voyage/rerank-2.5` (not an OR slug — HTTP 400 live) is refused by the allowlist before any HTTP call', async () => {
    configureOpenRouter('openrouter:voyage/rerank-2.5');
    let calls = 0;
    __setRerankTransportForTests(async () => {
      calls++;
      return mockResp(LIVE_FIXTURE);
    });
    let err: unknown;
    try {
      await rerank({ query: 'q', documents: DOCS });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RerankError);
    expect((err as RerankError).reason).toBe('unknown');
    expect((err as RerankError).message).toContain('voyage/rerank-2.5');
    expect(calls).toBe(0);
  });

  test('missing OPENROUTER_API_KEY → no_key skip (fail-open), no HTTP call', async () => {
    configureGateway({ reranker_model: 'openrouter:voyageai/rerank-2.5', env: {} });
    let calls = 0;
    __setRerankTransportForTests(async () => {
      calls++;
      return mockResp(LIVE_FIXTURE);
    });
    let err: unknown;
    try {
      await rerank({ query: 'q', documents: DOCS });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RerankError);
    expect((err as RerankError).reason).toBe('no_key');
    expect((err as RerankError).message).toContain('OPENROUTER_API_KEY');
    expect(calls).toBe(0);
  });
});
