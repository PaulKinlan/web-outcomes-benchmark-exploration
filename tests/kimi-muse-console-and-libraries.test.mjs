import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveProviderApiKeyFromEnv,
  buildCleanRoomPiModelsConfig,
  ensureHeadlessPiAgentDir,
} from '../src/harness/pi-auth-bridge.mjs';
import { initializeModelRuntime, selectModels } from '../src/harness/model-registry.mjs';
import { listProviderBridges } from '../src/harness/provider-bridges.mjs';
import { planWorkflowShards } from '../src/runner/shard-planner.mjs';
import { reconcileDetectedLibraries } from '../src/benchmarks/library-signatures.mjs';
import { computeConsoleErrorScore } from '../src/benchmarks/console-errors.bench.mjs';
import { analyzeStaticSource } from '../src/benchmarks/tech-stack.bench.mjs';
import { aggregateAllResults } from '../src/scoring/aggregate.mjs';

describe('Kimi (3.0 & 3.1) + Muse Auth Bridge, Full 37-Prompt Shards, Library-Detector & Console Audit', () => {
  it('routes sk-kimi-* keys to kimi-coding (Anthropic API) and standard keys to moonshotai, plus MUSE_API_KEY to muse', () => {
    const skKimiEnv = { KIMI_API_KEY: 'sk-kimi-example-coding-token-123456' };
    assert.equal(resolveProviderApiKeyFromEnv('kimi-coding', skKimiEnv), 'sk-kimi-example-coding-token-123456');
    assert.equal(resolveProviderApiKeyFromEnv('moonshotai', skKimiEnv), null);

    const moonshotEnv = { KIMI_API_KEY: 'sk-standard-moonshot-open-platform-token' };
    assert.equal(resolveProviderApiKeyFromEnv('kimi-coding', moonshotEnv), null);
    assert.equal(resolveProviderApiKeyFromEnv('moonshotai', moonshotEnv), 'sk-standard-moonshot-open-platform-token');

    const museEnv = { MUSE_API_KEY: 'muse-example-token-abc' };
    assert.equal(resolveProviderApiKeyFromEnv('muse', museEnv), 'muse-example-token-abc');

    const piModelsJson = buildCleanRoomPiModelsConfig({
      KIMI_API_KEY: 'sk-kimi-example-coding-token-123456',
      MUSE_API_KEY: 'muse-example-token-abc',
    });
    assert.ok(piModelsJson.providers['kimi-coding']);
    assert.equal(piModelsJson.providers['kimi-coding'].api, 'anthropic-messages');
    const kimiModelIds = piModelsJson.providers['kimi-coding'].models.map((m) => m.id);
    assert.ok(kimiModelIds.includes('k3'));
    assert.ok(kimiModelIds.includes('k3.1-pro'));

    assert.ok(piModelsJson.providers.muse);
    assert.equal(piModelsJson.providers.muse.api, 'openai-completions');
    const museModelIds = piModelsJson.providers.muse.models.map((m) => m.id);
    assert.ok(museModelIds.includes('muse-spark-1.3'));
    assert.ok(museModelIds.includes('muse-spark-open'));
    assert.ok(museModelIds.includes('muse-wonder'));
    assert.ok(museModelIds.includes('muse-glimmer-30b'));
  });

  it('resolves Kimi 3.0, Kimi 3.1, and Muse Spark models cleanly in model-registry', async () => {
    const prevMuse = process.env.MUSE_API_KEY;
    const prevKimi = process.env.KIMI_API_KEY;
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    const tmpAgentDir = mkdtempSync(join(tmpdir(), 'pi-clean-test-'));

    try {
      process.env.KIMI_API_KEY = 'sk-kimi-test-token-for-registry-check';
      process.env.MUSE_API_KEY = 'muse-test-token-for-registry-check';
      process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
      ensureHeadlessPiAgentDir();
      assert.equal(existsSync(join(tmpAgentDir, 'models.json')), true);

      const rt = await initializeModelRuntime();
      const sel = selectModels(rt, {
        keys: ['kimi-3.0', 'kimi-3.1', 'muse-spark', 'muse-wonder'],
        onlyReady: true,
      });

      assert.equal(sel.unknownKeys.length, 0);
      const keys = sel.usable.map((m) => m.key);
      assert.deepEqual(keys, ['kimi-k3-1-pro', 'kimi-k3', 'muse-spark', 'muse-wonder']);

      const k3 = sel.usable.find((m) => m.key === 'kimi-k3');
      const k31 = sel.usable.find((m) => m.key === 'kimi-k3-1-pro');
      const muse = sel.usable.find((m) => m.key === 'muse-spark');

      assert.equal(k3.activeRoute.provider, 'kimi-coding');
      assert.equal(k3.activeRoute.modelId, 'k3');
      assert.equal(k31.activeRoute.provider, 'kimi-coding');
      assert.equal(k31.activeRoute.modelId, 'k3.1-pro');
      assert.equal(muse.activeRoute.provider, 'muse');
      assert.equal(muse.activeRoute.modelId, 'muse-spark-1.3');
      assert.equal(muse.activeRoute.transport, 'pi-cli');

      const bridges = listProviderBridges();
      const museBridge = bridges.find((b) => b.id === 'muse');
      assert.equal(museBridge.directAuthReady, true);
      assert.ok(museBridge.configuredEnvVars.includes('MUSE_API_KEY'));
    } finally {
      if (prevMuse === undefined) delete process.env.MUSE_API_KEY;
      else process.env.MUSE_API_KEY = prevMuse;
      if (prevKimi === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = prevKimi;
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(tmpAgentDir, { recursive: true, force: true });
    }
  });

  it('defaults planWorkflowShards to all 37 prompts and handles 8 models × 37 prompts × both specs (592 cells)', () => {
    const defaultPlan = planWorkflowShards({
      modelsRaw: 'deepseek-flash,gemini-3.8-flash,grok-4.7,claude-sonnet-5-5,gpt-6-1-sol,kimi-k3,kimi-k3-1-pro,muse-spark',
      mode: 'agent',
      spec: 'both',
      auditRuns: 1,
    });
    assert.equal(defaultPlan.promptCount, 37);
    assert.deepEqual(defaultPlan.specs, ['freeform', 'guided']);
    assert.equal(defaultPlan.totalCells, 8 * 37 * 2); // 592 cells!
    assert.ok(defaultPlan.generateShards.length <= 120);
    assert.ok(defaultPlan.auditShards.length <= 160);
  });

  it('reconciles Library-Detector-for-Chrome runtime globals, HTTP headers, and package.json semvers', () => {
    const files = [
      {
        path: 'package.json',
        content: JSON.stringify({
          dependencies: {
            react: '^19.1.0',
            'react-dom': '^19.1.0',
            'lucide-react': '^0.487.0',
            express: '^5.1.0',
            'better-sqlite3': '^11.9.1',
          },
          devDependencies: {
            tailwindcss: '^4.1.3',
            vite: '^6.2.0',
          },
        }),
      },
      {
        path: 'src/App.jsx',
        content: `import React from 'react'; import { Sparkles } from 'lucide-react'; export default function App() { return <div className="flex bg-slate-900 px-4"><Sparkles /></div>; }`,
      },
    ];

    const staticInfo = analyzeStaticSource({
      files,
      materialization: { serverArchitecture: 'production-server' },
    });

    const detected = reconcileDetectedLibraries({
      staticInfo,
      runtimeDetections: [
        { id: 'react', name: 'React', category: 'framework', version: '19.1.0', signals: ['runtime-global', 'dom-fiber'] },
        { id: 'three', name: 'Three.js', category: '3d-graphics', version: 'r174', signals: ['runtime-global'] },
      ],
      responseHeaders: { 'x-powered-by': 'Express' },
      files,
    });

    const byId = new Map(detected.map((d) => [d.id, d]));
    assert.equal(byId.get('react')?.version, '19.1.0');
    assert.ok(byId.get('react')?.signals.includes('runtime-global'));
    assert.ok(byId.get('react')?.signals.includes('package-json'));
    assert.equal(byId.get('three')?.version, 'r174');
    assert.equal(byId.get('lucide')?.version, '0.487.0');
    assert.equal(byId.get('tailwind')?.version, '4.1.3');
    assert.equal(byId.get('express')?.version, '5.1.0');
    assert.ok(byId.get('express')?.signals.includes('http-header'));
    assert.equal(byId.get('better-sqlite3')?.version, '11.9.1');
  });

  it('scores console-errors accurately and aggregates consoleAudit + byLibrary into summary.json', () => {
    const clean = computeConsoleErrorScore({
      pageExceptionCount: 0,
      consoleErrorCount: 0,
      criticalHttpErrorCount: 0,
      nonCriticalHttpErrorCount: 0,
      favicon404Count: 0,
      failedRequestCount: 0,
      browserLogErrorCount: 0,
      consoleWarningCount: 1,
    });
    assert.equal(clean.overall, 100);
    assert.equal(clean.zeroErrors, true);

    const faviconOnly = computeConsoleErrorScore({
      favicon404Count: 1,
    });
    assert.equal(faviconOnly.overall, 98);
    assert.equal(faviconOnly.zeroErrors, true);

    const broken = computeConsoleErrorScore({
      pageExceptionCount: 1, // -22
      consoleErrorCount: 2, // -20
      criticalHttpErrorCount: 1, // -14
    });
    assert.equal(broken.overall, 44);
    assert.equal(broken.zeroErrors, false);
    assert.equal(broken.totalErrorCount, 4);

    // Verify aggregateAllResults integrates results/console-errors.json and detectedLibraries
    const tmpCells = mkdtempSync(join(tmpdir(), 'agg-console-test-'));
    try {
      const cellDir = join(tmpCells, 'kimi-k3-1-pro__photo-portfolio__agent__guided');
      mkdirSync(join(cellDir, 'results'), { recursive: true });
      writeFileSync(
        join(cellDir, 'generation.json'),
        JSON.stringify({
          modelKey: 'kimi-k3-1-pro',
          modelLabel: 'Kimi K3.1 Pro',
          family: 'Kimi (Moonshot)',
          promptId: 'photo-portfolio',
          mode: 'agent',
          spec: 'guided',
          provider: 'kimi-coding',
          modelId: 'k3.1-pro',
          durationMs: 18500,
        })
      );
      writeFileSync(
        join(cellDir, 'materialization.json'),
        JSON.stringify({ ok: true, serverArchitecture: 'production-server' })
      );
      writeFileSync(
        join(cellDir, 'results', 'tech-stack.json'),
        JSON.stringify({
          primaryFramework: 'vue',
          primaryBackend: 'express',
          primaryCss: 'tailwind',
          deliveryPattern: 'fullstack-vue-express',
          detectedLibraries: [
            { id: 'vue', name: 'Vue.js', category: 'framework', version: '3.5.13', signals: ['runtime-global'] },
            { id: 'lucide', name: 'Lucide Icons', category: 'icons', version: '0.487.0', signals: ['package-json'] },
          ],
          staticAnalysis: { modernWebAdoptionCount: 4, modernWebFeatures: { nativeDialog: true } },
          runtime: { renderedNonBlank: true, consoleErrorCount: 0, pageExceptionCount: 0 },
        })
      );
      writeFileSync(
        join(cellDir, 'results', 'prompt-judge.json'),
        JSON.stringify({
          passedGate: true,
          overall: 92,
          scores: { overall: 92, onTopic: 96, featureCoverage: 90 },
        })
      );
      writeFileSync(
        join(cellDir, 'results', 'console-errors.json'),
        JSON.stringify({
          score: 90,
          zeroErrors: false,
          totalErrorCount: 1,
          counts: {
            pageExceptionCount: 0,
            consoleErrorCount: 1,
            consoleWarningCount: 0,
            browserLogErrorCount: 0,
            httpErrorCount: 0,
            criticalHttpErrorCount: 0,
            nonCriticalHttpErrorCount: 0,
            favicon404Count: 0,
            failedRequestCount: 0,
            loadErrorCount: 0,
            journeyErrorCount: 1,
          },
        })
      );

      const summary = aggregateAllResults({ cellsRoot: tmpCells, writeSummary: false });
      assert.equal(summary.cells.length, 1);
      assert.equal(summary.cells[0].scores.consoleErrors, 90);
      assert.equal(summary.cells[0].keyMetrics.totalErrorCount, 1);
      assert.equal(summary.leaderboard[0].scores.consoleErrors, 90);
      assert.equal(summary.techObservatory.byLibrary.length, 2);
      assert.equal(summary.techObservatory.byLibrary[0].versions[0], '0.487.0' === summary.techObservatory.byLibrary[0].versions[0] ? '0.487.0' : '3.5.13');
    } finally {
      rmSync(tmpCells, { recursive: true, force: true });
    }
  });
});
