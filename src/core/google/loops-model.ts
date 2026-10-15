import type { BrainEngine } from '../engine.ts';
import { normalizeModelId } from '../model-id.ts';

/**
 * Model for the LLM judge: `gbrain config set loops.extraction_model
 * <provider:model>`. Unset → `undefined`, and `chat()` falls back to the
 * default chat model exactly as before this key existed. Read directly (not
 * through resolveModel's tier / models.default / GBRAIN_MODEL chain) so
 * brains that never set it keep today's routing.
 *
 * The judge only needs a small JSON verdict, so a cheap model with reasoning
 * off is the natural pick — a thinking-by-default model spends its output
 * budget on reasoning first (see loopsJudgeProviderOptions).
 */
export async function getLoopsExtractionModel(engine: Pick<BrainEngine, 'getConfig'>): Promise<string | undefined> {
  try {
    const v = await engine.getConfig('loops.extraction_model');
    return v && v.trim() ? normalizeModelId(v.trim()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-call provider options for the judge. DeepSeek thinks by default and
 * bills reasoning as OUTPUT tokens (recipe thinking_by_default, #4172; same on
 * OpenRouter's DeepSeek hosts, #4758). The judge wants only a small JSON
 * verdict, so reasoning is switched off for DeepSeek routed via OpenRouter.
 *
 * Knob choice (verified live 2026-09-21 against deepseek/deepseek-v4.1-flash):
 *   - `reasoning_effort: "none"` → 0 reasoning tokens, 2 completion tokens.
 *   - DeepSeek's native `thinking: { type: "disabled" }` is a no-op through
 *     OpenRouter (reasoning tokens unchanged) — and the AI SDK's
 *     openai-compatible adapter validates providerOptions against a fixed
 *     schema, so a `thinking` or nested `reasoning` object never reaches the
 *     wire anyway. `reasoningEffort` IS in that schema and is emitted as
 *     `reasoning_effort`, so it needs no header/fetch-shim workaround.
 *
 * Native `deepseek:` routes are left alone here: the same schema drop applies,
 * and `reasoning_effort: "none"` is unverified against DeepSeek's own API.
 * Other providers get no options. The extractor retains its bounded
 * output budget and one escalation on truncation.
 */
export function loopsJudgeProviderOptions(
  model: string | undefined,
): { providerOptions?: Record<string, Record<string, unknown>> } {
  if (!model) return {};
  const colon = model.indexOf(':');
  if (colon === -1) return {};
  const provider = model.slice(0, colon).trim().toLowerCase();
  const modelId = model.slice(colon + 1).trim().toLowerCase();
  if (provider === 'openrouter' && modelId.startsWith('deepseek/')) {
    return { providerOptions: { openrouter: { reasoningEffort: 'none' } } };
  }
  return {};
}

