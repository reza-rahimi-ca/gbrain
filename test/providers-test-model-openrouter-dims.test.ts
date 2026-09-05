/**
 * `gbrain providers test --model openrouter:voyageai/voyage-4` must probe at
 * the MODEL's width.
 *
 * The `--model` override sized the probe from the recipe-wide
 * `touchpoints.embedding.default_dims`. OpenRouter declares `default_dims: 0`
 * (its catalog spans 1024–4096, so there is no honest recipe-wide width), and
 * a 0-wide probe made the smoke test report the provider as not ready — for a
 * model that init auto-picks on an OPENROUTER_API_KEY-only machine. The width
 * now follows `embeddingDimsForModel` (per-model `model_dims` first, recipe
 * default second, 1536 legacy floor last).
 *
 * Drives the real `runProviders('test', ...)` path with a stubbed fetch and
 * asserts on the request that reaches OpenRouter and on the printed width.
 * `process.exit` is trapped so a pre-fix "not configured or not ready" exit
 * surfaces as a thrown error instead of killing the test process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProviders } from '../src/commands/providers.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
const origFetch = globalThis.fetch;
const origExit = process.exit;
const origLog = console.log;
let tmpHome: string;
let stdout = '';

function okEmbeddingResponse(dims: number): Response {
  const vec = Array(dims).fill(0).map((_, i) => 0.001 * i);
  return new Response(
    JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: vec }], model: 'voyage-4', usage: { prompt_tokens: 4, total_tokens: 4 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  fetchHandler = null;
  stdout = '';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('fetch called but no handler installed');
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;
  process.exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as never;
  console.log = (...a: unknown[]) => { stdout += a.map(String).join(' ') + '\n'; };
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-providers-test-or-dims-'));
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  // A brain keyed ONLY through the file plane's openrouter_api_key.
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ openrouter_api_key: 'sk-or-file-key' }));
});

afterEach(() => {
  globalThis.fetch = origFetch;
  process.exit = origExit;
  console.log = origLog;
  resetGateway();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('providers test --model openrouter:voyageai/voyage-4', () => {
  test('probes OpenRouter at the model\'s 1024 width and reports it', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    fetchHandler = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body ?? '{}'));
      return okEmbeddingResponse(1024);
    };

    await withEnv(
      {
        GBRAIN_HOME: tmpHome,
        VOYAGE_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined, // file plane only
        DATABASE_URL: undefined,
        GBRAIN_DATABASE_URL: undefined,
      },
      async () => {
        await runProviders('test', ['--touchpoint', 'embedding', '--model', 'openrouter:voyageai/voyage-4']);
      },
    );

    expect(capturedUrl.startsWith('https://openrouter.ai/api/v1/embeddings')).toBe(true);
    expect(capturedBody.model).toBe('voyageai/voyage-4');
    expect(stdout).toContain('1024 dims');
    expect(stdout).toContain('All probes green.');
  });
});
