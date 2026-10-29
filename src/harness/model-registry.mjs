import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../util/env.mjs';
import { loadPiAi } from './pi-loader.mjs';
import { createBridgedCredentialStore, getPiExtensionModels } from './pi-auth-bridge.mjs';

export const MODELS_CONFIG_PATH = join(PROJECT_ROOT, 'config', 'models.json');
export const MODELS_CACHE_PATH = join(PROJECT_ROOT, 'config', 'models.catalog-cache.json');

const PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
  openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' },
  'openai-codex': { baseUrl: 'https://chatgpt.com/backend-api/codex', api: 'openai-codex-responses' },
  deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' },
  'qwen-token-plan': { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', api: 'openai-completions' },
  xai: { baseUrl: 'https://api.x.ai/v1', api: 'openai-completions' },
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', api: 'openai-completions' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  minimax: { baseUrl: 'https://api.minimax.io/v1', api: 'openai-completions' },
};

export function loadModelRegistryConfig() {
  const raw = JSON.parse(readFileSync(MODELS_CONFIG_PATH, 'utf8'));
  const cache = existsSync(MODELS_CACHE_PATH)
    ? JSON.parse(readFileSync(MODELS_CACHE_PATH, 'utf8'))
    : { discoveredModels: [] };

  const byKey = new Map();
  for (const m of raw.models || []) {
    byKey.set(m.key, m);
  }
  for (const m of cache.discoveredModels || []) {
    if (!byKey.has(m.key)) {
      byKey.set(m.key, m);
    }
  }

  return {
    version: raw.version,
    updatedAt: raw.updatedAt,
    syncedAt: cache.syncedAt || null,
    models: Array.from(byKey.values()),
  };
}

export function addModelToConfig(entry) {
  const raw = JSON.parse(readFileSync(MODELS_CONFIG_PATH, 'utf8'));
  const idx = raw.models.findIndex((m) => m.key === entry.key);
  if (idx >= 0) raw.models[idx] = { ...raw.models[idx], ...entry };
  else raw.models.push(entry);
  writeFileSync(MODELS_CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return entry;
}

/**
 * Builds a Model<Api> descriptor compatible with @earendil-works/pi-ai even when
 * the model released after pi-ai's static catalog snapshot.
 */
function buildSyntheticPiModel(piModels, route, modelSpec) {
  const existing = piModels.getModel(route.provider, route.modelId);
  if (existing) return existing;

  const providerObj = piModels.getProvider(route.provider);
  const existingProviderModels = providerObj ? providerObj.getModels() : [];
  const template = existingProviderModels[existingProviderModels.length - 1];
  const fallbackMeta = PROVIDER_DEFAULTS[route.provider] || PROVIDER_DEFAULTS.openrouter;

  return {
    id: route.modelId,
    name: modelSpec.label || route.modelId,
    api: route.api || template?.api || fallbackMeta.api,
    provider: route.provider,
    baseUrl: route.baseUrl || template?.baseUrl || providerObj?.baseUrl || fallbackMeta.baseUrl,
    reasoning: modelSpec.reasoning ?? template?.reasoning ?? true,
    input: ['text', 'image'],
    cost: modelSpec.cost || template?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelSpec.contextWindow || template?.contextWindow || 200000,
    maxTokens: modelSpec.maxTokens || template?.maxTokens || 32768,
    ...(route.provider === 'anthropic' ? { compat: { supportsTemperature: false } } : {}),
  };
}

/**
 * Initializes the runtime @earendil-works/pi-ai Models instance plus route readiness
 * across native providers, pi extension providers (e.g., antigravity), and OpenRouter fallback.
 */
export async function initializeModelRuntime() {
  const config = loadModelRegistryConfig();
  const allProviders = new Set();
  for (const m of config.models) {
    for (const r of m.routes || []) allProviders.add(r.provider);
  }

  const piAi = await loadPiAi();
  const credentials = await createBridgedCredentialStore(Array.from(allProviders));
  const piModels = piAi.builtinModels
    ? piAi.builtinModels({ credentials })
    : piAi.createModels({ credentials });
  const extModels = await getPiExtensionModels();

  const providerAuthCache = new Map();
  async function isProviderReady(providerId) {
    if (providerAuthCache.has(providerId)) return providerAuthCache.get(providerId);
    const isBuiltIn = Boolean(piModels.getProvider(providerId));
    if (!isBuiltIn && extModels.has(providerId)) {
      providerAuthCache.set(providerId, { ready: true, via: 'pi-cli-extension' });
      return providerAuthCache.get(providerId);
    }
    try {
      const check = await piModels.checkAuth(providerId);
      const ready = Boolean(check);
      const status = { ready, via: ready ? `pi-ai (${check.type})` : null };
      providerAuthCache.set(providerId, status);
      return status;
    } catch {
      const status = { ready: false, via: null };
      providerAuthCache.set(providerId, status);
      return status;
    }
  }

  const resolvedModels = [];
  for (const m of config.models) {
    let activeRoute = null;
    for (const route of m.routes || []) {
      const isBuiltInPiAiProvider = Boolean(piModels.getProvider(route.provider));

      if (!isBuiltInPiAiProvider && extModels.has(route.provider)) {
        // Extension-only providers (e.g. antigravity) run via `pi --no-tools`
        if (extModels.get(route.provider).has(route.modelId)) {
          activeRoute = {
            ...route,
            transport: 'pi-cli',
            via: `pi extension (${route.provider})`,
          };
          break;
        }
        continue;
      }

      const auth = await isProviderReady(route.provider);
      if (auth.ready) {
        const piModel = buildSyntheticPiModel(piModels, route, m);
        activeRoute = {
          ...route,
          transport: 'pi-ai',
          via: `${route.provider} (${auth.via})`,
          piModel,
        };
        break;
      }
    }

    resolvedModels.push({
      ...m,
      ready: Boolean(activeRoute),
      activeRoute,
      missingProviders: (m.routes || []).map((r) => r.provider),
    });
  }

  return {
    piAi,
    piModels,
    credentials,
    config,
    models: resolvedModels,
    byKey: new Map(resolvedModels.map((m) => [m.key, m])),
  };
}

export function selectModels(runtime, { keys = null, pilot = false, onlyReady = true } = {}) {
  let list = runtime.models.filter((m) => m.enabled !== false);
  if (keys && keys.length > 0) {
    const keySet = new Set(keys);
    list = runtime.models.filter((m) => keySet.has(m.key));
  } else if (pilot) {
    list = list.filter((m) => m.pilot === true);
  }

  const usable = onlyReady ? list.filter((m) => m.ready) : list;
  const skipped = onlyReady ? list.filter((m) => !m.ready) : [];
  return { usable, skipped };
}
