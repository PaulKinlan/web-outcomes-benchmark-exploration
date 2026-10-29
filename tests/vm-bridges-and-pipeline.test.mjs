import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolvePiBinInfo,
  getPiRuntimeInfo,
  resetPiLoaderCache,
} from '../src/harness/pi-loader.mjs';
import {
  listProviderBridges,
  resolveExtensionTarget,
  resolveBridgeForProvider,
  BLOCKED_CAPABILITY_PACKAGES,
} from '../src/harness/provider-bridges.mjs';
import {
  scrubEnvForProvider,
  ensureHeadlessPiAgentDir,
} from '../src/harness/pi-auth-bridge.mjs';
import { buildSanitizedServerEnv } from '../src/materialize/server-runner.mjs';
import { normalizePipelineStage } from '../src/runner/orchestrator.mjs';
import { parseCliArgs, formatMarkdownSummary } from '../bin/bench.mjs';
import { measureNodeCpuBaselineMs } from '../src/benchmarks/canary.mjs';

describe('Portable pi Runtime, Clean-Room Provider Bridges & Split VM Pipeline', () => {
  it('resolves portable .pi-runtime binary and honors PI_BIN overrides', () => {
    resetPiLoaderCache();
    const info = getPiRuntimeInfo({ skipCache: true });
    assert.ok(info.binPath, 'Expected pi binary to resolve');
    assert.ok(
      ['local-npm', 'local-npm-runtime', 'global-fallback', 'env-override'].includes(info.source)
    );

    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-bin-test-'));
    const fakePi = join(tmpDir, 'mock-pi');
    writeFileSync(fakePi, '#!/bin/sh\necho "0.99.0"\n', { mode: 0o755 });

    const prev = process.env.PI_BIN;
    try {
      process.env.PI_BIN = fakePi;
      const overridden = resolvePiBinInfo({ skipCache: true });
      assert.equal(overridden.source, 'env-override');
      assert.equal(overridden.binPath, fakePi);
      assert.equal(overridden.portable, true);
    } finally {
      if (prev === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prev;
      resetPiLoaderCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves clean-room provider bridge entrypoints and blocks capability plugins', () => {
    assert.ok(BLOCKED_CAPABILITY_PACKAGES.has('pi-autoresearch'));
    assert.ok(BLOCKED_CAPABILITY_PACKAGES.has('pi-subagents'));
    assert.ok(BLOCKED_CAPABILITY_PACKAGES.has('pi-web-access'));

    const tmpDir = mkdtempSync(join(tmpdir(), 'pi-bridge-test-'));
    try {
      // 1. Blocked capability package must never resolve as a bridge
      const blockedDir = join(tmpDir, 'blocked');
      rmSync(blockedDir, { recursive: true, force: true });
      const museDir = join(tmpDir, 'muse-ext');
      writeFileSync(
        join(tmpDir, 'single-muse.ts'),
        'export default function registerMuseProvider() {}\n',
        'utf8'
      );

      const prevMuse = process.env.PI_BRIDGE_MUSE;
      try {
        process.env.PI_BRIDGE_MUSE = join(tmpDir, 'single-muse.ts');
        const museBridge = resolveBridgeForProvider('muse');
        assert.ok(museBridge, 'Expected muse bridge to resolve from PI_BRIDGE_MUSE');
        assert.equal(museBridge.installed, true);
        assert.deepEqual(museBridge.cliFlags, ['-e', join(tmpDir, 'single-muse.ts')]);
      } finally {
        if (prevMuse === undefined) delete process.env.PI_BRIDGE_MUSE;
        else process.env.PI_BRIDGE_MUSE = prevMuse;
      }

      // 2. Verify package.json with blocked name returns null
      const badPkgDir = mkdtempSync(join(tmpdir(), 'pi-bad-pkg-'));
      writeFileSync(
        join(badPkgDir, 'package.json'),
        JSON.stringify({ name: 'pi-autoresearch', version: '1.0.0', pi: { extensions: ['./index.js'] } })
      );
      writeFileSync(join(badPkgDir, 'index.js'), 'export default {}');
      assert.equal(resolveExtensionTarget(badPkgDir), null);
      rmSync(badPkgDir, { recursive: true, force: true });

      const bridges = listProviderBridges();
      const ids = bridges.map((b) => b.id);
      assert.ok(ids.includes('antigravity'));
      assert.ok(ids.includes('codex-bridge'));
      assert.ok(ids.includes('claude-bridge'));
      assert.ok(ids.includes('muse'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('scrubs unrelated secrets from pi subprocesses and strips ALL secrets from generated $PORT servers', () => {
    const mockEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/home',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai-secret',
      DEEPSEEK_API_KEY: 'sk-deepseek-secret',
      GITHUB_TOKEN: 'ghs_secret_ci_token',
      PI_AUTH_JSON_B64: 'eyJ0ZXN0Ijp0cnVlfQ==',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/gcp/creds.json',
    };

    // Active provider = deepseek -> ONLY DEEPSEEK_API_KEY survives
    const deepseekEnv = scrubEnvForProvider(mockEnv, 'deepseek');
    assert.equal(deepseekEnv.DEEPSEEK_API_KEY, 'sk-deepseek-secret');
    assert.equal(deepseekEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(deepseekEnv.OPENAI_API_KEY, undefined);
    assert.equal(deepseekEnv.GITHUB_TOKEN, undefined);
    assert.equal(deepseekEnv.PI_AUTH_JSON_B64, undefined);

    // Generated $PORT server -> ZERO API keys, tokens, or cloud credentials survive
    const serverEnv = buildSanitizedServerEnv({ PORT: '4999', NODE_ENV: 'production' }, mockEnv);
    assert.equal(serverEnv.PORT, '4999');
    assert.equal(serverEnv.PATH, '/usr/bin:/bin');
    assert.equal(serverEnv.DEEPSEEK_API_KEY, undefined);
    assert.equal(serverEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(serverEnv.OPENAI_API_KEY, undefined);
    assert.equal(serverEnv.GITHUB_TOKEN, undefined);
    assert.equal(serverEnv.PI_AUTH_JSON_B64, undefined);
    assert.equal(serverEnv.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(serverEnv.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  });

  it('hydrates PI_AUTH_JSON_B64 into an isolated ephemeral directory for headless VMs', () => {
    const sampleAuth = JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'tok_test' } });
    const b64 = Buffer.from(sampleAuth, 'utf8').toString('base64');
    const dir = ensureHeadlessPiAgentDir({ PI_AUTH_JSON_B64: b64 });
    assert.ok(dir, 'Expected ephemeral agent dir to be created');
    const written = readFileSync(join(dir, 'auth.json'), 'utf8');
    assert.equal(written, sampleAuth);
  });

  it('parses split CLI stages, median audit-runs, and formats GitHub Step Summary markdown', () => {
    assert.equal(normalizePipelineStage('generate'), 'generate');
    assert.equal(normalizePipelineStage('audit'), 'audit');
    assert.equal(normalizePipelineStage('all'), 'all');

    const parsed = parseCliArgs([
      'node',
      'bin/bench.mjs',
      '--stage=audit',
      '--audit-runs=3',
      '--mode=agent',
      '--models=deepseek-flash,gemini-4-argon',
      '--markdown-summary=/tmp/step-summary.md',
    ]);
    assert.equal(parsed.stage, 'audit');
    assert.equal(parsed.auditRuns, 3);
    assert.equal(parsed.mode, 'agent');
    assert.deepEqual(parsed.modelKeys, ['deepseek-flash', 'gemini-4-argon']);
    assert.equal(parsed.markdownSummaryPath, '/tmp/step-summary.md');

    const cpuProbe = measureNodeCpuBaselineMs();
    assert.ok(typeof cpuProbe.nodeCpuComputeMs === 'number' && cpuProbe.nodeCpuComputeMs >= 0);

    const md = formatMarkdownSummary({
      totals: { cells: 2, agentCells: 1, oneshotCells: 1 },
      environment: { piVersion: '0.85.1', piSource: 'local-npm-runtime' },
      canary: {
        status: 'stable',
        nodeCpuComputeMs: 4.2,
        browserMainThreadComputeMs: 18.5,
        referenceFcpMs: 64,
        host: { cpuModel: 'Apple M-Series', cpuCores: 12 },
      },
      leaderboard: [
        {
          label: 'DeepSeek Flash (V4.1)',
          mode: 'agent',
          cellsRun: 1,
          dominantStack: 'vanilla + express',
          scores: { composite: 92.4, lighthouse: 98, uplift: 91, deepPerf: 94, memory: 90 },
          averages: { mobileLcpMs: 420, inpMs: 24, burstP95TtfbMs: 12 },
        },
      ],
    });
    assert.match(md, /Clean-Room `pi` Runtime/);
    assert.match(md, /STABLE/);
    assert.match(md, /DeepSeek Flash \(V4\.1\)/);
  });
});
