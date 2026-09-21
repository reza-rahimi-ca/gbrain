/**
 * google-loops-model — unit tests for the open-loop judge's model selection
 * (`loops.extraction_model`) and its per-call provider options.
 *
 * Pure: a fake ConfigReader stands in for the engine; no network, no DB.
 */
import { describe, expect, test } from 'bun:test';

import type { BrainEngine } from '../src/core/engine.ts';
import { getLoopsExtractionModel, loopsJudgeProviderOptions } from '../src/core/google/loops-extract.ts';

function fakeEngine(values: Record<string, string | null>, throwOnRead = false): BrainEngine {
  return {
    async getConfig(key: string) {
      if (throwOnRead) throw new Error('config unavailable');
      return values[key] ?? null;
    },
  } as unknown as BrainEngine;
}

describe('getLoopsExtractionModel', () => {
  test('unset key → undefined (judge falls back to the default chat model)', async () => {
    expect(await getLoopsExtractionModel(fakeEngine({}))).toBeUndefined();
    expect(await getLoopsExtractionModel(fakeEngine({ 'loops.extraction_model': '   ' }))).toBeUndefined();
  });

  test('returns the configured provider:model, normalized', async () => {
    expect(
      await getLoopsExtractionModel(fakeEngine({ 'loops.extraction_model': 'openrouter:deepseek/deepseek-v4.1-flash' })),
    ).toBe('openrouter:deepseek/deepseek-v4.1-flash');
    // slash-form provider prefix normalizes to colon form (#1698)
    expect(
      await getLoopsExtractionModel(fakeEngine({ 'loops.extraction_model': ' anthropic/claude-haiku-4-5-20251001 ' })),
    ).toBe('anthropic:claude-haiku-4-5-20251001');
  });

  test('a config read failure degrades to undefined, never throws', async () => {
    expect(await getLoopsExtractionModel(fakeEngine({}, true))).toBeUndefined();
  });
});

describe('loopsJudgeProviderOptions', () => {
  test('no model → no options', () => {
    expect(loopsJudgeProviderOptions(undefined)).toEqual({});
  });

  test("DeepSeek via OpenRouter sets reasoningEffort 'none' under the openrouter key (the adapter emits it as reasoning_effort)", () => {
    expect(loopsJudgeProviderOptions('openrouter:deepseek/deepseek-v4.1-flash')).toEqual({
      providerOptions: { openrouter: { reasoningEffort: 'none' } },
    });
    // case-insensitive on the model id
    expect(loopsJudgeProviderOptions('openrouter:DeepSeek/deepseek-v4-flash-0731')).toEqual({
      providerOptions: { openrouter: { reasoningEffort: 'none' } },
    });
  });

  test('never emits a `thinking` object — the openai-compatible adapter would drop it silently', () => {
    const out = loopsJudgeProviderOptions('openrouter:deepseek/deepseek-v4.1-flash');
    expect(JSON.stringify(out)).not.toContain('thinking');
  });

  test('DeepSeek direct gets no options (native knob unverified; adapter schema drops `thinking`)', () => {
    expect(loopsJudgeProviderOptions('deepseek:deepseek-v4-flash')).toEqual({});
  });

  test('other providers and other OpenRouter models get no options', () => {
    expect(loopsJudgeProviderOptions('anthropic:claude-haiku-4-5-20251001')).toEqual({});
    expect(loopsJudgeProviderOptions('openrouter:anthropic/claude-sonnet-5')).toEqual({});
    expect(loopsJudgeProviderOptions('openrouter:z-ai/glm-5.3-flash')).toEqual({});
    expect(loopsJudgeProviderOptions('bare-model-id-without-provider')).toEqual({});
  });
});
