import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAcpCodingSession, pickAcpAuthMethods } from '../src/harness/acp-client.mjs';
import { getHarnessSpec } from '../src/harness/harness-registry.mjs';
import {
  planWorkflowShards,
  validateModelSelectors,
  maxAgentPromptsPerShard,
} from '../src/runner/shard-planner.mjs';
import { loadModelRegistryConfig } from '../src/harness/model-registry.mjs';

// Minimal ACP agent that mimics claude-code-acp: it advertises CLI aliases ("default", "sonnet") rather than
// full model ids, and either passes any id through session/set_model or rejects it (MOCK_REJECT_SET_MODEL).
const MOCK_AGENT = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let current = process.env.MOCK_CURRENT || 'default';
const withConfig = process.env.MOCK_CONFIG_OPTION === '1';
const needAuth = process.env.MOCK_REQUIRE_AUTH === '1';
let authed = false;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id != null && !msg.method) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-cc-acp', version: '0.0.1' }, agentCapabilities: {}, authMethods: needAuth ? [{ id: 'chatgpt', name: 'Login' }, { id: process.env.MOCK_AUTH_METHOD || 'openai-api-key', name: 'API key' }] : [] } });
  } else if (msg.method === 'authenticate') {
    if (msg.params.methodId === 'chatgpt') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'needs a browser' } }); return; }
    authed = true;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/new' && needAuth && !authed) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      sessionId: 's1',
      modes: { availableModes: [{ id: 'bypassPermissions', name: 'Bypass' }] },
      models: { currentModelId: current, availableModels: [{ modelId: 'default', name: 'Default (recommended)' }, { modelId: 'sonnet', name: 'Sonnet' }] },
      configOptions: withConfig ? [{ id: 'model', category: 'model', currentValue: current, options: [{ value: 'default' }, { value: 'sonnet' }, ...(current !== 'default' ? [{ value: current }] : [])] }] : undefined,
    } });
  } else if (msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'locked' } });
  } else if (msg.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/set_model') {
    if (process.env.MOCK_REJECT_SET_MODEL === '1' || process.env.MOCK_CURRENT) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown model' } });
    } else {
      current = msg.params.modelId;
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  } else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'model=' + current } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

async function runMock(extraEnv = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'acp-model-sel-'));
  const workspaceDir = join(tmpRoot, 'agent-workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const agentPath = join(tmpRoot, 'mock-agent.mjs');
  writeFileSync(agentPath, MOCK_AGENT, 'utf8');
  try {
    return await runAcpCodingSession({
      command: process.execPath,
      args: [agentPath],
      workspaceDir,
      env: { PATH: process.env.PATH, ...extraEnv },
      harnessSpec: getHarnessSpec('claude-acp'),
      desiredModelId: 'claude-sonnet-5-5',
      desiredModelKey: 'claude-sonnet-5-5',
      promptText: 'Build a page.',
      timeoutMs: 15_000,
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

describe('ACP model selection', () => {
  it('passes an unlisted full model id through session/set_model instead of staying on "default"', async () => {
    const res = await runMock();
    assert.equal(res.ok, true, res.error);
    assert.equal(res.selectedModelId, 'claude-sonnet-5-5');
    assert.equal(res.modelSelection.method, 'passthrough-model-id');
    assert.equal(res.modelSelection.verified, true);
    assert.equal(res.modelSelection.reportedAtSessionStart, 'default');
    assert.match(res.assistantText, /model=claude-sonnet-5-5/);
    assert.equal(res.trajectory.acpMeta.modelSelection.verified, true);
  });

  it('fails the cell rather than benchmarking the adapter default when the model cannot be selected', async () => {
    const res = await runMock({ MOCK_REJECT_SET_MODEL: '1' });
    assert.equal(res.ok, false);
    assert.match(res.error, /did not accept requested model "claude-sonnet-5-5"/);
    assert.equal(res.modelSelection.verified, false);
    assert.equal(res.selectedModelId, 'default');
    assert.equal(res.assistantText, '');
  });

  it('falls back to session/set_model when the model config option cannot select the requested id', async () => {
    const res = await runMock({ MOCK_CONFIG_OPTION: '1' });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.modelSelection.method, 'passthrough-model-id');
    assert.equal(res.selectedModelId, 'claude-sonnet-5-5');
  });

  it('accepts a session that already reports the requested model even when every setter is locked', async () => {
    const res = await runMock({ MOCK_CONFIG_OPTION: '1', MOCK_CURRENT: 'claude-sonnet-5-5' });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.modelSelection.method, 'already-current');
    assert.equal(res.modelSelection.verified, true);
  });

  it('authenticates with an API-key method when the agent answers "Authentication required"', async () => {
    const res = await runMock({ MOCK_REQUIRE_AUTH: '1' });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.trajectory.acpMeta.authMethodUsed, 'openai-api-key');
    assert.equal(res.selectedModelId, 'claude-sonnet-5-5');
  });

  it('never picks an interactive login, and says which methods were offered', async () => {
    assert.deepEqual(pickAcpAuthMethods([{ id: 'chatgpt' }, { id: 'oauth-personal' }, { id: 'gemini-api-key' }, { id: 'openai' }], ['openai']), ['openai', 'gemini-api-key']);
    const res = await runMock({ MOCK_REQUIRE_AUTH: '1', MOCK_AUTH_METHOD: 'device-login' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Authentication required \(agent offered auth methods: chatgpt, device-login/);
  });

  it('pins Claude Code to the requested model through ANTHROPIC_MODEL', () => {
    assert.equal(getHarnessSpec('claude-acp').modelEnvVar, 'ANTHROPIC_MODEL');
  });
});

describe('Workflow shard planning', () => {
  const registryModels = loadModelRegistryConfig().models;

  it('resolves version-suffixed Muse Wonder and flags typos with suggestions', () => {
    assert.deepEqual(validateModelSelectors(['muse-wonder-1.0', 'grok-4.7', 'anthropic/claude-x'], registryModels), []);
    const unknown = validateModelSelectors(['muse-wondr'], registryModels);
    assert.equal(unknown.length, 1);
    assert.ok(unknown[0].suggestions.includes('muse-wonder'));
  });

  it('fails fast in strict mode on unrecognized models', () => {
    assert.throws(
      () => planWorkflowShards({ modelsRaw: 'deepseek-flash,muse-wondr', strictModels: true }),
      /Unrecognized model selector\(s\): "muse-wondr"/
    );
    const lenient = planWorkflowShards({ modelsRaw: 'deepseek-flash,muse-wondr', promptScope: 'pilot' });
    assert.equal(lenient.unknownModels[0].selector, 'muse-wondr');
  });

  it('keeps every agent shard small enough to finish inside the generate job timeout', () => {
    const cap = maxAgentPromptsPerShard({ jobTimeoutMinutes: 90, agentTimeoutMs: 900000, agentConcurrency: 2 });
    assert.equal(cap, 10);

    // The Nov 6 matrix: 8 models, all harnesses, both modes, both specs, all 37 prompts.
    const plan = planWorkflowShards({
      modelsRaw: 'deepseek-flash,gemini-3.8-flash,grok-4.7,claude-sonnet-5-5,gpt-6-1-sol,kimi-k3,kimi-k3-1-pro,muse-wonder',
      harness: 'all',
      mode: 'both',
      spec: 'both',
      strictModels: true,
    });
    assert.ok(plan.generateShards.length <= 256, `matrix too large: ${plan.generateShards.length}`);
    const agentShards = plan.generateShards.filter((s) => s.mode === 'agent');
    assert.ok(agentShards.length > 0);
    assert.ok(agentShards.every((s) => s.promptCount <= cap), 'agent shard exceeds time budget');
    assert.deepEqual(plan.warnings, []);
  });

  it('bounds one-shot-only matrices to the generate job budget', () => {
    const keys = registryModels.filter((m) => m.enabled !== false).map((m) => m.key);
    assert.ok(keys.length >= 30);
    const plan = planWorkflowShards({ modelsRaw: keys.join(','), harness: 'pi', mode: 'oneshot', spec: 'both' });
    assert.ok(plan.generateShards.length <= 240, `too many generate jobs: ${plan.generateShards.length}`);
    const covered = plan.generateShards.reduce((n, s) => n + s.promptCount, 0);
    assert.equal(covered, plan.totalCells);
  });

  it('rejects a matrix with more combinations than generate jobs', () => {
    assert.throws(
      () => planWorkflowShards({ modelsRaw: 'a,b,c', mode: 'both', spec: 'both', maxGenerateShards: 10 }),
      /split the run/
    );
  });
});
