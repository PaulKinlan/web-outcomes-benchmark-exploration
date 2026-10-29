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
import { aggregateAllResults, CELLS_ROOT } from '../scoring/aggregate.mjs';

/**
 * Runs a configurable matrix slice of [models x prompts x modes x benchmarks].
 * Supports mode="agent" (default full-stack pi loop), mode="oneshot" (1-shot pi-ai),
 * and mode="both" (side-by-side comparison).
 */
export async function runBenchmarkJob(options = {}, emitter = new EventEmitter()) {
  const {
    modelKeys = null,
    promptIds = null,
    categories = null,
    benchmarkIds = null,
    pilot = false,
    mode = null,
    reuseGeneration = false,
    force = false,
    skipJudge = false,
    signal = null,
  } = options;

  const config = loadBenchmarkConfig();
  const requestedMode = normalizeHarnessMode(mode || config.generation.defaultMode || 'agent');
  const modesToRun = requestedMode === 'both' ? ['agent', 'oneshot'] : [requestedMode];

  const runtime = await initializeModelRuntime();
  const prompts = selectPrompts({ ids: promptIds, categories, pilot });
  const { usable: models, skipped: skippedModels } = selectModels(runtime, {
    keys: modelKeys,
    pilot,
    onlyReady: !reuseGeneration,
  });
  const benchmarks = selectBenchmarks(benchmarkIds);

  const jobId = `job-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const totalCells = models.length * prompts.length * modesToRun.length;

  emitter.emit('job:start', {
    jobId,
    mode: requestedMode,
    modes: modesToRun,
    models: models.map((m) => m.key),
    skippedModels: skippedModels.map((m) => ({ key: m.key, missingProviders: m.missingProviders })),
    prompts: prompts.map((p) => p.id),
    benchmarks: benchmarks.map((b) => b.id),
    totalCells,
  });

  if (models.length === 0 || prompts.length === 0) {
    const summary = aggregateAllResults();
    emitter.emit('job:done', { jobId, completedCells: 0, failedCells: 0, summary });
    return { jobId, completedCells: 0, failedCells: 0, summary };
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

  // Stage 2: Materialize / Verify Production Server + Serialized Browser Audits (strictly concurrency = 1)
  for (const item of cellQueue) {
    if (signal?.aborted) break;
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
    JSON.stringify({ jobId, mode: requestedMode, completedCells, failedCells, finishedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8'
  );

  emitter.emit('job:done', { jobId, completedCells, failedCells, summary });
  return { jobId, completedCells, failedCells, summary };
}
