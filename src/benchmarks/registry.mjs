import techStackBench from './tech-stack.bench.mjs';
import promptJudgeBench from './prompt-judge.bench.mjs';
import consoleErrorsBench from './console-errors.bench.mjs';
import lighthouseUpliftBench from './lighthouse-uplift.bench.mjs';
import deepPerfBench from './deep-perf.bench.mjs';
import memoryBench from './memory.bench.mjs';
import securityBench from './security.bench.mjs';
import outsideInBench from './outside-in.bench.mjs';

export const BENCHMARK_PLUGINS = [
  techStackBench,
  promptJudgeBench,
  consoleErrorsBench,
  lighthouseUpliftBench,
  deepPerfBench,
  memoryBench,
  // After every other scored benchmark on purpose: its active probes write junk into the app, which must not colour their measurements.
  securityBench,
  // Optional and unscored: a temporary public address so outside services can test a generated server.
  // Very last, with its own time budget, so slow outside services can never eat the time of a scored check.
  outsideInBench,
];

export function getBenchmarkById(id) {
  return BENCHMARK_PLUGINS.find((b) => b.id === id) || null;
}

export function selectBenchmarks(ids = null) {
  if (!ids || ids.length === 0) return BENCHMARK_PLUGINS;
  const set = new Set(ids);
  return BENCHMARK_PLUGINS.filter((b) => set.has(b.id));
}
