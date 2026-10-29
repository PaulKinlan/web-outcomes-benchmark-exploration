#!/usr/bin/env node
import { EventEmitter } from 'node:events';
import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmarkJob } from '../src/runner/orchestrator.mjs';
import { aggregateAllResults } from '../src/scoring/aggregate.mjs';

export function parseCliArgs(argv) {
  const opts = {
    modelKeys: null,
    promptIds: null,
    categories: null,
    benchmarkIds: null,
    pilot: false,
    mode: null,
    stage: 'all',
    auditRuns: 1,
    skipCanary: false,
    markdownSummaryPath: null,
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
    else if (arg === '--skip-canary') opts.skipCanary = true;
    else if (arg === '--skip-judge' || arg === '--fast-uplift') opts.skipJudge = true;
    else if (arg === '--score-only') opts.scoreOnly = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--models=')) opts.modelKeys = arg.slice(9).split(',').filter(Boolean);
    else if (arg.startsWith('--prompts=')) opts.promptIds = arg.slice(10).split(',').filter(Boolean);
    else if (arg.startsWith('--category=')) opts.categories = arg.slice(11).split(',').filter(Boolean);
    else if (arg.startsWith('--benchmarks=')) opts.benchmarkIds = arg.slice(13).split(',').filter(Boolean);
    else if (arg.startsWith('--mode=')) opts.mode = arg.slice(7);
    else if (arg.startsWith('--stage=')) opts.stage = arg.slice(8);
    else if (arg.startsWith('--audit-runs=')) opts.auditRuns = Math.max(1, Number(arg.slice(13)) || 1);
    else if (arg.startsWith('--markdown-summary=')) opts.markdownSummaryPath = arg.slice(19);
  }
  return opts;
}

export function formatMarkdownSummary(summary) {
  const lines = [];
  lines.push('## Web Generation & Performance Benchmark Summary');
  lines.push('');

  const env = summary.environment || {};
  const canary = summary.canary || null;
  lines.push(
    `- **Cells Evaluated**: ${summary.totals?.cells ?? 0} (${summary.totals?.agentCells ?? 0} agent loop, ${summary.totals?.oneshotCells ?? 0} 1-shot)`
  );
  if (env.piVersion) {
    lines.push(`- **Clean-Room \`pi\` Runtime**: \`v${env.piVersion}\` (\`${env.piSource || 'local'}\`)`);
  }
  if (canary) {
    lines.push(
      `- **Host Canary Calibration**: \`${String(canary.status || 'unknown').toUpperCase()}\` — Node CPU \`${canary.nodeCpuComputeMs}ms\`, Chrome Layout+JS \`${canary.browserMainThreadComputeMs ?? '—'}ms\`, Ref FCP \`${canary.referenceFcpMs ?? '—'}ms\` (${canary.host?.cpuModel || 'host'}, ${canary.host?.cpuCores || '?'} cores)`
    );
  }
  lines.push('');

  if (Array.isArray(summary.leaderboard) && summary.leaderboard.length > 0) {
    lines.push(
      '| Model | Mode | Cells | Composite | Lighthouse | web-uplift | Deep Perf | Memory | Mob. LCP | W3C INP | P95 TTFB | Default Stack |'
    );
    lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const r of summary.leaderboard) {
      lines.push(
        `| **${r.label}** | \`${r.mode}\` | ${r.cellsRun} | **${r.scores.composite}** | ${r.scores.lighthouse ?? '—'} | ${r.scores.uplift ?? '—'} | ${r.scores.deepPerf ?? '—'} | ${r.scores.memory ?? '—'} | ${r.averages.mobileLcpMs != null ? `${r.averages.mobileLcpMs}ms` : '—'} | ${r.averages.inpMs != null ? `${r.averages.inpMs}ms` : '—'} | ${r.averages.burstP95TtfbMs != null ? `${r.averages.burstP95TtfbMs}ms` : '—'} | \`${r.dominantStack}\` |`
      );
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function printHelp() {
  console.log(`
Realistic Full-Stack & Agentic Web Generation Benchmark CLI

Usage:
  node bin/bench.mjs [options]

Options:
  --stage=all|generate|audit     Execution stage:
                                   all      (default) Run LLM generation + Canary + serialized Chrome audits
                                   generate           Stage 1 LLM generation ONLY (no Chrome needed; parallelizable)
                                   audit              Stage 2 Canary + serialized Chrome/MemLab audits on cached cells
  --audit-runs=<N>               Run browser audits N times per cell and select median score (default: 1, CI: 3)
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
  --skip-canary                  Skip host hardware canary calibration pass
  --skip-judge                   Use deterministic web-uplift CDP primitives without LLM judge pass
  --markdown-summary=<path>      Write Markdown leaderboard + Canary summary (e.g. $GITHUB_STEP_SUMMARY)
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
    console.log(
      `[score] Aggregated ${summary.totals.cells} cells (${summary.totals.agentCells} agent, ${summary.totals.oneshotCells} oneshot) -> data/summary.json`
    );
    if (opts.markdownSummaryPath) {
      writeFileSync(opts.markdownSummaryPath, formatMarkdownSummary(summary), 'utf8');
    }
    for (const row of summary.leaderboard) {
      console.log(
        `  ${(row.label + ' [' + row.mode + ']').padEnd(36)} Composite: ${String(row.scores.composite).padStart(5)} | LH: ${row.scores.lighthouse ?? '-'} | Uplift: ${row.scores.uplift ?? '-'} | Perf/INP: ${row.scores.deepPerf ?? '-'} | Mem: ${row.scores.memory ?? '-'} | Stack: ${row.dominantStack}`
      );
    }
    return;
  }

  const emitter = new EventEmitter();
  emitter.on('job:start', (info) => {
    console.log(
      `\n[bench] Starting ${info.jobId} (stage=${info.stage}, auditRuns=${info.auditRuns}, modes=${info.modes.join(', ')})`
    );
    console.log(`[bench] Models (${info.models.length}): ${info.models.join(', ') || '(none)'}`);
    if (info.skippedModels.length > 0) {
      console.log(
        `[bench] Skipped (${info.skippedModels.length} missing credentials): ${info.skippedModels.map((s) => s.key).join(', ')}`
      );
    }
    if (info.unknownModels?.length > 0) {
      console.warn(
        `[bench] ! Unrecognized model keys (${info.unknownModels.length}): ${info.unknownModels.join(', ')}`
      );
    }
    console.log(`[bench] Prompts (${info.prompts.length}): ${info.prompts.join(', ')}`);
    if (info.benchmarks.length > 0) {
      console.log(`[bench] Benchmarks: ${info.benchmarks.join(', ')}\n`);
    }
  });

  emitter.on('job:canary-done', ({ canary }) => {
    console.log(
      `  [canary] ${canary.status.toUpperCase()} — Node CPU ${canary.nodeCpuComputeMs}ms | Chrome Layout+JS ${canary.browserMainThreadComputeMs ?? '-'}ms | Ref FCP ${canary.referenceFcpMs ?? '-'}ms`
    );
  });

  emitter.on('cell:stage', ({ cellId, stage, detail }) => {
    console.log(`  [${cellId}] (${stage}) ${detail}`);
  });

  emitter.on('cell:done', ({ cellId, ok, error }) => {
    if (ok) console.log(`  ✓ [${cellId}] Complete\n`);
    else console.error(`  ✗ [${cellId}] Failed: ${error}\n`);
  });

  const res = await runBenchmarkJob(opts, emitter);
  console.log(`[bench] Finished (${res.stage}): ${res.completedCells} succeeded, ${res.failedCells} failed.`);

  const mdOut = opts.markdownSummaryPath || process.env.BENCH_STEP_SUMMARY_PATH || null;
  if (mdOut) {
    const md = formatMarkdownSummary(res.summary);
    if (mdOut === process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(mdOut, md, 'utf8');
    } else {
      writeFileSync(mdOut, md, 'utf8');
    }
  }

  if (res.summary.leaderboard.length > 0) {
    console.log('\n=== Leaderboard ===');
    for (const row of res.summary.leaderboard) {
      console.log(
        `  ${(row.label + ' [' + row.mode + ']').padEnd(36)} Score: ${String(row.scores.composite).padStart(5)} | LCP: ${row.averages.mobileLcpMs ?? '-'}ms | TTFB(p95): ${row.averages.burstP95TtfbMs ?? '-'}ms | INP: ${row.averages.inpMs ?? '-'}ms | MemScore: ${row.scores.memory ?? '-'} | Stack: ${row.dominantStack}`
      );
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[bench] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
