import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelRegistryConfig, initializeModelRuntime, selectModels } from '../src/harness/model-registry.mjs';

test('model registry includes modern October 2026 frontier & flash families', async () => {
  const cfg = loadModelRegistryConfig();
  const keys = new Set(cfg.models.map((m) => m.key));

  for (const expectedKey of [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-sonnet-4-6',
    'gemini-4-argon',
    'gemini-3-8-flash',
    'gemini-3-7-flash',
    'gemini-3-5-flash-lite',
    'gpt-6-1-terra-pro',
    'gpt-6-1-terra',
    'gpt-6-1-sol',
    'deepseek-v4-1-flash-1017',
    'deepseek-v4-pro',
    'qwen3-8-max-prime',
    'qwen3-8-omni-flash',
    'kimi-k3-1-pro',
    'glm-5-3-prime',
    'grok-4-7',
  ]) {
    assert.ok(keys.has(expectedKey), `Missing model key "${expectedKey}" in config/models.json`);
  }

  const prevDeepseekKey = process.env.DEEPSEEK_API_KEY;
  try {
    let runtime = await initializeModelRuntime();
    assert.ok(runtime.models.length >= 25);

    let { usable } = selectModels(runtime, { onlyReady: true });
    if (usable.length === 0) {
      // On unauthenticated CI runners (push/PR without secrets), verify route activation using a synthetic key
      process.env.DEEPSEEK_API_KEY = 'sk-ci-unit-test-placeholder';
      runtime = await initializeModelRuntime();
      ({ usable } = selectModels(runtime, { onlyReady: true }));
    }

    assert.ok(usable.length >= 1, 'Expected model route activation when provider key is present');

    // Verify synthetic pi-ai model descriptor construction on ready pi-ai routes
    const directPiAiModel = usable.find((m) => m.activeRoute?.transport === 'pi-ai');
    assert.ok(directPiAiModel, 'Expected at least one pi-ai transport route');
    assert.ok(directPiAiModel.activeRoute.piModel.id);
    assert.ok(directPiAiModel.activeRoute.piModel.api);
    assert.ok(directPiAiModel.activeRoute.piModel.baseUrl.startsWith('http'));
  } finally {
    if (prevDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevDeepseekKey;
  }
});

test('Grok runs through the xAI Responses API, the one pi-ai uses for every Grok 4 model', async () => {
  const cfg = loadModelRegistryConfig();
  const xaiRoutes = cfg.models.flatMap((m) => (m.routes || []).filter((r) => r.provider === 'xai'));
  assert.ok(xaiRoutes.length > 0);
  assert.ok(xaiRoutes.every((r) => r.api === 'openai-responses'), 'xai routes must use openai-responses');
  const { buildCleanRoomPiModelsConfig } = await import('../src/harness/pi-auth-bridge.mjs');
  assert.equal(buildCleanRoomPiModelsConfig().providers.xai.api, 'openai-responses');
});
