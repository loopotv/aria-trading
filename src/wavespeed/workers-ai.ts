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

  const result = await ai.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.prompt },
    ],
    max_tokens: opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.05,
  });

  const inferenceMs = Date.now() - start;
  const text = result.response || '';

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
 * Strategist models in priority order.
 * Falls through to next if current model is unavailable.
 */
const STRATEGIST_MODELS = [
  { id: '@cf/qwen/qwen3-32b', name: 'Qwen 3 32B' },
  { id: '@cf/qwen/qwen2.5-72b-instruct', name: 'Qwen 2.5 72B' },
  { id: '@cf/deepseek/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 32B' },
  { id: '@cf/mistral/mistral-small-3.1-24b-instruct', name: 'Mistral 3.1 24B' },
  { id: '@cf/moonshotai/kimi-k2-instruct', name: 'Kimi K2' },
];

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
      const result = await ai.run(model.id, {
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.prompt },
        ],
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.3,
      });

      const inferenceMs = Date.now() - start;
      const text = result.response || '';

      const inputTokens = Math.ceil((opts.prompt.length + opts.systemPrompt.length) / 4);
      const outputTokens = Math.ceil(text.length / 4);
      costTracker.track(`workers-ai/${model.name}`, inputTokens, outputTokens);

      console.log(`[Strategist] ${model.name} responded in ${inferenceMs}ms`);

      return {
        text: text.trim(),
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
