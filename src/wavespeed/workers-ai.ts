/**
 * Workers AI client for Llama 4 Scout and Kimi K2.
 * Free tier: 10,000 neurons/day on Cloudflare Workers AI.
 */

import { costTracker } from './client';

export interface AiBinding {
  run(model: string, inputs: {
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
  }): Promise<{ response?: string }>;
}

/**
 * Call Llama 4 Scout via Workers AI binding.
 * Same interface as callWaveSpeed for easy swapping.
 */
export async function callWorkersAI(
  ai: AiBinding,
  opts: {
    prompt: string;
    systemPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<{ text: string; inferenceMs: number; estimatedCost: number }> {
  const start = Date.now();

  const result: any = await ai.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.prompt },
    ],
    max_tokens: opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.05,
  });

  const inferenceMs = Date.now() - start;
  const text = extractText(result);

  // Track as $0 cost (free tier)
  const inputTokens = Math.ceil((opts.prompt.length + opts.systemPrompt.length) / 4);
  const outputTokens = Math.ceil(text.length / 4);
  costTracker.track('workers-ai/llama-4-scout', inputTokens, outputTokens);

  return {
    text: text.trim(),
    inferenceMs,
    estimatedCost: 0, // Free!
  };
}

/**
 * Strategist models in priority order. Falls through if current is unavailable.
 *
 * Selected via live latency/JSON benchmark (2026-04-18):
 *   - gpt-oss-120b: 1.2s, perfect JSON, OpenAI Responses API shape
 *   - gpt-oss-20b: 0.85s, perfect JSON, same shape
 *   - llama-4-scout: 0.9s, JSON wrapped in ```...```, classic Workers AI shape
 *
 * Removed (broken on Workers AI as of 2026-04-18):
 *   - kimi-k2.5: returns empty response after 12s
 *   - deepseek-r1-distill-qwen-32b: returns think-aloud, not JSON
 *   - qwen2.5-coder-32b: malformed response object
 */
const STRATEGIST_MODELS = [
  { id: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
  { id: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout' },
];

/** Extract assistant text across the various Workers AI response shapes. */
function extractText(out: any): string {
  if (typeof out?.response === 'string') return out.response;
  if (Array.isArray(out?.choices) && out.choices[0]?.message?.content) return out.choices[0].message.content;
  if (typeof out?.output_text === 'string') return out.output_text;
  if (Array.isArray(out?.output) && out.output[0]?.content?.[0]?.text) return out.output[0].content[0].text;
  return '';
}

/**
 * Call strategist via Workers AI with model fallback.
 * Tries models in priority order until one succeeds.
 */
export async function callStrategist(
  ai: AiBinding,
  opts: {
    prompt: string;
    systemPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }
): Promise<{ text: string; inferenceMs: number; estimatedCost: number; model: string }> {
  const errors: string[] = [];

  for (const model of STRATEGIST_MODELS) {
    const start = Date.now();
    try {
      const result: any = await ai.run(model.id, {
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.prompt },
        ],
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.3,
      });

      const inferenceMs = Date.now() - start;
      const text = extractText(result).trim();

      // Treat empty response as failure — try next model
      if (!text) {
        errors.push(`${model.name}: empty response (${inferenceMs}ms)`);
        console.warn(`[Strategist] ${model.name} returned empty, trying next...`);
        continue;
      }

      const inputTokens = Math.ceil((opts.prompt.length + opts.systemPrompt.length) / 4);
      const outputTokens = Math.ceil(text.length / 4);
      costTracker.track(`workers-ai/${model.name}`, inputTokens, outputTokens);

      console.log(`[Strategist] ${model.name} responded in ${inferenceMs}ms (${text.length} chars)`);

      return {
        text,
        inferenceMs,
        estimatedCost: 0,
        model: model.name,
      };
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 100) || 'unknown';
      errors.push(`${model.name}: ${msg}`);
      console.warn(`[Strategist] ${model.name} failed: ${msg}, trying next...`);
    }
  }

  throw new Error(`All strategist models failed: ${errors.join(' | ')}`);
}
