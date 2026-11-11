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
