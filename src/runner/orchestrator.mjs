import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { loadBenchmarkConfig, PROJECT_ROOT } from '../util/env.mjs';
import { selectPrompts, loadDesignDoc, loadPromptRegistry } from '../registry/prompts.mjs';
import { initializeModelRuntime, selectModels } from '../harness/model-registry.mjs';
import {
  expandHarnessSelection,
  getHarnessSpec,
  isModelCompatibleWithHarness,
} from '../harness/harness-registry.mjs';
import {
  generateWebsite,
  normalizeHarnessMode,
  normalizeSpecMode,
  buildCellId,
  parseCellDirIdentity,
} from '../harness/generate.mjs';
import { extractGeneratedFiles } from '../materialize/extract-files.mjs';
import { prepareCellRuntime, startCellServer } from '../materialize/server-runner.mjs';
import { captureStaticPreviewMirror } from '../materialize/static-mirror.mjs';
import { compileCanonicalFlow } from '../flows/compile-flow.mjs';
import { selectBenchmarks } from '../benchmarks/registry.mjs';
import { upgradeCellWithLlmJudge } from '../benchmarks/prompt-judge.bench.mjs';
import { withTimeout, killAllActiveChromes } from '../benchmarks/cdp-helpers.mjs';
import { runHostCanaryCalibration } from '../benchmarks/canary.mjs';
import { aggregateAllResults, CELLS_ROOT } from '../scoring/aggregate.mjs';

export function normalizePipelineStage(stage) {
  if (!stage || stage === 'all') return 'all';
  if (stage === 'generate' || stage === 'gen') return 'generate';
  if (stage === 'audit' || stage === 'bench') return 'audit';
  if (stage === 'judge' || stage === 'judge-only') return 'judge';
  return 'all';
}

function extractPrimaryBenchScore(benchId, resultObj) {
  if (!resultObj || typeof resultObj !== 'object') return 0;
  if (benchId === 'prompt-judge') {
    return resultObj.passedGate ? (resultObj.overall ?? 0) : 0;
  }
  if (benchId === 'lighthouse-uplift') {
    const lh = resultObj.lighthouse?.performanceScore ?? resultObj.lighthouse?.compositeScore ?? 0;
    const up = resultObj.uplift?.overallScore ?? resultObj.uplift?.overall ?? 0;
    return (lh + up) / 2;
  }
  if (typeof resultObj.score === 'number') return resultObj.score;
  if (typeof resultObj.overallScore === 'number') return resultObj.overallScore;
  return 0;
}

/**
 * Runs a configurable matrix slice of [models x prompts x modes x specs x benchmarks].
 */
export async function runBenchmarkJob(options = {}, emitter = new EventEmitter()) {
  const {
    modelKeys = null,
    promptIds = null,
    categories = null,
    benchmarkIds = null,
    pilot = false,
    mode = null,
    spec = null,
    harness = null,
    stage: rawStage = 'all',
    judgeOnly = false,
    auditRuns: rawAuditRuns = 1,
    skipCanary = false,
    reuseGeneration: rawReuseGeneration = false,
    force = false,
    skipJudge = false,
    signal = null,
  } = options;

  const pipelineStage = judgeOnly ? 'judge' : normalizePipelineStage(rawStage);
  const reuseGeneration =
    pipelineStage === 'audit' || pipelineStage === 'judge' ? true : Boolean(rawReuseGeneration);
  const auditRuns = Math.max(1, Math.min(7, Number(rawAuditRuns) || 1));

  const config = loadBenchmarkConfig();
  const designDoc = loadDesignDoc();
  const requestedHarness = harness || config.generation?.defaultHarness || 'pi';
  const harnessesToRun = expandHarnessSelection(requestedHarness);
  const requestedMode = normalizeHarnessMode(mode || config.generation.defaultMode || 'agent');
  const modesToRun = requestedMode === 'both' ? ['agent', 'oneshot'] : [requestedMode];
  const requestedSpec = normalizeSpecMode(spec || config.generation.defaultSpec || 'freeform');
  const specsToRun = requestedSpec === 'both' ? ['freeform', 'guided'] : [requestedSpec];

  const runtime = await initializeModelRuntime();
  const prompts = selectPrompts({ ids: promptIds, categories, pilot });
  const { usable: models, skipped: skippedModels, unknownKeys = [] } = selectModels(runtime, {
    keys: modelKeys,
    pilot,
    onlyReady: !reuseGeneration,
  });
  const benchmarks = selectBenchmarks(benchmarkIds);

  const jobId = `job-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // Post-server multimodal LLM Judge upgrade stage (`--judge-only` / `--stage=judge`)
  if (pipelineStage === 'judge') {
    const promptReg = loadPromptRegistry();
    const promptMap = new Map(promptReg.prompts.map((p) => [p.id, p]));
    const allowedModelSet = modelKeys?.length ? new Set(models.map((m) => m.key)) : null;
    const allowedPromptSet = promptIds?.length || categories?.length || pilot ? new Set(prompts.map((p) => p.id)) : null;
    const allowedHarnessSet = harness ? new Set(harnessesToRun) : null;
    const allowedModeSet = mode ? new Set(modesToRun) : null;
    const allowedSpecSet = spec ? new Set(specsToRun) : null;

    const candidateDirs = existsSync(CELLS_ROOT) ? readdirSync(CELLS_ROOT).sort() : [];
    const targetCells = [];
    for (const dirName of candidateDirs) {
      const cellDir = join(CELLS_ROOT, dirName);
      const judgeResPath = join(cellDir, 'results', 'prompt-judge.json');
      const genJsonPath = join(cellDir, 'generation.json');
      if (!existsSync(judgeResPath) || !existsSync(genJsonPath)) continue;

      let gen = {};
      try {
        gen = JSON.parse(readFileSync(genJsonPath, 'utf8'));
      } catch {
        continue;
      }
      const parsed = parseCellDirIdentity(dirName, gen);
      if (allowedModelSet && !allowedModelSet.has(gen.modelKey)) continue;
      if (allowedPromptSet && !allowedPromptSet.has(gen.promptId)) continue;
      if (allowedHarnessSet && !allowedHarnessSet.has(parsed.harness)) continue;
      if (allowedModeSet && !allowedModeSet.has(parsed.mode)) continue;
      if (allowedSpecSet && !allowedSpecSet.has(parsed.spec)) continue;

      const promptEntry = promptMap.get(gen.promptId);
      if (!promptEntry) continue;
      targetCells.push({ cellId: dirName, cellDir, promptEntry });
    }

    emitter.emit('job:start', {
      jobId,
      stage: 'judge',
      auditRuns: 1,
      harness: requestedHarness,
      harnesses: harnessesToRun,
      mode: requestedMode,
      modes: modesToRun,
      spec: requestedSpec,
      specs: specsToRun,
      models: models.map((m) => m.key),
      skippedModels: [],
      unknownModels: unknownKeys,
      prompts: prompts.map((p) => p.id),
      benchmarks: ['prompt-judge'],
      totalCells: targetCells.length,
    });

    const tJudgeJob0 = performance.now();
    let completedJudgeCells = 0;
    let failedJudgeCells = 0;

    for (let i = 0; i < targetCells.length; i++) {
      if (signal?.aborted) break;
      const { cellId, cellDir, promptEntry } = targetCells[i];
      const existing = JSON.parse(readFileSync(join(cellDir, 'results', 'prompt-judge.json'), 'utf8'));
      if (!force && existing.evaluationMode === 'multimodal-llm-judge') {
        emitter.emit('cell:stage', {
          jobId,
          cellId,
          index: i + 1,
          total: targetCells.length,
          stage: 'prompt-judge',
          detail: `Reusing cached multimodal-llm-judge verdict (${existing.passedGate ? 'PASS' : 'DISQUALIFIED'})`,
        });
        completedJudgeCells++;
        emitter.emit('cell:done', { jobId, cellId, index: i + 1, total: targetCells.length, ok: true });
        continue;
      }

      emitter.emit('cell:stage', {
        jobId,
        cellId,
        index: i + 1,
        total: targetCells.length,
        stage: 'prompt-judge',
        detail: 'Running post-server multimodal LLM on-topic & feature coverage judge',
      });
      try {
        const upgraded = await upgradeCellWithLlmJudge({
          cellDir,
          promptEntry,
          config,
          runtime,
        });
        completedJudgeCells++;
        emitter.emit('cell:done', {
          jobId,
          cellId,
          index: i + 1,
          total: targetCells.length,
          ok: true,
          verdict: upgraded,
        });
      } catch (err) {
        failedJudgeCells++;
        emitter.emit('cell:done', {
          jobId,
          cellId,
          index: i + 1,
          total: targetCells.length,
          ok: false,
          error: err.message || String(err),
        });
      }
    }

    const durationMs = Math.round(performance.now() - tJudgeJob0);
    const summary = aggregateAllResults();
    emitter.emit('job:done', {
      jobId,
      stage: 'judge',
      completedCells: completedJudgeCells,
      failedCells: failedJudgeCells,
      durationMs,
      summary,
    });
    return {
      jobId,
      stage: 'judge',
      completedCells: completedJudgeCells,
      failedCells: failedJudgeCells,
      durationMs,
      summary,
    };
  }

  const cellQueue = [];
  for (const cellHarness of harnessesToRun) {
    const harnessSpec = getHarnessSpec(cellHarness);
    for (const cellSpec of specsToRun) {
      for (const cellMode of modesToRun) {
        // ACP harnesses (`claude-acp`, `codex-acp`) drive interactive agent loops rather than 1-shot text generation
        if (cellHarness !== 'pi' && cellMode === 'oneshot') continue;
        if (harnessSpec?.supportsModes && !harnessSpec.supportsModes.includes(cellMode)) continue;

        for (const modelEntry of models) {
          const explicitSingleOverride =
            Array.isArray(modelKeys) && modelKeys.length === 1 && harnessesToRun.length === 1;
          if (!explicitSingleOverride && !isModelCompatibleWithHarness(modelEntry, cellHarness)) {
            continue;
          }
          for (const promptEntry of prompts) {
            const cellId = buildCellId(modelEntry.key, promptEntry.id, cellMode, cellSpec, cellHarness);
            cellQueue.push({
              cellId,
              cellDir: join(CELLS_ROOT, cellId),
              cellHarness,
              cellMode,
              cellSpec,
              modelEntry,
              promptEntry,
            });
          }
        }
      }
    }
  }

  const totalCells = cellQueue.length;
  const activeModelKeys = Array.from(new Set(cellQueue.map((c) => c.modelEntry.key)));

  emitter.emit('job:start', {
    jobId,
    stage: pipelineStage,
    auditRuns,
    harness: requestedHarness,
    harnesses: harnessesToRun,
    mode: requestedMode,
    modes: modesToRun,
    spec: requestedSpec,
    specs: specsToRun,
    models: activeModelKeys.length > 0 ? activeModelKeys : models.map((m) => m.key),
    skippedModels: skippedModels.map((m) => ({ key: m.key, missingProviders: m.missingProviders })),
    unknownModels: unknownKeys,
    prompts: prompts.map((p) => p.id),
    benchmarks: pipelineStage === 'generate' ? [] : benchmarks.map((b) => b.id),
    totalCells,
  });

  if (cellQueue.length === 0) {
    const summary = aggregateAllResults();
    emitter.emit('job:done', { jobId, stage: pipelineStage, completedCells: 0, failedCells: 0, summary });
    return { jobId, stage: pipelineStage, completedCells: 0, failedCells: 0, summary };
  }

  mkdirSync(CELLS_ROOT, { recursive: true });
  let completedCells = 0;
  let failedCells = 0;

  // Stage 1: LLM Generation (or cache inspection when stage="audit" / reuseGeneration=true)
  const hasAgentWork = modesToRun.includes('agent');
  const genConcurrency = Math.max(
    1,
    hasAgentWork
      ? config.generation?.agentConcurrency || 2
      : config.generation?.oneshotConcurrency || 3
  );
  let nextIdx = 0;

  async function generationWorker() {
    while (nextIdx < cellQueue.length) {
      if (signal?.aborted) return;
      const item = cellQueue[nextIdx++];
      const { cellId, cellDir, cellHarness, cellMode, cellSpec, modelEntry, promptEntry } = item;
      const genJsonPath = join(cellDir, 'generation.json');

      let hasExistingGen = false;
      if (existsSync(genJsonPath)) {
        try {
          const parsedGen = JSON.parse(readFileSync(genJsonPath, 'utf8'));
          const hasArtifacts =
            cellMode === 'agent'
              ? existsSync(join(cellDir, 'agent-workspace'))
              : existsSync(join(cellDir, 'raw-output.md'));
          hasExistingGen = !parsedGen.error && hasArtifacts;
        } catch {
          hasExistingGen = false;
        }
      }

      if ((reuseGeneration || !force) && hasExistingGen) {
        emitter.emit('cell:stage', {
          jobId,
          cellId,
          stage: 'generating',
          detail: `Reusing cached ${cellMode} (${cellSpec}, harness=${cellHarness}) generation output`,
        });
        item.generation = JSON.parse(readFileSync(genJsonPath, 'utf8'));
      } else if (reuseGeneration && !hasExistingGen) {
        item.skippedNoGeneration = true;
      } else {
        emitter.emit('cell:start', {
          jobId,
          cellId,
          modelKey: modelEntry.key,
          promptId: promptEntry.id,
          harness: cellHarness,
          mode: cellMode,
          spec: cellSpec,
        });
        item.generation = await generateWebsite({
          runtime,
          modelEntry,
          promptEntry,
          cellDir,
          config,
          harness: cellHarness,
          mode: cellMode,
          spec: cellSpec,
          designDoc,
          onProgress: (p) => emitter.emit('cell:stage', { jobId, cellId, ...p }),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(genConcurrency, cellQueue.length) }, () => generationWorker()));

  if (pipelineStage === 'generate') {
    for (const item of cellQueue) {
      if (item.skippedNoGeneration) continue;
      if (item.generation?.error) {
        failedCells++;
        emitter.emit('cell:done', { jobId, cellId: item.cellId, ok: false, error: item.generation.error });
      } else {
        completedCells++;
        emitter.emit('cell:done', { jobId, cellId: item.cellId, ok: true });
      }
    }

    const summary = aggregateAllResults();
    const jobsDir = join(PROJECT_ROOT, 'runs', 'jobs');
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify(
        {
          jobId,
          stage: pipelineStage,
          mode: requestedMode,
          spec: requestedSpec,
          completedCells,
          failedCells,
          finishedAt: new Date().toISOString(),
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    emitter.emit('job:done', { jobId, stage: pipelineStage, completedCells, failedCells, summary });
    return { jobId, stage: pipelineStage, completedCells: 0 + completedCells, failedCells, summary };
  }

  // Host Hardware Canary Calibration before Stage 2 browser benchmarks
  const actionableAuditCells = cellQueue.filter((i) => !i.skippedNoGeneration && !i.generation?.error);
  let canary = null;
  if (!skipCanary && actionableAuditCells.length > 0) {
    try {
      emitter.emit('job:canary', { jobId, detail: 'Running host CPU & Chrome canary calibration' });
      canary = await runHostCanaryCalibration({ save: true });
      emitter.emit('job:canary-done', { jobId, canary });
    } catch {
      // non-fatal if headless Chrome is unavailable during unit tests
    }
  }

  const jobStartedMs = performance.now();
  const baseCellTimeoutMs = Math.max(30000, Number(options.cellTimeoutMs || config.audit?.cellTimeoutMs || 180000));
  const effectiveCellTimeoutMs = baseCellTimeoutMs * auditRuns;

  const totalAuditTargets = cellQueue.filter((i) => !i.skippedNoGeneration).length;
  let auditOrdinal = 0;

  // Stage 2: Materialize / Verify Production Server + Serialized Browser Audits (strictly concurrency = 1)
  for (const item of cellQueue) {
    if (signal?.aborted) break;
    if (item.skippedNoGeneration) continue;
    auditOrdinal++;
    const { cellId, cellDir, promptEntry, generation } = item;

    if (generation?.error) {
      failedCells++;
      emitter.emit('cell:done', {
        jobId,
        cellId,
        index: auditOrdinal,
        total: totalAuditTargets,
        ok: false,
        error: generation.error,
      });
      continue;
    }

    const cellT0 = performance.now();
    const phasesMs = {
      materializeMs: 0,
      serverBootMs: 0,
      flowCompileMs: 0,
      benchmarks: {},
    };
    let activeStage = 'initializing';
    let activeDetail = 'Preparing cell workspace';
    let serverArchitecture = null;

    const emitStage = (p) => {
      activeStage = p.stage || activeStage;
      activeDetail = p.detail || activeDetail;
      emitter.emit('cell:stage', {
        jobId,
        cellId,
        index: auditOrdinal,
        total: totalAuditTargets,
        elapsedCellMs: Math.round(performance.now() - cellT0),
        ...p,
      });
    };

    let serverHandle = null;
    try {
      await withTimeout(
        (async () => {
          const rawMarkdown = existsSync(join(cellDir, 'raw-output.md'))
            ? readFileSync(join(cellDir, 'raw-output.md'), 'utf8')
            : '';

          const tMat0 = performance.now();
          const extraction = extractGeneratedFiles({ cellDir, rawMarkdown });
          const matPath = join(cellDir, 'materialization.json');
          let materialization;

          if (!force && reuseGeneration && existsSync(matPath)) {
            const cachedMat = JSON.parse(readFileSync(matPath, 'utf8'));
            if (cachedMat.ok) {
              materialization = {
                distDir: join(cellDir, 'dist'),
                ...cachedMat,
              };
            }
          }

          if (!materialization) {
            materialization = await prepareCellRuntime({
              cellDir,
              extraction,
              forceBuild: force,
              keepServerAlive: true,
              onProgress: emitStage,
            });
          }
          phasesMs.materializeMs = Math.round(performance.now() - tMat0);
          serverArchitecture = materialization?.serverArchitecture || null;

          if (!materialization.ok) {
            throw new Error(materialization.error || 'Runtime materialization failed');
          }

          const tBoot0 = performance.now();
          if (materialization._liveServerHandle) {
            serverHandle = materialization._liveServerHandle;
            phasesMs.serverBootMs = materialization.verifiedColdBootMs ?? 0;
          } else {
            emitStage({
              stage: 'server-boot',
              detail: `Booting ${materialization.serverArchitecture} (${materialization.startCommand || 'static'})`,
            });
            serverHandle = await startCellServer({ cellDir, materialization, timeoutMs: 15000 });
            phasesMs.serverBootMs = Math.round(performance.now() - tBoot0);
          }

          // Capture a self-contained static mirror + GET /api/* seed snapshot before journey mutations
          // so GitHub Pages static reports can host interactive previews for full-stack $PORT servers!
          if (materialization.serverArchitecture === 'production-server' || !existsSync(join(cellDir, 'dist', 'index.html'))) {
            await captureStaticPreviewMirror({
              serverUrl: serverHandle.url,
              cellDir,
              materialization,
              timeoutMs: 7000,
            }).catch(() => {});
          }

          const tFlow0 = performance.now();
          const flowFile = join(cellDir, 'compiled-flow.json');
          let compiledFlow;
          if (!force && existsSync(flowFile)) {
            compiledFlow = JSON.parse(readFileSync(flowFile, 'utf8'));
          } else {
            emitStage({
              stage: 'flow-compile',
              detail: `Compiling ${promptEntry.canonicalJourney.length}-step canonical user journey`,
            });
            const flowRes = await compileCanonicalFlow({
              url: serverHandle.url,
              promptEntry,
              cellDir,
              config,
            });
            compiledFlow = flowRes.compiled;
          }
          phasesMs.flowCompileMs = Math.round(performance.now() - tFlow0);

          for (const bench of benchmarks) {
            if (signal?.aborted) break;
            const resultFile = join(cellDir, 'results', `${bench.id}.json`);
            if (!force && !options.benchmarkIds && existsSync(resultFile)) {
              emitStage({
                stage: bench.id,
                detail: `Reusing cached ${bench.id} result`,
              });
              phasesMs.benchmarks[bench.id] = 0;
              continue;
            }

            const tBench0 = performance.now();
            const isSinglePassBench = bench.id === 'tech-stack' || bench.id === 'prompt-judge';
            const passes = isSinglePassBench ? 1 : auditRuns;

            if (passes === 1) {
              await bench.run({
                url: serverHandle.url,
                serverHandle,
                cellDir,
                distDir: materialization.distDir || join(cellDir, 'dist'),
                extraction,
                materialization,
                compiledFlow,
                promptEntry,
                config,
                options: { skipJudge },
                onProgress: emitStage,
              });
            } else {
              const runArtifacts = [];
              for (let passIdx = 1; passIdx <= passes; passIdx++) {
                if (signal?.aborted) break;
                emitStage({
                  stage: bench.id,
                  detail: `Audit pass ${passIdx}/${passes} (${bench.label})`,
                });
                await bench.run({
                  url: serverHandle.url,
                  serverHandle,
                  cellDir,
                  distDir: materialization.distDir || join(cellDir, 'dist'),
                  extraction,
                  materialization,
                  compiledFlow,
                  promptEntry,
                  config,
                  options: { skipJudge },
                  onProgress: (p) =>
                    emitStage({
                      stage: p.stage || bench.id,
                      detail: `[pass ${passIdx}/${passes}] ${p.detail}`,
                    }),
                });
                if (existsSync(resultFile)) {
                  const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
                  runArtifacts.push({
                    passIdx,
                    primaryScore: extractPrimaryBenchScore(bench.id, parsed),
                    payload: parsed,
                  });
                }
              }

              if (runArtifacts.length > 0) {
                runArtifacts.sort((a, b) => a.primaryScore - b.primaryScore);
                const medianEntry = runArtifacts[Math.floor(runArtifacts.length / 2)];
                const allScores = runArtifacts.map((r) => Math.round(r.primaryScore * 10) / 10);
                const enrichedMedian = {
                  ...medianEntry.payload,
                  auditRunsMetadata: {
                    passesRequested: passes,
                    passesCompleted: runArtifacts.length,
                    selectedMedianPass: medianEntry.passIdx,
                    allPrimaryScores: allScores,
                    scoreSpread:
                      allScores.length > 1
                        ? Math.round((allScores[allScores.length - 1] - allScores[0]) * 10) / 10
                        : 0,
                  },
                };
                writeFileSync(resultFile, JSON.stringify(enrichedMedian, null, 2) + '\n', 'utf8');
              }
            }
            phasesMs.benchmarks[bench.id] = Math.round(performance.now() - tBench0);
          }
        })(),
        effectiveCellTimeoutMs,
        `Cell audit (${cellId})`
      );

      const totalAuditMs = Math.round(performance.now() - cellT0);
      const telemetry = {
        cellId,
        status: 'ok',
        auditRuns,
        serverArchitecture,
        totalAuditMs,
        phasesMs,
        hostCanaryStatus: canary?.status || null,
        hostCanaryBrowserMs: canary?.browserMainThreadComputeMs ?? null,
        completedAt: new Date().toISOString(),
      };
      mkdirSync(cellDir, { recursive: true });
      writeFileSync(join(cellDir, 'audit-telemetry.json'), JSON.stringify(telemetry, null, 2) + '\n', 'utf8');

      completedCells++;
      emitter.emit('cell:done', {
        jobId,
        cellId,
        index: auditOrdinal,
        total: totalAuditTargets,
        ok: true,
        telemetry,
      });
    } catch (err) {
      const totalAuditMs = Math.round(performance.now() - cellT0);
      const rawMsg = err.message || String(err);
      const isTimeout = /timed out/i.test(rawMsg);
      const enrichedError = `${rawMsg} [active stage: ${activeStage} — "${activeDetail}"]`;
      const telemetry = {
        cellId,
        status: isTimeout ? 'timeout' : 'error',
        failedStage: activeStage,
        failedDetail: activeDetail,
        error: enrichedError,
        auditRuns,
        serverArchitecture,
        totalAuditMs,
        phasesMs,
        hostCanaryStatus: canary?.status || null,
        hostCanaryBrowserMs: canary?.browserMainThreadComputeMs ?? null,
        completedAt: new Date().toISOString(),
      };
      mkdirSync(cellDir, { recursive: true });
      writeFileSync(join(cellDir, 'audit-telemetry.json'), JSON.stringify(telemetry, null, 2) + '\n', 'utf8');

      failedCells++;
      emitter.emit('cell:done', {
        jobId,
        cellId,
        index: auditOrdinal,
        total: totalAuditTargets,
        ok: false,
        error: enrichedError,
        telemetry,
      });
    } finally {
      await killAllActiveChromes().catch(() => {});
      if (serverHandle) {
        await withTimeout(serverHandle.close(), 3000, 'serverHandle.close').catch(() => {});
      }
    }
  }

  const jobDurationMs = Math.round(performance.now() - jobStartedMs);
  const summary = aggregateAllResults();

  const jobsDir = join(PROJECT_ROOT, 'runs', 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, `${jobId}.json`),
    JSON.stringify(
      {
        jobId,
        stage: pipelineStage,
        auditRuns,
        canaryStatus: canary?.status || null,
        mode: requestedMode,
        spec: requestedSpec,
        completedCells,
        failedCells,
        durationMs: jobDurationMs,
        finishedAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  emitter.emit('job:done', {
    jobId,
    stage: pipelineStage,
    completedCells,
    failedCells,
    durationMs: jobDurationMs,
    summary,
  });
  return { jobId, stage: pipelineStage, completedCells, failedCells, durationMs: jobDurationMs, summary };
}
