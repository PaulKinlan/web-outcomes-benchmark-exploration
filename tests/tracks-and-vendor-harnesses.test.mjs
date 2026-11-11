import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandHarnessSelection,
  getHarnessSpec,
  getTrackForCell,
  describeTrack,
  isModelCompatibleWithHarness,
  normalizeHarnessId,
  resolvePiExtensionHarness,
} from '../src/harness/harness-registry.mjs';
import { planWorkflowShards } from '../src/runner/shard-planner.mjs';
import { loadModelRegistryConfig } from '../src/harness/model-registry.mjs';
import { capturePiSystemPrompt } from '../src/harness/generate.mjs';
import { anthropicCompatForModel, buildCleanRoomPiModelsConfig } from '../src/harness/pi-auth-bridge.mjs';
import { pickLiveModelId, resolveLiveRoute, resetLiveModelIdCache } from '../src/harness/model-id-resolver.mjs';

const models = loadModelRegistryConfig().models;
const byKey = (k) => models.find((m) => m.key === k);

describe('Tracks', () => {
  it('names the three ways a model is run', () => {
    assert.equal(getTrackForCell('pi', 'oneshot'), 'direct-oneshot');
    assert.equal(getTrackForCell('pi', 'agent'), 'direct-agent');
    assert.equal(getTrackForCell('claude-acp', 'agent'), 'harness:claude-acp');
    assert.equal(describeTrack('direct-oneshot').kind, 'direct');
    const cc = describeTrack('harness:claude-acp');
    assert.equal(cc.kind, 'vendor-harness');
    assert.ok(cc.label);
  });
});

describe('Vendor harnesses', () => {
  it('registers Gemini CLI, Qwen Code, Kimi CLI and Muse with a launch recipe', () => {
    for (const id of ['gemini-acp', 'qwen-acp', 'kimi-acp']) {
      const spec = getHarnessSpec(id);
      assert.ok(spec, id);
      assert.equal(spec.protocol, 'acp');
      assert.ok(Array.isArray(spec.args) && spec.args.length > 0, `${id} needs ACP launch args`);
      assert.deepEqual(spec.supportsModes, ['agent']);
    }
    assert.equal(getHarnessSpec('kimi-acp').installer, 'pip');
    assert.equal(getHarnessSpec('qwen-acp').modelEnvVar, 'OPENAI_MODEL');
    const muse = getHarnessSpec('muse-msp');
    assert.equal(muse.protocol, 'pi-extension');
    assert.equal(muse.extensionPackage, 'pi-muse-msp');
  });

  it('expands harness groups', () => {
    const all = expandHarnessSelection('all');
    for (const id of ['pi', 'claude-acp', 'codex-acp', 'gemini-acp', 'qwen-acp', 'kimi-acp', 'muse-msp']) {
      assert.ok(all.includes(id), `all should include ${id}`);
    }
    assert.ok(!expandHarnessSelection('vendor').includes('pi'));
    assert.ok(!expandHarnessSelection('acp').includes('muse-msp'));
    assert.equal(normalizeHarnessId('gemini-cli'), 'gemini-acp');
  });

  it('only pairs a vendor harness with its own vendor models', () => {
    assert.equal(isModelCompatibleWithHarness(byKey('gemini-3-8-flash'), 'gemini-acp'), true);
    assert.equal(isModelCompatibleWithHarness(byKey('gemini-3-8-flash'), 'claude-acp'), false);
    assert.equal(isModelCompatibleWithHarness(byKey('kimi-k3'), 'kimi-acp'), true);
    assert.equal(isModelCompatibleWithHarness(byKey('kimi-k3'), 'qwen-acp'), false);
    assert.equal(isModelCompatibleWithHarness(byKey('qwen3-8-flash'), 'qwen-acp'), true);
    assert.equal(isModelCompatibleWithHarness(byKey('muse-wonder'), 'muse-msp'), true);
    assert.equal(isModelCompatibleWithHarness(byKey('claude-sonnet-5-5'), 'muse-msp'), false);
  });

  it('plans one harness lane per model plus the direct lanes', () => {
    const plan = planWorkflowShards({
      modelsRaw: 'gemini-3-8-flash,kimi-k3,qwen3-8-flash,muse-wonder,claude-sonnet-5-5',
      harness: 'all',
      mode: 'both',
      spec: 'freeform',
      promptScope: 'pilot',
      strictModels: true,
    });
    const lanes = new Set(plan.generateShards.map((s) => `${s.model}|${s.harness}|${s.mode}`));
    for (const lane of [
      'gemini-3-8-flash|gemini-acp|agent',
      'kimi-k3|kimi-acp|agent',
      'qwen3-8-flash|qwen-acp|agent',
      'muse-wonder|muse-msp|agent',
      'claude-sonnet-5-5|claude-acp|agent',
      'gemini-3-8-flash|pi|agent',
      'gemini-3-8-flash|pi|oneshot',
    ]) {
      assert.ok(lanes.has(lane), `missing lane ${lane} in ${[...lanes].join(', ')}`);
    }
    assert.ok(!lanes.has('gemini-3-8-flash|claude-acp|agent'));
    assert.ok(![...lanes].some((l) => /-(acp|msp)\|oneshot$/.test(l)), 'vendor harnesses are agent-only');
  });

  it('reports what is missing when the Muse host is not installed', () => {
    const prev = process.env.PI_MUSE_BINARY;
    process.env.PI_MUSE_BINARY = 'definitely-not-a-real-muse-binary';
    try {
      const res = resolvePiExtensionHarness('muse-msp');
      assert.equal(res.available, false);
      assert.ok(res.missing.some((m) => /muse/.test(m)));
    } finally {
      if (prev === undefined) delete process.env.PI_MUSE_BINARY;
      else process.env.PI_MUSE_BINARY = prev;
    }
  });
});

describe('System prompt capture', () => {
  it('records the clean-room pi system prompt and a stable hash', async () => {
    const a = await capturePiSystemPrompt(process.cwd());
    const b = await capturePiSystemPrompt(process.cwd());
    assert.ok(a && a.text.length > 100);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.equal(a.sha256, b.sha256);
  });
});

describe('Pilot regressions (run 11)', () => {
  it('sends adaptive thinking to Claude 4.6+ and 5.x models that pi does not know yet', () => {
    assert.equal(anthropicCompatForModel('claude-sonnet-5-5').forceAdaptiveThinking, true);
    assert.equal(anthropicCompatForModel('claude-opus-4-7').forceAdaptiveThinking, true);
    assert.equal(anthropicCompatForModel('claude-haiku-4-5-20251001'), null);
    assert.equal(anthropicCompatForModel('claude-sonnet-4-20250514'), null);
    assert.equal(anthropicCompatForModel('claude-3-5-sonnet-latest'), null);
    const cfg = buildCleanRoomPiModelsConfig();
    const sonnet = cfg.providers.anthropic.models.find((m) => m.id === 'claude-sonnet-5-5');
    assert.equal(sonnet.compat.forceAdaptiveThinking, true);
  });

  it('switches a short model name to the versioned id the provider actually lists', async () => {
    assert.deepEqual(pickLiveModelId('muse-wonder', [], ['muse-spark-1.3', 'muse-wonder-1.0', 'muse-wonder-1.1']), {
      modelId: 'muse-wonder-1.1',
      method: 'versioned-id',
    });
    assert.equal(pickLiveModelId('muse-wonder', ['muse-wonder-1.0'], ['muse-wonder-1.0', 'muse-wonder-1.1']).method, 'alias');
    assert.equal(pickLiveModelId('muse-wonder', [], ['muse-spark-1.3']), null);

    const env = { MUSE_API_KEY: 'test-key' };
    const fetchImpl = async (url, init) => {
      assert.match(url, /\/models$/);
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      return { ok: true, json: async () => ({ data: [{ id: 'muse-spark-1.3' }, { id: 'muse-wonder-1.0' }] }) };
    };
    resetLiveModelIdCache();
    const entry = byKey('muse-wonder');
    const route = { provider: 'muse', modelId: 'muse-wonder', api: 'openai-completions' };
    const live = await resolveLiveRoute(entry, route, { fetchImpl, env });
    assert.equal(live.modelId, 'muse-wonder-1.0');
    assert.equal(live.modelIdResolution.requested, 'muse-wonder');
    assert.ok(buildCleanRoomPiModelsConfig().providers.muse.models.some((m) => m.id === 'muse-wonder-1.0'));

    resetLiveModelIdCache();
    const missing = await resolveLiveRoute(entry, route, {
      env,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'muse-spark-1.3' }] }) }),
    });
    assert.equal(missing.modelIdResolution.method, 'not-listed');
    assert.deepEqual(missing.modelIdResolution.availableModelIds, ['muse-spark-1.3']);

    resetLiveModelIdCache();
    const offline = await resolveLiveRoute(entry, route, { env, fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(offline.modelId, 'muse-wonder');
    resetLiveModelIdCache();
    const other = await resolveLiveRoute(byKey('claude-sonnet-5-5'), { provider: 'anthropic', modelId: 'claude-sonnet-5-5' });
    assert.equal(other.modelIdResolution, undefined);
  });
});
