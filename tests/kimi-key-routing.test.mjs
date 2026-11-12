import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyKimiKeyProbe,
  kimiKeyKind,
  probeKimiKey,
  resetKimiKeyProbe,
  resolveKimiCliCredential,
} from '../src/harness/kimi-key-probe.mjs';
import { resolveProviderApiKeyFromEnv } from '../src/harness/pi-auth-bridge.mjs';

const KEY = 'sk-kimi-example-platform-key';

function fakeFetch(statusByHost, calls = []) {
  return async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const host = new URL(url).host;
    const status = statusByHost[host] ?? 401;
    return {
      ok: status === 200,
      status,
      json: async () => ({ data: [{ id: 'kimi-k3' }, { id: 'kimi-k3.1-pro' }, { id: 'moonshot-v1-8k' }] }),
    };
  };
}

describe('Kimi key routing (Kimi Code key vs Kimi Platform key)', () => {
  it('probes each endpoint and reports the one that accepts the key', async () => {
    const calls = [];
    const res = await probeKimiKey(KEY, { fetchImpl: fakeFetch({ 'api.moonshot.ai': 200 }, calls) });
    assert.equal(res.kind, 'platform');
    assert.equal(res.baseUrl, 'https://api.moonshot.ai/v1');
    assert.ok(res.modelIds.includes('kimi-k3'));
    assert.match(res.summary, /api\.kimi\.com\/coding\/v1=401/);
    assert.ok(!res.summary.includes(KEY));
    assert.ok(calls.every((c) => c.url.endsWith('/models') && c.auth === `Bearer ${KEY}`));
  });

  it('keeps the prefix guess when no endpoint accepts the key or the network fails', async () => {
    const env = { KIMI_API_KEY: KEY };
    const lines = [];
    const res = await applyKimiKeyProbe(env, {
      force: true,
      log: (l) => lines.push(l),
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(res.kind, null);
    assert.equal(env.KIMI_KEY_KIND, undefined);
    assert.equal(kimiKeyKind(env), 'coding');
    assert.ok(lines[0].includes('prefix guess') && !lines[0].includes(KEY));
  });

  it('routes a platform key that starts with sk-kimi- to the platform provider once probed', async () => {
    const env = { KIMI_API_KEY: KEY };
    assert.equal(resolveProviderApiKeyFromEnv('kimi-coding', env), KEY);
    await applyKimiKeyProbe(env, { force: true, log: () => {}, fetchImpl: fakeFetch({ 'api.moonshot.cn': 200 }) });
    assert.equal(env.KIMI_KEY_KIND, 'platform');
    assert.equal(env.KIMI_KEY_BASE_URL, 'https://api.moonshot.cn/v1');
    assert.equal(resolveProviderApiKeyFromEnv('kimi-coding', env), null);
    assert.equal(resolveProviderApiKeyFromEnv('moonshotai', env), KEY);
    assert.deepEqual(resolveKimiCliCredential(env), {
      provider: 'moonshotai',
      apiKey: KEY,
      baseUrl: 'https://api.moonshot.cn/v1',
      source: 'KIMI_API_KEY',
    });
  });

  it('leaves a real Kimi Code key on the coding route and never re-probes a forced kind', async () => {
    const env = { KIMI_API_KEY: KEY };
    await applyKimiKeyProbe(env, { force: true, log: () => {}, fetchImpl: fakeFetch({ 'api.kimi.com': 200 }) });
    assert.equal(env.KIMI_KEY_KIND, 'coding');
    assert.equal(resolveKimiCliCredential(env).provider, 'kimi-coding');
    assert.equal(resolveKimiCliCredential(env).baseUrl, 'https://api.kimi.com/coding/v1');
    assert.equal(resolveProviderApiKeyFromEnv('moonshotai', env), null);

    const forced = { KIMI_API_KEY: KEY, KIMI_KEY_KIND: 'platform' };
    let called = false;
    await applyKimiKeyProbe(forced, { force: true, fetchImpl: async () => ((called = true), { ok: false, status: 401 }) });
    assert.equal(called, false);
    assert.equal(resolveKimiCliCredential(forced).baseUrl, 'https://api.moonshot.ai/v1');
  });

  it('keeps each CLI key with its own endpoint', () => {
    const only = resolveKimiCliCredential({ MOONSHOT_API_KEY: 'sk-platform' });
    assert.deepEqual([only.provider, only.apiKey, only.baseUrl], ['moonshotai', 'sk-platform', 'https://api.moonshot.ai/v1']);

    const both = resolveKimiCliCredential({
      KIMI_CODING_API_KEY: 'sk-kimi-coding',
      KIMI_API_KEY: KEY,
      KIMI_KEY_KIND: 'platform',
      KIMI_KEY_BASE_URL: 'https://api.moonshot.cn/v1',
    });
    assert.deepEqual([both.provider, both.apiKey, both.baseUrl], ['kimi-coding', 'sk-kimi-coding', 'https://api.kimi.com/coding/v1']);
    assert.equal(resolveKimiCliCredential({}), null);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    resetKimiKeyProbe();
    const env = { KIMI_API_KEY: KEY };
    let release;
    const gate = new Promise((r) => (release = r));
    let calls = 0;
    const slow = async (url) => {
      calls += 1;
      await gate;
      return fakeFetch({ 'api.moonshot.ai': 200 })(url, {});
    };
    const first = applyKimiKeyProbe(env, { log: () => {}, fetchImpl: slow });
    const second = applyKimiKeyProbe(env, { log: () => {}, fetchImpl: slow }).then(() => env.KIMI_KEY_KIND);
    release();
    await first;
    assert.equal(await second, 'platform');
    assert.equal(calls, 3);
    resetKimiKeyProbe();
  });

  it('gives the Kimi CLI harness the settings its API-key sign-in needs', () => {
    const { harnesses } = JSON.parse(readFileSync(new URL('../config/harnesses.json', import.meta.url), 'utf8'));
    const kimi = harnesses.find((h) => h.id === 'kimi-acp');
    assert.equal(kimi.provider, 'kimi-coding');
    assert.equal(kimi.env.KIMI_MODEL_PROVIDER_TYPE, 'kimi');
    assert.equal(kimi.modelEnvVar, 'KIMI_MODEL_NAME');
    const src = readFileSync(new URL('../src/harness/generate.mjs', import.meta.url), 'utf8');
    assert.match(src, /childEnv\.KIMI_MODEL_API_KEY = kimiCli\.apiKey/);
    assert.match(src, /childEnv\.KIMI_MODEL_BASE_URL = kimiCli\.baseUrl/);
  });
});
