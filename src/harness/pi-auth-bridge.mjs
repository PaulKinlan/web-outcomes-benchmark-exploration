import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { loadPiAi, resolvePiBin } from './pi-loader.mjs';
import { getAllInstalledBridgeCliFlags } from './provider-bridges.mjs';
import { loadDotEnv } from '../util/env.mjs';

const execFileAsync = promisify(execFile);

const ENV_KEY_MAP = {
  anthropic: ['ANTHROPIC_API_KEY'],
  'claude-bridge': ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'openai-codex': ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_API_KEY'],
  groq: ['GROQ_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  muse: ['MUSE_API_KEY', 'MUSE_TOKEN'],
};

const CANONICAL_PI_ENV = {
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
  muse: 'MUSE_API_KEY',
};

const SENSITIVE_ENV_RE = /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|^PI_AUTH_JSON_B64$|^GITHUB_TOKEN$|^GH_TOKEN$)$/i;

let ephemeralAgentDir = null;

/**
 * On headless VMs / GitHub Actions, hydrates `PI_AUTH_JSON_B64` into a 0700 ephemeral
 * `PI_CODING_AGENT_DIR` so OAuth bridges (`antigravity`, `openai-codex`, `claude-bridge`)
 * work cleanly without committing `auth.json` to disk.
 */
export function ensureHeadlessPiAgentDir(baseEnv = process.env) {
  if (baseEnv.PI_CODING_AGENT_DIR) return baseEnv.PI_CODING_AGENT_DIR;
  if (!baseEnv.PI_AUTH_JSON_B64) return null;
  if (ephemeralAgentDir) return ephemeralAgentDir;

  const dir = join(tmpdir(), `pi-bench-auth-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const decoded = Buffer.from(baseEnv.PI_AUTH_JSON_B64.trim(), 'base64').toString('utf8');
  const authPath = join(dir, 'auth.json');
  writeFileSync(authPath, decoded, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(authPath, 0o600);
  } catch {
    // ignore on platforms without POSIX chmod
  }
  ephemeralAgentDir = dir;
  return dir;
}

/**
 * Scrubs unrelated provider secrets & CI tokens from `process.env` before spawning `pi`
 * so an agent's `bash` tool only receives the credential needed for its active provider.
 */
export function scrubEnvForProvider(baseEnv, providerId) {
  const allowedProviderVars = new Set([
    ...(ENV_KEY_MAP[providerId] || []),
    CANONICAL_PI_ENV[providerId],
  ].filter(Boolean));

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

  const headlessDir = ensureHeadlessPiAgentDir(process.env);
  if (headlessDir && !childEnv.PI_CODING_AGENT_DIR) {
    childEnv.PI_CODING_AGENT_DIR = headlessDir;
  }

  const targetVar = CANONICAL_PI_ENV[providerId];
  if (targetVar && !childEnv[targetVar]) {
    for (const aliasVar of ENV_KEY_MAP[providerId] || []) {
      if (childEnv[aliasVar] && String(childEnv[aliasVar]).trim()) {
        childEnv[targetVar] = String(childEnv[aliasVar]).trim();
        break;
      }
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

  const headlessDir = ensureHeadlessPiAgentDir(process.env);
  const env = headlessDir
    ? { ...process.env, PI_CODING_AGENT_DIR: headlessDir }
    : process.env;

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
  const piAi = await loadPiAi();
  const store = new piAi.InMemoryCredentialStore();
  const piBin = resolvePiBin();
  const headlessDir = ensureHeadlessPiAgentDir(process.env);

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
    const authEnv = headlessDir
      ? { ...process.env, PI_CODING_AGENT_DIR: headlessDir }
      : process.env;
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
