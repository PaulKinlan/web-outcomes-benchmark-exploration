import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../util/env.mjs';
import { loadPiAi, getPiRuntimeInfo } from './pi-loader.mjs';
import { createBridgedCredentialStore, getPiExtensionModels } from './pi-auth-bridge.mjs';
import { listProviderBridges, resolveBridgeForProvider } from './provider-bridges.mjs';

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

      if (extModels.has(route.provider) && extModels.get(route.provider).has(route.modelId)) {
        const bridge = resolveBridgeForProvider(route.provider);
        // Extension-surfaced provider models (e.g. antigravity, claude-bridge, muse) run via clean-room pi CLI + -e <bridge>
        if (!isBuiltInPiAiProvider || bridge) {
          activeRoute = {
            ...route,
            transport: 'pi-cli',
            bridgeId: bridge?.id || null,
            via: bridge
              ? `pi bridge (${bridge.id}@${bridge.version})`
              : `pi extension (${route.provider})`,
          };
          break;
        }
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
    piRuntime: getPiRuntimeInfo(),
    providerBridges: listProviderBridges(),
    credentials,
    config,
    models: resolvedModels,
    byKey: new Map(resolvedModels.map((m) => [m.key, m])),
  };
}

export function matchesModelSelector(model, rawSelector) {
  if (!rawSelector || !model) return false;
  const sel = String(rawSelector).trim().toLowerCase();
  const slugSel = sel.replace(/[./\s]+/g, '-');
  if (model.key.toLowerCase() === sel || model.key.toLowerCase() === slugSel) return true;
  for (const r of model.routes || []) {
    const mid = String(r.modelId || '').toLowerCase();
    const full = `${String(r.provider || '').toLowerCase()}/${mid}`;
    if (mid === sel || full === sel || mid.replace(/[./\s]+/g, '-') === slugSel) {
      return true;
    }
  }
  return false;
}

const PROVIDER_FAMILY_LABELS = {
  anthropic: 'Claude (Anthropic)',
  google: 'Gemini (Google)',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI',
  deepseek: 'DeepSeek',
  xai: 'Grok (xAI)',
  'qwen-token-plan': 'Qwen (Alibaba)',
  groq: 'Groq',
  zai: 'GLM (Z.ai)',
  'kimi-coding': 'Kimi (Moonshot)',
  minimax: 'MiniMax',
};

export function selectModels(runtime, { keys = null, pilot = false, onlyReady = true } = {}) {
  let list = runtime.models.filter((m) => m.enabled !== false);
  const unknownKeys = [];
  if (keys && keys.length > 0) {
    const matchedKeySet = new Set();
    const dynamicAdditions = [];

    for (const reqKey of keys) {
      const hits = runtime.models.filter((m) => matchesModelSelector(m, reqKey));
      if (hits.length > 0) {
        const exact = hits.find((m) => m.key.toLowerCase() === String(reqKey).trim().toLowerCase());
        matchedKeySet.add((exact || hits[0]).key);
        continue;
      }

      // Fallback: match built-in pi-ai catalog models (e.g. gpt-5.4, claude-opus-4-8, claude-haiku-4-5)
      const sel = String(reqKey || '').trim();
      const lowerSel = sel.toLowerCase();
      const slugSel = lowerSel.replace(/[./\s]+/g, '-');
      let foundDynamic = null;

      if (runtime.piModels) {
        for (const prov of ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'groq', 'zai', 'kimi-coding']) {
          const provObj = runtime.piModels.getProvider(prov);
          if (!provObj) continue;
          const builtinHit = (provObj.getModels() || []).find(
            (bm) =>
              bm.id.toLowerCase() === lowerSel ||
              `${prov}/${bm.id.toLowerCase()}` === lowerSel ||
              bm.id.toLowerCase().replace(/[./\s]+/g, '-') === slugSel
          );
          if (builtinHit) {
            const dynKey = builtinHit.id.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase();
            const hasCred = runtime.models.some((m) => m.ready && m.activeRoute?.provider === prov);
            const activeRoute = hasCred
              ? {
                  provider: prov,
                  modelId: builtinHit.id,
                  api: builtinHit.api,
                  transport: 'pi-ai',
                  via: `${prov} (pi-ai (api_key))`,
                  piModel: builtinHit,
                }
              : null;
            foundDynamic = {
              key: dynKey,
              label: builtinHit.name || builtinHit.id,
              family: PROVIDER_FAMILY_LABELS[prov] || prov,
              tier: 'builtin',
              pilot: false,
              enabled: true,
              routes: [{ provider: prov, modelId: builtinHit.id, api: builtinHit.api }],
              ready: Boolean(activeRoute),
              activeRoute,
              missingProviders: [prov],
            };
            break;
          }
        }
      }

      if (foundDynamic) {
        dynamicAdditions.push(foundDynamic);
        runtime.models.push(foundDynamic);
        runtime.byKey?.set(foundDynamic.key, foundDynamic);
        matchedKeySet.add(foundDynamic.key);
      } else {
        unknownKeys.push(reqKey);
      }
    }
    list = runtime.models.filter((m) => matchedKeySet.has(m.key));
  } else if (pilot) {
    list = list.filter((m) => m.pilot === true);
  }

  const usable = onlyReady ? list.filter((m) => m.ready) : list;
  const skipped = onlyReady ? list.filter((m) => !m.ready) : [];
  return { usable, skipped, unknownKeys };
}
