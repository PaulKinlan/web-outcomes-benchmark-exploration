#!/usr/bin/env node
/**
 * GitHub Pages replaces the whole site on every deploy, so earlier runs would disappear. Before exporting,
 * this copies the compact dataset of each earlier run from the live site into dist-report/runs/, where the
 * export then adds the new run. Only the small report-data.json per run is kept, not previews or transcripts.
 *
 *   node scripts/fetch-run-archive.mjs https://<owner>.github.io/<repo>/ [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/util/env.mjs';

const base = (process.argv[2] || process.env.PAGES_BASE_URL || '').replace(/\/+$/, '');
const outDir = process.argv[3] || join(PROJECT_ROOT, 'dist-report');
const maxRuns = Number(process.env.BENCH_ARCHIVE_MAX_RUNS || 20);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

if (!base) {
  console.log('[archive] No published site URL given; starting a fresh archive.');
  process.exit(0);
}

try {
  const index = await getJson(`${base}/runs/index.json`);
  const kept = [];
  for (const run of (index.runs || []).slice(0, maxRuns - 1)) {
    if (!/^[A-Za-z0-9._-]+$/.test(run.runId || '')) continue;
    try {
      const data = await getJson(`${base}/runs/${run.runId}/report-data.json`);
      mkdirSync(join(outDir, 'runs', run.runId), { recursive: true });
      writeFileSync(join(outDir, 'runs', run.runId, 'report-data.json'), JSON.stringify(data), 'utf8');
      kept.push(run);
    } catch (err) {
      console.warn(`[archive] Skipping run ${run.runId}: ${err.message}`);
    }
  }
  mkdirSync(join(outDir, 'runs'), { recursive: true });
  writeFileSync(join(outDir, 'runs', 'index.json'), JSON.stringify({ runs: kept }, null, 2) + '\n', 'utf8');
  console.log(`[archive] Restored ${kept.length} earlier run(s) from ${base}.`);
} catch (err) {
  // First deploy, or the site has no archive yet: not an error.
  console.log(`[archive] No earlier archive found (${err.message}); starting fresh.`);
}
