/**
 * Kimi issues two kinds of API key that look alike (both can start with `sk-kimi-`):
 *   - "coding":   a Kimi Code membership key, served by https://api.kimi.com/coding
 *   - "platform": a Kimi Platform key (platform.kimi.com / platform.kimi.ai), served by https://api.moonshot.ai/v1
 * A key sent to the wrong endpoint answers 401 "invalid or expired", so the prefix cannot be trusted. Instead we
 * ask each endpoint to list models with the key once per process and route to the one that accepts it.
 */
export const KIMI_KEY_ENDPOINTS = [
  { kind: 'coding', baseUrl: 'https://api.kimi.com/coding/v1' },
  { kind: 'platform', baseUrl: 'https://api.moonshot.ai/v1' },
  { kind: 'platform', baseUrl: 'https://api.moonshot.cn/v1' },
];

export const KIMI_CODING_CLI_BASE_URL = 'https://api.kimi.com/coding/v1';
export const KIMI_PLATFORM_BASE_URL = 'https://api.moonshot.ai/v1';

function looksLikeCodingKey(val) {
  return typeof val === 'string' && val.trim().startsWith('sk-kimi-');
}

/** `coding` or `platform` for the key in KIMI_API_KEY: the probed answer when there is one, else the prefix guess. */
export function kimiKeyKind(env = process.env) {
  const forced = String(env?.KIMI_KEY_KIND || '').trim().toLowerCase();
  if (forced === 'coding' || forced === 'platform') return forced;
  const key = env?.KIMI_API_KEY;
  if (!key || !String(key).trim()) return null;
  return looksLikeCodingKey(key) ? 'coding' : 'platform';
}

/** OpenAI-compatible base URL the key in KIMI_API_KEY belongs to (what the Kimi CLI needs as KIMI_MODEL_BASE_URL). */
export function kimiKeyBaseUrl(env = process.env) {
  if (env?.KIMI_KEY_BASE_URL) return env.KIMI_KEY_BASE_URL;
  return kimiKeyKind(env) === 'platform' ? env?.MOONSHOT_BASE_URL || KIMI_PLATFORM_BASE_URL : KIMI_CODING_CLI_BASE_URL;
}

/**
 * The Kimi CLI harness is registered against `kimi-coding`; with a platform key it must use the platform
 * route (and its model ids) instead.
 */
export function effectiveKimiProvider(providerId, env = process.env) {
  if (providerId !== 'kimi-coding') return providerId;
  if (env?.KIMI_CODING_API_KEY) return providerId;
  if (kimiKeyKind(env) === 'platform' || (!env?.KIMI_API_KEY && env?.MOONSHOT_API_KEY)) return 'moonshotai';
  return providerId;
}

export async function probeKimiKey(key, { fetchImpl = globalThis.fetch, endpoints = KIMI_KEY_ENDPOINTS, timeoutMs = 8000 } = {}) {
  const attempts = await Promise.all(
    endpoints.map(async (ep) => {
      try {
        const res = await fetchImpl(`${ep.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        let modelIds = [];
        if (res.ok) {
          try {
            const body = await res.json();
            const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
            modelIds = rows.map((r) => (typeof r === 'string' ? r : r?.id || r?.name)).filter(Boolean);
          } catch {
            // an accepted key with an unreadable listing still tells us the endpoint
          }
        }
        return { ...ep, status: res.status, ok: res.ok, modelIds };
      } catch (err) {
        return { ...ep, status: null, ok: false, modelIds: [], error: err?.name || 'error' };
      }
    })
  );
  const hit = attempts.find((a) => a.ok) || null;
  return {
    kind: hit?.kind || null,
    baseUrl: hit?.baseUrl || null,
    modelIds: hit?.modelIds || [],
    summary: attempts.map((a) => `${a.baseUrl.replace(/^https:\/\//, '')}=${a.status ?? a.error}`).join(', '),
  };
}

let probed = false;

export function resetKimiKeyProbe() {
  probed = false;
}

/**
 * Probes once and records the answer in `env` (KIMI_KEY_KIND, KIMI_KEY_BASE_URL) so routing, pi and the Kimi CLI
 * all agree. Does nothing when the kind is already set, there is no key, KIMI_KEY_PROBE=0, or under `node --test`.
 * Never throws and never logs the key.
 */
export async function applyKimiKeyProbe(env = process.env, opts = {}) {
  if (probed && !opts.force) return null;
  probed = true;
  const key = String(env?.KIMI_API_KEY || '').trim();
  if (!key || env.KIMI_KEY_KIND || env.KIMI_KEY_PROBE === '0') return null;
  if (env.NODE_TEST_CONTEXT && !opts.fetchImpl) return null;
  const result = await probeKimiKey(key, opts);
  if (result.kind) {
    env.KIMI_KEY_KIND = result.kind;
    env.KIMI_KEY_BASE_URL = result.baseUrl;
  }
  const k3 = result.modelIds.filter((id) => /k3|kimi/i.test(id)).slice(0, 12);
  (opts.log || console.log)(
    `[kimi] key check: ${result.summary}; using ${result.kind || `prefix guess (${kimiKeyKind(env)})`}` +
      (k3.length ? `; models: ${k3.join(', ')}` : '')
  );
  return result;
}
