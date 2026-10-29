#!/usr/bin/env node
import { EventEmitter } from 'node:events';
import { runBenchmarkJob } from '../src/runner/orchestrator.mjs';
import { aggregateAllResults } from '../src/scoring/aggregate.mjs';

function parseCliArgs(argv) {
  const opts = {
    modelKeys: null,
    promptIds: null,
    categories: null,
    benchmarkIds: null,
    pilot: false,
    mode: null,
    reuseGeneration: false,
    force: false,
    skipJudge: false,
    scoreOnly: false,
    help: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--pilot') opts.pilot = true;
    else if (arg === '--reuse-generation') opts.reuseGeneration = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--skip-judge' || arg === '--fast-uplift') opts.skipJudge = true;
    else if (arg === '--score-only') opts.scoreOnly = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--models=')) opts.modelKeys = arg.slice(9).split(',').filter(Boolean);
    else if (arg.startsWith('--prompts=')) opts.promptIds = arg.slice(10).split(',').filter(Boolean);
    else if (arg.startsWith('--category=')) opts.categories = arg.slice(11).split(',').filter(Boolean);
    else if (arg.startsWith('--benchmarks=')) opts.benchmarkIds = arg.slice(13).split(',').filter(Boolean);
    else if (arg.startsWith('--mode=')) opts.mode = arg.slice(7);
  }
  return opts;
}

function printHelp() {
  console.log(`
Realistic Full-Stack & Agentic Web Generation Benchmark CLI

Usage:
  node bin/bench.mjs [options]

Options:
  --mode=agent|oneshot|both      Harness mode:
                                   agent   (default) Autonomous pi coding loop + real $PORT server + saved transcript
                                   oneshot           Single-shot pi-ai generateText baseline
                                   both              Run both agent and oneshot head-to-head
  --pilot                        Run pilot matrix (10 categories x pilot models)
  --models=<k1,k2,...>           Filter by model keys (e.g. gemini-4-argon,deepseek-flash)
  --prompts=<p1,p2,...>          Filter by prompt IDs (e.g. plumbing-appointment,filmmakers-community)
  --category=<c1,c2,...>         Filter by website category (e.g. booking-scheduling,membership-community)
  --benchmarks=<b1,b2,...>       Run specific benchmarks (tech-stack,lighthouse-uplift,deep-perf,memory)
  --reuse-generation             Skip LLM calls and audit already-generated cells
  --skip-judge                   Use deterministic web-uplift CDP primitives without LLM judge pass
  --force                        Re-run even if cached results exist
  --score-only                   Recompute data/summary.json from existing cell artifacts
  --help, -h                     Show help
`);
}

async function main() {
  const opts = parseCliArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.scoreOnly) {
    const summary = aggregateAllResults();
    console.log(`[score] Aggregated ${summary.totals.cells} cells (${summary.totals.agentCells} agent, ${summary.totals.oneshotCells} oneshot) -> data/summary.json`);
    for (const row of summary.leaderboard) {
      console.log(
        `  ${(row.label + ' [' + row.mode + ']').padEnd(36)} Composite: ${String(row.scores.composite).padStart(5)} | LH: ${row.scores.lighthouse ?? '-'} | Uplift: ${row.scores.uplift ?? '-'} | Perf/INP: ${row.scores.deepPerf ?? '-'} | Mem: ${row.scores.memory ?? '-'} | Stack: ${row.dominantStack}`
      );
    }
    return;
  }

  const emitter = new EventEmitter();
  emitter.on('job:start', (info) => {
    console.log(`\n[bench] Starting ${info.jobId} (modes=${info.modes.join(', ')})`);
    console.log(`[bench] Models (${info.models.length}): ${info.models.join(', ') || '(none)'}`);
    if (info.skippedModels.length > 0) {
      console.log(
        `[bench] Skipped (${info.skippedModels.length} missing credentials): ${info.skippedModels.map((s) => s.key).join(', ')}`
      );
    }
    console.log(`[bench] Prompts (${info.prompts.length}): ${info.prompts.join(', ')}`);
    console.log(`[bench] Benchmarks: ${info.benchmarks.join(', ')}\n`);
  });

  emitter.on('cell:stage', ({ cellId, stage, detail }) => {
    console.log(`  [${cellId}] (${stage}) ${detail}`);
  });

  emitter.on('cell:done', ({ cellId, ok, error }) => {
    if (ok) console.log(`  ✓ [${cellId}] Complete\n`);
    else console.error(`  ✗ [${cellId}] Failed: ${error}\n`);
  });

  const res = await runBenchmarkJob(opts, emitter);
  console.log(`[bench] Finished: ${res.completedCells} succeeded, ${res.failedCells} failed.`);
  if (res.summary.leaderboard.length > 0) {
    console.log('\n=== Leaderboard ===');
    for (const row of res.summary.leaderboard) {
      console.log(
        `  ${(row.label + ' [' + row.mode + ']').padEnd(36)} Score: ${String(row.scores.composite).padStart(5)} | LCP: ${row.averages.mobileLcpMs ?? '-'}ms | TTFB(p95): ${row.averages.burstP95TtfbMs ?? '-'}ms | INP: ${row.averages.inpMs ?? '-'}ms | MemScore: ${row.scores.memory ?? '-'} | Stack: ${row.dominantStack}`
      );
    }
  }
}

main().catch((err) => {
  console.error(`[bench] Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
