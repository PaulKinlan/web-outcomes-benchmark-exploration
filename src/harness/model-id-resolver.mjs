import { getCustomProviderEndpoint, registerExtraPiModelId, resolveProviderApiKeyFromEnv } from './pi-auth-bridge.mjs';

/**
 * Some providers publish a model under a versioned id (`muse-wonder-1.0`) while the registry carries the
 * short name (`muse-wonder`). Asking for the short name returns 404 model_not_found and the whole lane fails.
 * For providers listed here we ask the provider which ids the API key can use (GET /models) and, when the
 * configured id is not one of them, switch to the closest listed id. The cell records both ids.
 */
export const LIVE_MODEL_ID_PROVIDERS = new Set(['muse', 'moonshotai']);

const listingCache = new Map();

export function resetLiveModelIdCache() {
  listingCache.clear();
}

export async function listProviderModelIds(providerId, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (listingCache.has(providerId)) return listingCache.get(providerId);
  const endpoint = getCustomProviderEndpoint(providerId);
  const apiKey = resolveProviderApiKeyFromEnv(providerId, env);
  let ids = null;
  if (endpoint && apiKey && typeof fetchImpl === 'function') {
    try {
      const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const body = await res.json();
        const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
        ids = rows.map((r) => (typeof r === 'string' ? r : r?.id || r?.name)).filter(Boolean);
      }
    } catch {
      ids = null;
    }
  }
  listingCache.set(providerId, ids);
  return ids;
}

const bare = (id) => String(id || '').toLowerCase().replace(/^.*\//, '');

/**
 * Picks the listed id to use for `modelId`. Order: exact id, a registry alias, then the newest-looking id that
 * extends the configured one (`muse-wonder` -> `muse-wonder-1.0`). Returns null when nothing plausible is listed.
 */
export function pickLiveModelId(modelId, aliases = [], listedIds = []) {
  const listed = listedIds.map((id) => ({ id, low: bare(id) }));
  const want = bare(modelId);
  const exact = listed.find((l) => l.low === want);
  if (exact) return { modelId: exact.id, method: 'exact' };
  for (const alias of aliases) {
    const hit = listed.find((l) => l.low === bare(alias));
    if (hit) return { modelId: hit.id, method: 'alias' };
  }
  const extended = listed
    .filter((l) => l.low.startsWith(`${want}-`) || l.low.startsWith(`${want}.`) || l.low.startsWith(`${want}@`))
    .sort((a, b) => b.low.localeCompare(a.low, undefined, { numeric: true }));
  if (extended.length > 0) return { modelId: extended[0].id, method: 'versioned-id' };
  return null;
}

/**
 * Returns the route to actually run, with `modelIdResolution` describing any change. Never throws: if the
 * provider cannot be asked, the configured route is used unchanged.
 */
export async function resolveLiveRoute(modelEntry, route, opts = {}) {
  if (!route || !LIVE_MODEL_ID_PROVIDERS.has(route.provider)) return route;
  const listed = await listProviderModelIds(route.provider, opts);
  if (!Array.isArray(listed) || listed.length === 0) {
    return { ...route, modelIdResolution: { requested: route.modelId, resolved: route.modelId, method: 'unverified' } };
  }
  const pick = pickLiveModelId(route.modelId, modelEntry?.aliases || [], listed);
  if (!pick) {
    return {
      ...route,
      modelIdResolution: {
        requested: route.modelId,
        resolved: null,
        method: 'not-listed',
        availableModelIds: listed.slice(0, 40),
      },
    };
  }
  if (pick.modelId !== route.modelId) {
    registerExtraPiModelId(route.provider, pick.modelId, {
      name: modelEntry?.label,
      contextWindow: modelEntry?.contextWindow,
      maxTokens: modelEntry?.maxTokens,
    });
  }
  return {
    ...route,
    modelId: pick.modelId,
    ...(route.piModel ? { piModel: { ...route.piModel, id: pick.modelId } } : {}),
    modelIdResolution: { requested: route.modelId, resolved: pick.modelId, method: pick.method },
  };
}
