import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { loadBenchmarkConfig, PROJECT_ROOT } from '../util/env.mjs';
import { selectPrompts } from '../registry/prompts.mjs';
import { initializeModelRuntime, selectModels } from '../harness/model-registry.mjs';
import { generateWebsite, normalizeHarnessMode } from '../harness/generate.mjs';
import { extractGeneratedFiles } from '../materialize/extract-files.mjs';
import { prepareCellRuntime, startCellServer } from '../materialize/server-runner.mjs';
import { compileCanonicalFlow } from '../flows/compile-flow.mjs';
import { selectBenchmarks } from '../benchmarks/registry.mjs';
import { runHostCanaryCalibration } from '../benchmarks/canary.mjs';
import { aggregateAllResults, CELLS_ROOT } from '../scoring/aggregate.mjs';

export function normalizePipelineStage(stage) {
  if (!stage || stage === 'all') return 'all';
  if (stage === 'generate' || stage === 'gen') return 'generate';
  if (stage === 'audit' || stage === 'bench') return 'audit';
  return 'all';
}

function extractPrimaryBenchScore(benchId, resultObj) {
  if (!resultObj || typeof resultObj !== 'object') return 0;
  if (benchId === 'lighthouse-uplift') {
    const lh = resultObj.lighthouse?.performanceScore ?? 0;
    const up = resultObj.uplift?.overallScore ?? 0;
    return (lh + up) / 2;
  }
  if (typeof resultObj.score === 'number') return resultObj.score;
  if (typeof resultObj.overallScore === 'number') return resultObj.overallScore;
  return 0;
}

/**
 * Runs a configurable matrix slice of [models x prompts x modes x benchmarks].
 * Supports:
 *   - stage="all" (default): Stage 1 generation + Canary + Stage 2 serialized browser audits
 *   - stage="generate": Stage 1 LLM generation ONLY (zero Chrome needed; ideal for cloud CPU workers)
 *   - stage="audit": Canary + Stage 2 materialization & browser audits on existing generations
 *   - auditRuns=N: Median-of-N browser audit passes per cell to eliminate VM scheduling jitter
 */
export async function runBenchmarkJob(options = {}, emitter = new EventEmitter()) {
  const {
    modelKeys = null,
    promptIds = null,
    categories = null,
    benchmarkIds = null,
    pilot = false,
    mode = null,
    stage: rawStage = 'all',
    auditRuns: rawAuditRuns = 1,
    skipCanary = false,
    reuseGeneration: rawReuseGeneration = false,
    force = false,
    skipJudge = false,
    signal = null,
  } = options;

  const pipelineStage = normalizePipelineStage(rawStage);
  const reuseGeneration = pipelineStage === 'audit' ? true : Boolean(rawReuseGeneration);
  const auditRuns = Math.max(1, Math.min(7, Number(rawAuditRuns) || 1));

  const config = loadBenchmarkConfig();
  const requestedMode = normalizeHarnessMode(mode || config.generation.defaultMode || 'agent');
  const modesToRun = requestedMode === 'both' ? ['agent', 'oneshot'] : [requestedMode];

  const runtime = await initializeModelRuntime();
  const prompts = selectPrompts({ ids: promptIds, categories, pilot });
  const { usable: models, skipped: skippedModels, unknownKeys = [] } = selectModels(runtime, {
    keys: modelKeys,
    pilot,
    onlyReady: !reuseGeneration,
  });
  const benchmarks = selectBenchmarks(benchmarkIds);

  const jobId = `job-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const totalCells = models.length * prompts.length * modesToRun.length;

  emitter.emit('job:start', {
    jobId,
    stage: pipelineStage,
    auditRuns,
    mode: requestedMode,
    modes: modesToRun,
    models: models.map((m) => m.key),
    skippedModels: skippedModels.map((m) => ({ key: m.key, missingProviders: m.missingProviders })),
    unknownModels: unknownKeys,
    prompts: prompts.map((p) => p.id),
    benchmarks: pipelineStage === 'generate' ? [] : benchmarks.map((b) => b.id),
    totalCells,
  });

  if (models.length === 0 || prompts.length === 0) {
    const summary = aggregateAllResults();
    emitter.emit('job:done', { jobId, stage: pipelineStage, completedCells: 0, failedCells: 0, summary });
    return { jobId, stage: pipelineStage, completedCells: 0, failedCells: 0, summary };
  }

  mkdirSync(CELLS_ROOT, { recursive: true });
  let completedCells = 0;
  let failedCells = 0;

  const cellQueue = [];
  for (const cellMode of modesToRun) {
    for (const modelEntry of models) {
      for (const promptEntry of prompts) {
        const cellId = `${modelEntry.key}__${promptEntry.id}__${cellMode}`;
        cellQueue.push({
          cellId,
          cellDir: join(CELLS_ROOT, cellId),
          cellMode,
          modelEntry,
          promptEntry,
        });
      }
    }
  }

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
      const { cellId, cellDir, cellMode, modelEntry, promptEntry } = item;
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
          detail: `Reusing cached ${cellMode} generation output`,
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
          mode: cellMode,
        });
        item.generation = await generateWebsite({
          runtime,
          modelEntry,
          promptEntry,
          cellDir,
          config,
          mode: cellMode,
          onProgress: (p) => emitter.emit('cell:stage', { jobId, cellId, ...p }),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(genConcurrency, cellQueue.length) }, () => generationWorker()));

  // If stage === 'generate', finish cleanly without launching Chrome or running audits!
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
        { jobId, stage: pipelineStage, mode: requestedMode, completedCells, failedCells, finishedAt: new Date().toISOString() },
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

  // Stage 2: Materialize / Verify Production Server + Serialized Browser Audits (strictly concurrency = 1)
  for (const item of cellQueue) {
    if (signal?.aborted) break;
    if (item.skippedNoGeneration) continue;
    const { cellId, cellDir, promptEntry, generation } = item;

    if (generation?.error) {
      failedCells++;
      emitter.emit('cell:done', { jobId, cellId, ok: false, error: generation.error });
      continue;
    }

    const rawMarkdown = existsSync(join(cellDir, 'raw-output.md'))
      ? readFileSync(join(cellDir, 'raw-output.md'), 'utf8')
      : '';

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
        onProgress: (p) => emitter.emit('cell:stage', { jobId, cellId, ...p }),
      });
    }

    if (!materialization.ok) {
      failedCells++;
      emitter.emit('cell:done', {
        jobId,
        cellId,
        ok: false,
        error: materialization.error || 'Runtime materialization failed',
      });
      continue;
    }

    let serverHandle = null;
    try {
      emitter.emit('cell:stage', {
        jobId,
        cellId,
        stage: 'server-boot',
        detail: `Booting ${materialization.serverArchitecture} (${materialization.startCommand || 'static'})`,
      });
      serverHandle = await startCellServer({ cellDir, materialization, timeoutMs: 25000 });

      const flowFile = join(cellDir, 'compiled-flow.json');
      let compiledFlow;
      if (!force && existsSync(flowFile)) {
        compiledFlow = JSON.parse(readFileSync(flowFile, 'utf8'));
      } else {
        emitter.emit('cell:stage', {
          jobId,
          cellId,
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

      for (const bench of benchmarks) {
        if (signal?.aborted) break;
        const resultFile = join(cellDir, 'results', `${bench.id}.json`);
        if (!force && !options.benchmarkIds && existsSync(resultFile)) {
          emitter.emit('cell:stage', {
            jobId,
            cellId,
            stage: bench.id,
            detail: `Reusing cached ${bench.id} result`,
          });
          continue;
        }

        const isStaticAnalysisOnly = bench.id === 'tech-stack';
        const passes = isStaticAnalysisOnly ? 1 : auditRuns;

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
            onProgress: (p) => emitter.emit('cell:stage', { jobId, cellId, ...p }),
          });
        } else {
          const runArtifacts = [];
          for (let passIdx = 1; passIdx <= passes; passIdx++) {
            if (signal?.aborted) break;
            emitter.emit('cell:stage', {
              jobId,
              cellId,
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
                emitter.emit('cell:stage', {
                  jobId,
                  cellId,
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
      }

      completedCells++;
      emitter.emit('cell:done', { jobId, cellId, ok: true });
    } catch (err) {
      failedCells++;
      emitter.emit('cell:done', { jobId, cellId, ok: false, error: err.message || String(err) });
    } finally {
      if (serverHandle) {
        await serverHandle.close();
      }
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
        auditRuns,
        canaryStatus: canary?.status || null,
        mode: requestedMode,
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
  return { jobId, stage: pipelineStage, completedCells, failedCells, summary };
}
