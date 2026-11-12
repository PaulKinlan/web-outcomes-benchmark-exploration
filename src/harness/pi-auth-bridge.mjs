import { execFile } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { loadPiAi, resolvePiBin } from './pi-loader.mjs';
import { getAllInstalledBridgeCliFlags } from './provider-bridges.mjs';
import { PROJECT_ROOT, loadDotEnv } from '../util/env.mjs';
import { applyKimiKeyProbe, kimiKeyKind, KIMI_PLATFORM_BASE_URL } from './kimi-key-probe.mjs';

const execFileAsync = promisify(execFile);

export const ENV_KEY_MAP = {
  anthropic: ['ANTHROPIC_API_KEY'],
  'claude-bridge': ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  'openai-codex': ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_API_KEY'],
  groq: ['GROQ_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY', 'KIMI_CODING_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  muse: ['MUSE_API_KEY', 'MUSE_TOKEN'],
};

export const CANONICAL_PI_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  'claude-bridge': 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  xai: 'XAI_API_KEY',
  zai: 'ZAI_API_KEY',
  groq: 'GROQ_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  muse: 'MUSE_API_KEY',
};

const CUSTOM_PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKeyExpr: '$ANTHROPIC_API_KEY' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', apiKeyExpr: '$GEMINI_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', apiKeyExpr: '$OPENAI_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKeyExpr: '$DEEPSEEK_API_KEY' },
  xai: { baseUrl: 'https://api.x.ai/v1', api: 'openai-responses', apiKeyExpr: '$XAI_API_KEY' },
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', api: 'openai-completions', apiKeyExpr: '$ZAI_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions', apiKeyExpr: '$GROQ_API_KEY' },
  minimax: { baseUrl: 'https://api.minimax.io/v1', api: 'openai-completions', apiKeyExpr: '$MINIMAX_API_KEY' },
  'qwen-token-plan': { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', apiKeyExpr: '$QWEN_TOKEN_PLAN_API_KEY' },
  'kimi-coding': { baseUrl: 'https://api.kimi.com/coding', api: 'anthropic-messages', apiKeyExpr: '$KIMI_API_KEY' },
  moonshotai: { baseUrl: 'https://api.moonshot.ai/v1', api: 'openai-completions', apiKeyExpr: '$MOONSHOT_API_KEY' },
  muse: {
    baseUrl: process.env.MUSE_BASE_URL || 'https://api.meta.ai/v1',
    api: 'openai-completions',
    apiKeyExpr: '$MUSE_API_KEY',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  },
};

/**
 * Claude 4.6+ and every Claude 5 model reject `thinking.type: "enabled"` and need adaptive thinking instead.
 * pi only knows that for models in its built-in catalogue, so models added here must carry the flag themselves.
 */
export function anthropicCompatForModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  const m = id.match(/claude-(?:[a-z]+-)?(\d+)(?:[-.](\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] && m[2].length <= 2 ? Number(m[2]) : 0;
  const adaptive = major >= 5 || (major === 4 && minor >= 6);
  return adaptive ? { forceAdaptiveThinking: true, supportsTemperature: false } : null;
}

export function getCustomProviderEndpoint(providerId) {
  const meta = CUSTOM_PROVIDER_DEFAULTS[providerId];
  if (!meta) return null;
  return {
    baseUrl: providerBaseUrl(providerId),
    api: meta.api,
    apiKeyEnvVars: ENV_KEY_MAP[providerId] || [],
  };
}

// Model ids discovered at run time (see model-id-resolver.mjs) that pi must also accept.
const extraPiModelIds = new Map();

export function registerExtraPiModelId(providerId, modelId, template = {}) {
  if (!providerId || !modelId) return;
  if (!extraPiModelIds.has(providerId)) extraPiModelIds.set(providerId, new Map());
  extraPiModelIds.get(providerId).set(modelId, template);
  if (ephemeralAgentDir && existsSync(ephemeralAgentDir)) {
    writeFileSync(join(ephemeralAgentDir, 'models.json'), JSON.stringify(buildCleanRoomPiModelsConfig(), null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

const SENSITIVE_ENV_RE = /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|^PI_AUTH_JSON_B64$|^GITHUB_TOKEN$|^GH_TOKEN$)$/i;

let ephemeralAgentDir = null;

export function resolveProviderApiKeyFromEnv(providerId, env = process.env) {
  const candidates = ENV_KEY_MAP[providerId] || [];
  for (const envName of candidates) {
    const raw = env?.[envName];
    if (!raw || !String(raw).trim()) continue;
    const trimmed = String(raw).trim();
    // KIMI_API_KEY can hold a Kimi Code key (`https://api.kimi.com/coding`) or a Kimi Platform key
    // (`https://api.moonshot.ai/v1`). kimiKeyKind() uses the live probe when it ran, else the `sk-kimi-` prefix.
    if (envName === 'KIMI_API_KEY' && (providerId === 'moonshotai' || providerId === 'kimi-coding')) {
      const kind = kimiKeyKind({ ...env, KIMI_API_KEY: trimmed });
      if (providerId === 'moonshotai' && kind === 'coding') continue;
      if (providerId === 'kimi-coding' && kind !== 'coding') continue;
    }
    return trimmed;
  }
  return null;
}

function providerBaseUrl(providerId, env = process.env) {
  const meta = CUSTOM_PROVIDER_DEFAULTS[providerId];
  if (providerId === 'muse') return env.MUSE_BASE_URL || meta.baseUrl;
  if (providerId === 'moonshotai') {
    if (env.MOONSHOT_BASE_URL) return env.MOONSHOT_BASE_URL;
    // A platform key in KIMI_API_KEY may belong to the .cn endpoint; the probe records which one accepted it.
    if (!env.MOONSHOT_API_KEY && env.KIMI_KEY_KIND === 'platform' && env.KIMI_KEY_BASE_URL) return env.KIMI_KEY_BASE_URL;
    return meta.baseUrl || KIMI_PLATFORM_BASE_URL;
  }
  return meta.baseUrl;
}

/**
 * Builds a credential-blind `models.json` object (`$ENV_VAR` interpolation, zero raw secrets on disk)
 * so the clean-room `pi` CLI recognizes post-cutoff models (e.g. Kimi K3.1 Pro `k3.1-pro`,
 * Meta `muse` models, Claude 5.5, GPT-6.1 Sol/Terra, Gemini 4 Argon, Grok 4.7).
 */
export function buildCleanRoomPiModelsConfig() {
  const configPath = join(PROJECT_ROOT, 'config', 'models.json');
  const cachePath = join(PROJECT_ROOT, 'config', 'models.catalog-cache.json');
  const entries = [];
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      entries.push(...(parsed.models || []));
    } catch {
      // ignore
    }
  }
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
      entries.push(...(parsed.discoveredModels || []));
    } catch {
      // ignore
    }
  }

  const providers = {};
  const seenPerProvider = new Map();

  const ensureProvider = (providerId) => {
    const meta = CUSTOM_PROVIDER_DEFAULTS[providerId];
    if (!meta) return null;
    if (!providers[providerId]) {
      providers[providerId] = {
        baseUrl: providerBaseUrl(providerId),
        api: meta.api,
        apiKey: meta.apiKeyExpr,
        ...(meta.compat ? { compat: meta.compat } : {}),
        models: [],
      };
      seenPerProvider.set(providerId, new Set());
    }
    return providers[providerId];
  };

  for (const m of entries) {
    for (const r of m.routes || []) {
      const provObj = ensureProvider(r.provider);
      if (!provObj || !r.modelId) continue;
      const seen = seenPerProvider.get(r.provider);
      if (seen.has(r.modelId)) continue;
      seen.add(r.modelId);
      const anthropicCompat = r.provider === 'anthropic' ? anthropicCompatForModel(r.modelId) : null;
      provObj.models.push({
        id: r.modelId,
        name: m.label || r.modelId,
        ...(r.api ? { api: r.api } : {}),
        reasoning: m.reasoning ?? true,
        input: ['text', 'image'],
        contextWindow: m.contextWindow || 200000,
        maxTokens: m.maxTokens || 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(anthropicCompat ? { compat: anthropicCompat } : {}),
      });
    }
  }

  // Always ensure Muse & Kimi K3/K3.1 entries exist even if config was customized
  for (const [provId, extraModels] of [
    [
      'kimi-coding',
      [
        { id: 'k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1048576, maxTokens: 65536 },
        { id: 'k3.1-pro-highspeed', name: 'Kimi K3.1 Pro Highspeed', contextWindow: 1048576, maxTokens: 65536 },
        { id: 'k3', name: 'Kimi K3 (3.0)', contextWindow: 1048576, maxTokens: 65536 },
      ],
    ],
    [
      'muse',
      [
        { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', contextWindow: 1048576, maxTokens: 65536 },
        { id: 'muse-spark-open', name: 'Muse Spark Open', contextWindow: 1048576, maxTokens: 65536 },
        { id: 'muse-wonder', name: 'Muse Wonder', contextWindow: 1048576, maxTokens: 65536 },
        { id: 'muse-glimmer-30b', name: 'Muse Glimmer 30B', contextWindow: 131072, maxTokens: 16384 },
      ],
    ],
  ]) {
    const provObj = ensureProvider(provId);
    const seen = seenPerProvider.get(provId);
    for (const xm of extraModels) {
      if (!seen.has(xm.id)) {
        seen.add(xm.id);
        provObj.models.push({
          ...xm,
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
      }
    }
  }

  for (const [provId, ids] of extraPiModelIds.entries()) {
    const provObj = ensureProvider(provId);
    if (!provObj) continue;
    const seen = seenPerProvider.get(provId);
    for (const [id, template] of ids.entries()) {
      if (seen.has(id)) continue;
      seen.add(id);
      provObj.models.push({
        id,
        name: template.name || id,
        reasoning: template.reasoning ?? true,
        input: ['text', 'image'],
        contextWindow: template.contextWindow || 200000,
        maxTokens: template.maxTokens || 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
  }

  return { providers };
}

/**
 * Prepares a clean-room `PI_CODING_AGENT_DIR` (`0700`) containing:
 *   1. `models.json` (credential-blind `$ENV_VAR` definitions for Kimi 3.0/3.1, Muse, etc.)
 *   2. `auth.json` (hydrated from `PI_AUTH_JSON_B64` on CI, or copied from `~/.pi/agent/auth.json` locally)
 *   3. `models-store.json` (copied if present locally so cached dynamic OAuth catalogs work)
 */
export function ensureHeadlessPiAgentDir(baseEnv = process.env) {
  if (baseEnv.PI_CODING_AGENT_DIR) {
    mkdirSync(baseEnv.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
    const customModelsPath = join(baseEnv.PI_CODING_AGENT_DIR, 'models.json');
    if (!existsSync(customModelsPath)) {
      const modelsConfig = buildCleanRoomPiModelsConfig(baseEnv);
      writeFileSync(customModelsPath, JSON.stringify(modelsConfig, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    return baseEnv.PI_CODING_AGENT_DIR;
  }
  if (ephemeralAgentDir && existsSync(ephemeralAgentDir)) return ephemeralAgentDir;

  const dir = join(tmpdir(), `pi-bench-cleanroom-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const authPath = join(dir, 'auth.json');
  if (baseEnv.PI_AUTH_JSON_B64) {
    const decoded = Buffer.from(baseEnv.PI_AUTH_JSON_B64.trim(), 'base64').toString('utf8');
    writeFileSync(authPath, decoded, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(authPath, 0o600);
    } catch {
      // ignore on platforms without POSIX chmod
    }
  } else {
    const userAuthPath = join(homedir(), '.pi', 'agent', 'auth.json');
    if (existsSync(userAuthPath)) {
      try {
        cpSync(userAuthPath, authPath);
        chmodSync(authPath, 0o600);
      } catch {
        // ignore
      }
    }
  }

  const userModelsStore = join(homedir(), '.pi', 'agent', 'models-store.json');
  if (existsSync(userModelsStore)) {
    try {
      cpSync(userModelsStore, join(dir, 'models-store.json'));
    } catch {
      // ignore
    }
  }

  const modelsConfig = buildCleanRoomPiModelsConfig();
  writeFileSync(join(dir, 'models.json'), JSON.stringify(modelsConfig, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });

  ephemeralAgentDir = dir;
  return dir;
}

/**
 * Scrubs unrelated provider secrets & CI tokens from `process.env` before spawning `pi`
 * so an agent's `bash` tool only receives the credential needed for its active provider.
 */
export function scrubEnvForProvider(baseEnv, providerId) {
  const allowedProviderVars = new Set(
    [...(ENV_KEY_MAP[providerId] || []), CANONICAL_PI_ENV[providerId]].filter(Boolean)
  );

  const clean = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    if (SENSITIVE_ENV_RE.test(k) && !allowedProviderVars.has(k)) {
      continue;
    }
    clean[k] = v;
  }
  return clean;
}

/**
 * Builds an environment object for spawning the `pi` CLI so credentials resolved from
 * `.env` aliases or `pi auth` are available ONLY for `providerId`, without leaking
 * unrelated provider keys into the agent workspace.
 */
export async function buildPiCliEnv(runtime, providerId) {
  const childEnv = {
    ...scrubEnvForProvider(process.env, providerId),
    PI_CODING_AGENT: 'true',
  };

  const agentDir = ensureHeadlessPiAgentDir(process.env);
  if (agentDir && !childEnv.PI_CODING_AGENT_DIR) {
    childEnv.PI_CODING_AGENT_DIR = agentDir;
  }

  const targetVar = CANONICAL_PI_ENV[providerId];
  if (targetVar && !childEnv[targetVar]) {
    const resolvedFromEnv = resolveProviderApiKeyFromEnv(providerId, childEnv);
    if (resolvedFromEnv) {
      childEnv[targetVar] = resolvedFromEnv;
    }
  }
  if (targetVar && !childEnv[targetVar] && runtime?.credentials) {
    try {
      const cred = await runtime.credentials.read(providerId);
      if (cred?.type === 'api_key' && cred.key) {
        childEnv[targetVar] = cred.key;
      }
    } catch {
      // ignore
    }
  }
  if (providerId === 'openai' && childEnv.OPENAI_API_KEY && !childEnv.CODEX_API_KEY) {
    childEnv.CODEX_API_KEY = childEnv.OPENAI_API_KEY;
  }
  return childEnv;
}

let cachedExtensionModels = null;

export function resetExtensionModelsCache() {
  cachedExtensionModels = null;
}

/**
 * Discovers models surfaced by explicitly declared clean-room provider bridges (`-e <bridge>`)
 * while strictly disabling ambient user extensions (`--no-extensions`).
 */
export async function getPiExtensionModels() {
  if (cachedExtensionModels) return cachedExtensionModels;
  const piBin = resolvePiBin();
  if (!piBin) {
    cachedExtensionModels = new Map();
    return cachedExtensionModels;
  }

  const bridgeFlags = getAllInstalledBridgeCliFlags();
  if (bridgeFlags.length === 0) {
    cachedExtensionModels = new Map();
    return cachedExtensionModels;
  }

  const agentDir = ensureHeadlessPiAgentDir(process.env);
  const env = agentDir ? { ...process.env, PI_CODING_AGENT_DIR: agentDir } : process.env;

  try {
    const { stdout } = await execFileAsync(
      piBin,
      [
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        ...bridgeFlags,
        '--list-models',
      ],
      {
        env,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    const map = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('provider')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const [provider, modelId] = parts;
        if (!map.has(provider)) map.set(provider, new Set());
        map.get(provider).add(modelId);
      }
    }
    cachedExtensionModels = map;
    return map;
  } catch {
    cachedExtensionModels = new Map();
    return cachedExtensionModels;
  }
}

/**
 * Hydrates a @earendil-works/pi-ai InMemoryCredentialStore from:
 *   1. Local .env / environment variables
 *   2. `pi auth` stored credentials (API keys and auto-refreshed OAuth tokens)
 * Never logs or persists secret values to disk.
 */
export async function createBridgedCredentialStore(providersToCheck = []) {
  loadDotEnv();
  await applyKimiKeyProbe(process.env);
  const piAi = await loadPiAi();
  const store = new piAi.InMemoryCredentialStore();
  const piBin = resolvePiBin();
  const agentDir = ensureHeadlessPiAgentDir(process.env);

  const uniqueProviders = Array.from(
    new Set([...Object.keys(ENV_KEY_MAP), ...providersToCheck, 'kimi-coding', 'moonshotai', 'muse'])
  ).filter((p) => p !== 'antigravity');

  // 1. Seed from environment variables first
  for (const provider of uniqueProviders) {
    const val = resolveProviderApiKeyFromEnv(provider, process.env);
    if (val) {
      await store.modify(provider, async () => ({
        type: 'api_key',
        key: val,
      }));
    }
  }

  // 2. Query `pi auth` for providers not already satisfied by env vars
  if (piBin) {
    const authEnv = agentDir ? { ...process.env, PI_CODING_AGENT_DIR: agentDir } : process.env;
    await Promise.all(
      uniqueProviders.map(async (provider) => {
        const existing = await store.read(provider);
        if (existing) return;
        try {
          const { stdout } = await execFileAsync(
            piBin,
            ['auth', 'check', '--provider', provider, '--json', '--credentials'],
            { env: authEnv, timeout: 10000 }
          );
          const parsed = JSON.parse(stdout.trim());
          if (parsed?.status === 'ready') {
            const rawCred = parsed.credentials ?? parsed.credential ?? parsed.apiKey ?? parsed.key;
            if (parsed.authType === 'api_key') {
              const key = typeof rawCred === 'string' ? rawCred : rawCred?.key;
              if (key) {
                await store.modify(provider, async () => ({ type: 'api_key', key }));
              }
            } else if (parsed.authType === 'oauth') {
              if (typeof rawCred === 'object' && rawCred?.access) {
                await store.modify(provider, async () => ({
                  type: 'oauth',
                  ...rawCred,
                }));
              } else if (typeof rawCred === 'string' && rawCred) {
                await store.modify(provider, async () => ({
                  type: 'oauth',
                  access: rawCred,
                  refresh: 'pi-managed',
                  expires: Date.now() + 50 * 60 * 1000,
                }));
              }
            }
          }
        } catch {
          // Provider not configured or OAuth expired; leave unconfigured
        }
      })
    );
  }

  return store;
}
