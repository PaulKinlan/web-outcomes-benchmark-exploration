import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadPiAi, resolvePiBin } from './pi-loader.mjs';
import { loadDotEnv } from '../util/env.mjs';

const execFileAsync = promisify(execFile);

const ENV_KEY_MAP = {
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_API_KEY'],
  groq: ['GROQ_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
};

const CANONICAL_PI_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
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
};

/**
 * Builds an environment object for spawning the `pi` CLI so credentials resolved from
 * `.env` aliases (e.g. GROK_API_KEY -> XAI_API_KEY) or `pi auth` are available to `pi`
 * without ever passing keys on the command line or persisting them to disk.
 */
export async function buildPiCliEnv(runtime, providerId) {
  const childEnv = { ...process.env, PI_CODING_AGENT: 'true' };
  const targetVar = CANONICAL_PI_ENV[providerId];
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
  return childEnv;
}

let cachedExtensionModels = null;

/**
 * Discovers models surfaced by pi CLI extensions (such as `antigravity/*`)
 * without exposing any credentials.
 */
export async function getPiExtensionModels() {
  if (cachedExtensionModels) return cachedExtensionModels;
  const piBin = resolvePiBin();
  if (!piBin) {
    cachedExtensionModels = new Map();
    return cachedExtensionModels;
  }

  try {
    const { stdout } = await execFileAsync(piBin, ['--list-models'], {
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
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
  const piAi = await loadPiAi();
  const store = new piAi.InMemoryCredentialStore();
  const piBin = resolvePiBin();

  const uniqueProviders = Array.from(
    new Set([...Object.keys(ENV_KEY_MAP), ...providersToCheck, 'kimi-coding'])
  ).filter((p) => p !== 'antigravity');

  // 1. Seed from environment variables first
  for (const provider of uniqueProviders) {
    const envVars = ENV_KEY_MAP[provider] || [];
    for (const envName of envVars) {
      const val = process.env[envName];
      if (val && val.trim()) {
        await store.modify(provider, async () => ({
          type: 'api_key',
          key: val.trim(),
        }));
        break;
      }
    }
  }

  // 2. Query `pi auth` for providers not already satisfied by env vars
  if (piBin) {
    await Promise.all(
      uniqueProviders.map(async (provider) => {
        const existing = await store.read(provider);
        if (existing) return;
        try {
          const { stdout } = await execFileAsync(
            piBin,
            ['auth', 'check', '--provider', provider, '--json', '--credentials'],
            { timeout: 10000 }
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
