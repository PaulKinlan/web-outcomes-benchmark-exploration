#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODELS_CONFIG_PATH, MODELS_CACHE_PATH } from './model-registry.mjs';
import { slugify } from '../util/env.mjs';

const TARGET_FAMILIES = [
  { prefix: 'anthropic/', family: 'Claude (Anthropic)', nativeProvider: 'anthropic', nativeApi: 'anthropic-messages' },
  { prefix: 'google/', family: 'Gemini (Google)', nativeProvider: 'google', nativeApi: 'google-generative-ai' },
  { prefix: 'openai/', family: 'OpenAI', nativeProvider: 'openai', nativeApi: 'openai-responses' },
  { prefix: 'deepseek/', family: 'DeepSeek', nativeProvider: 'deepseek', nativeApi: 'openai-completions' },
  { prefix: 'qwen/', family: 'Qwen (Alibaba)', nativeProvider: 'qwen-token-plan', nativeApi: 'openai-completions' },
  { prefix: 'x-ai/', family: 'Frontier Peers', nativeProvider: 'xai', nativeApi: 'openai-completions' },
  { prefix: 'z-ai/', family: 'Frontier Peers', nativeProvider: 'zai', nativeApi: 'openai-completions' },
  { prefix: 'moonshotai/', family: 'Frontier Peers', nativeProvider: 'kimi-coding', nativeApi: 'openai-completions' },
  { prefix: 'minimax/', family: 'Frontier Peers', nativeProvider: 'minimax', nativeApi: 'openai-completions' },
];

export async function syncLatestModels({ maxPerFamily = 6 } = {}) {
  const existing = JSON.parse(readFileSync(MODELS_CONFIG_PATH, 'utf8'));
  const existingOpenRouterIds = new Set();
  for (const m of existing.models) {
    for (const r of m.routes || []) {
      if (r.provider === 'openrouter') existingOpenRouterIds.add(r.modelId);
    }
  }

  const res = await fetch('https://openrouter.ai/api/v1/models', {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter model catalog request failed with HTTP ${res.status}`);
  }
  const payload = await res.json();
  const data = (payload.data || []).filter(
    (item) =>
      item.id &&
      !item.id.includes(':batch') &&
      !item.id.includes(':free') &&
      !item.id.includes('guard') &&
      !item.id.includes('embed') &&
      !item.id.includes('realtime') &&
      !item.id.includes('image') &&
      !item.id.includes('banana') &&
      !item.id.includes('audio')
  );

  const discovered = [];
  for (const fam of TARGET_FAMILIES) {
    const recent = data
      .filter((x) => x.id.startsWith(fam.prefix))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .slice(0, maxPerFamily);

    for (const item of recent) {
      if (existingOpenRouterIds.has(item.id)) continue;
      const bareId = item.id.slice(fam.prefix.length);
      const nativeId = fam.nativeProvider === 'anthropic' ? bareId.replace(/\./g, '-') : bareId;
      const key = slugify(bareId);

      discovered.push({
        key,
        label: item.name?.replace(/^[^:]+:\s*/, '') || bareId,
        family: fam.family,
        tier: 'synced',
        pilot: false,
        enabled: true,
        releaseDate: item.created ? new Date(item.created * 1000).toISOString().slice(0, 10) : null,
        routes: [
          { provider: fam.nativeProvider, modelId: nativeId, api: fam.nativeApi },
          { provider: 'openrouter', modelId: item.id, api: 'openai-completions' },
        ],
        contextWindow: item.context_length || 200000,
        maxTokens: item.top_provider?.max_completion_tokens || 32768,
      });
    }
  }

  const cacheObj = {
    syncedAt: new Date().toISOString(),
    source: 'https://openrouter.ai/api/v1/models',
    discoveredCount: discovered.length,
    discoveredModels: discovered,
  };

  writeFileSync(MODELS_CACHE_PATH, JSON.stringify(cacheObj, null, 2) + '\n', 'utf8');
  return cacheObj;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncLatestModels()
    .then((res) => {
      console.log(`[sync:models] Synced ${res.discoveredCount} additional recent models -> ${MODELS_CACHE_PATH}`);
    })
    .catch((err) => {
      console.error(`[sync:models] Failed: ${err.message}`);
      process.exit(1);
    });
}
