import techStackBench from './tech-stack.bench.mjs';
import lighthouseUpliftBench from './lighthouse-uplift.bench.mjs';
import deepPerfBench from './deep-perf.bench.mjs';
import memoryBench from './memory.bench.mjs';

export const BENCHMARK_PLUGINS = [
  techStackBench,
  lighthouseUpliftBench,
  deepPerfBench,
  memoryBench,
];

export function getBenchmarkById(id) {
  return BENCHMARK_PLUGINS.find((b) => b.id === id) || null;
}

export function selectBenchmarks(ids = null) {
  if (!ids || ids.length === 0) return BENCHMARK_PLUGINS;
  const set = new Set(ids);
  return BENCHMARK_PLUGINS.filter((b) => set.has(b.id));
}
