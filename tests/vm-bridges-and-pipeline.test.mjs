import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
import { buildSanitizedServerEnv, hasBrokenNodeModules } from '../src/materialize/server-runner.mjs';
import { normalizePipelineStage } from '../src/runner/orchestrator.mjs';
import { planWorkflowShards } from '../src/runner/shard-planner.mjs';
import { withTimeout } from '../src/benchmarks/cdp-helpers.mjs';
import { matchesModelSelector } from '../src/harness/model-registry.mjs';
import { parseCliArgs, formatMarkdownSummary, formatPhaseBreakdownLine } from '../bin/bench.mjs';
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

    const sampleGemini = {
      key: 'gemini-3-8-flash',
      routes: [{ provider: 'google', modelId: 'gemini-3.8-flash' }],
    };
    assert.equal(matchesModelSelector(sampleGemini, 'gemini-3-8-flash'), true);
    assert.equal(matchesModelSelector(sampleGemini, 'gemini-3.8-flash'), true);
    assert.equal(matchesModelSelector(sampleGemini, 'google/gemini-3.8-flash'), true);
    assert.equal(matchesModelSelector(sampleGemini, 'nonexistent-model'), false);

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

  it('dynamically shards 148+ cells across isolated Audit VMs and supports reuse_generation_run_id', () => {
    const fullPlan = planWorkflowShards({
      modelsRaw: 'gemini-3.8-flash,deepseek-flash',
      promptScope: 'all',
      mode: 'both',
      auditRuns: 1,
    });
    assert.equal(fullPlan.totalCells, 148);
    assert.equal(fullPlan.skipGenerate, false);
    assert.equal(fullPlan.auditShards.length, 40); // 2 models × 2 modes × 10 chunks (~3.7 cells/VM shard!)
    assert.ok(fullPlan.auditShards.every((s) => s.cellCount <= 4));
    assert.ok(fullPlan.generateShards.length >= 20 && fullPlan.generateShards.length <= 120);

    // Reusing a prior GitHub Actions Run ID skips generation completely while fanning out 40 audit VMs
    const reusePlan = planWorkflowShards({
      modelsRaw: 'gemini-3-8-flash,deepseek-flash',
      promptScope: 'all',
      mode: 'both',
      auditRuns: 1,
      reuseGenerationRunId: '18999888777',
    });
    assert.equal(reusePlan.skipGenerate, true);
    assert.equal(reusePlan.generateShards.length, 0);
    assert.equal(reusePlan.auditShards.length, 40);
    assert.ok(reusePlan.auditShards.every((s) => s.artifactPattern === 'generated-cells-*'));

    // Massive 6-model × 37-prompt × 2-mode × 3-auditRuns matrix stays safely below GitHub 256-job cap
    const massivePlan = planWorkflowShards({
      modelsRaw: 'm1,m2,m3,m4,m5,m6',
      promptScope: 'all',
      mode: 'both',
      auditRuns: 3,
    });
    assert.equal(massivePlan.totalCells, 444);
    assert.ok(massivePlan.auditShards.length <= 160);
    assert.ok(massivePlan.generateShards.length <= 120);
  });

  it('detects broken dereferenced node_modules/.bin artifacts and bounds wedged CDP promises', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'nm-check-'));
    try {
      mkdirSync(join(tmpDir, 'node_modules', 'vite', 'bin'), { recursive: true });
      mkdirSync(join(tmpDir, 'node_modules', '.bin'), { recursive: true });
      const targetCli = join(tmpDir, 'node_modules', 'vite', 'bin', 'vite.js');
      writeFileSync(targetCli, '#!/usr/bin/env node\nconsole.log("ok");\n', { mode: 0o755 });
      symlinkSync('../vite/bin/vite.js', join(tmpDir, 'node_modules', '.bin', 'vite'));
      assert.equal(hasBrokenNodeModules(tmpDir), false);

      // Simulate actions/upload-artifact@v4 zip/unzip dereferencing symlink & stripping +x mode
      rmSync(join(tmpDir, 'node_modules', '.bin', 'vite'));
      writeFileSync(join(tmpDir, 'node_modules', '.bin', 'vite'), '#!/usr/bin/env node\n', { mode: 0o644 });
      if (process.platform !== 'win32') {
        assert.equal(hasBrokenNodeModules(tmpDir), true);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 40, 'wedged-heap-snapshot'),
      /wedged-heap-snapshot timed out after 40ms/
    );
  });

  it('formats per-phase cell audit timings, VM fleet canary stats, and failure diagnostics', () => {
    const phaseLine = formatPhaseBreakdownLine({
      phasesMs: {
        materializeMs: 1240,
        flowCompileMs: 1620,
        benchmarks: {
          'tech-stack': 1850,
          'lighthouse-uplift': 8410,
          'deep-perf': 6120,
          memory: 5890,
        },
      },
    });
    assert.match(phaseLine, /mat 1\.2s/);
    assert.match(phaseLine, /lh\+up 8\.4s/);
    assert.match(phaseLine, /mem 5\.9s/);

    const md = formatMarkdownSummary({
      totals: { cells: 148, agentCells: 74, oneshotCells: 74 },
      environment: { piVersion: '0.85.1', piSource: 'local-npm-runtime' },
      observability: {
        vmCanaryFleet: {
          shardCount: 40,
          statusCounts: { stable: 39, warning: 1, noisy: 0 },
          nodeCpuMs: { minMs: 4, medianMs: 5, maxMs: 7 },
          chromeMainThreadMs: { minMs: 18, medianMs: 21, maxMs: 27 },
        },
        generationTiming: { count: 148, medianMs: 14200, p95Ms: 48000, maxMs: 65000, totalMs: 2400000 },
        auditTiming: {
          count: 148,
          medianMs: 25100,
          p95Ms: 39400,
          maxMs: 52000,
          totalMs: 3850000,
          phaseMediansMs: {
            materializeMs: 1200,
            flowCompileMs: 1600,
            techStackMs: 1800,
            lighthouseUpliftMs: 8500,
            deepPerfMs: 6100,
            memoryMs: 5900,
          },
        },
        slowestCells: [
          {
            cellId: 'gemini-3-8-flash__minecraft-clone__agent',
            serverArchitecture: 'production-server',
            status: 'ok',
            totalAuditMs: 52000,
            slowestPhase: 'lighthouse-uplift',
            slowestPhaseMs: 16200,
          },
        ],
        failedCells: [
          {
            cellId: 'deepseek-flash__pomodoro-study-workspace__agent',
            status: 'timeout',
            failedStage: 'memory',
            durationMs: 180000,
            error: 'HeapProfiler.takeHeapSnapshot timed out after 20000ms [active stage: memory]',
          },
        ],
      },
      leaderboard: [],
    });

    assert.match(md, /Sharded VM Fleet Canary \(40 isolated VMs\)/);
    assert.match(md, /Execution Timing & Pipeline Observability/);
    assert.match(md, /Slowest Audited Cells/);
    assert.match(md, /Failed \/ Timed-Out Cells \(1\)/);
  });
});
