#!/usr/bin/env node
// Builds and starts the container kit of every full-app cell under a cells folder (default runs/cells) and
// records the verdict in <cell>/container-check.json. Never fails the job: a kit that does not build is a
// finding for the report, not a pipeline error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyCellContainer, writeContainerCheck } from '../src/hosting/verify-container.mjs';
import { parseCellDirIdentity } from '../src/harness/generate.mjs';

const cellsRoot = resolve(process.argv[2] || 'runs/cells');
const budgetMs = Number(process.env.CONTAINER_VERIFY_BUDGET_MS || 20 * 60000);
if (spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 20000 }).status !== 0) {
  console.log('[container-check] Docker is not available on this machine; nothing verified.');
  process.exit(0);
}
// Optional shard selectors (same ones the audit step uses), so a job only spends its budget on its own cells.
const want = {
  harness: process.env.SHARD_HARNESS || '',
  mode: process.env.SHARD_MODE || '',
  spec: process.env.SHARD_SPEC || '',
  sample: process.env.SHARD_SAMPLE ? Number(process.env.SHARD_SAMPLE) : null,
  models: new Set(String(process.env.SHARD_MODEL || '').split(',').map((m) => m.trim().replace(/\./g, '-')).filter(Boolean)),
  prompts: new Set(String(process.env.SHARD_PROMPT_FLAG || '').replace(/^--prompts=/, '').split(',').map((p) => p.trim()).filter(Boolean)),
};
function inShard(entry, cellDir) {
  let gen = {};
  try {
    gen = JSON.parse(readFileSync(join(cellDir, 'generation.json'), 'utf8'));
  } catch {
    // identity then comes from the folder name alone
  }
  const id = parseCellDirIdentity(entry, gen);
  const modelKey = String(gen.modelKey || entry.split('__')[0] || '').replace(/\./g, '-');
  const promptId = gen.promptId || entry.split('__')[1] || '';
  if (want.harness && (id.harness || 'pi') !== want.harness) return false;
  if (want.mode && id.mode !== want.mode) return false;
  if (want.spec && id.spec !== want.spec) return false;
  if (want.sample !== null && (id.sample || 1) !== want.sample) return false;
  if (want.models.size > 0 && !want.models.has(modelKey)) return false;
  if (want.prompts.size > 0 && !want.prompts.has(promptId)) return false;
  return true;
}
const started = Date.now();
let n = 0;
for (const entry of existsSync(cellsRoot) ? readdirSync(cellsRoot).sort() : []) {
  const cellDir = join(cellsRoot, entry);
  const matFile = join(cellDir, 'materialization.json');
  if (!statSync(cellDir).isDirectory() || !existsSync(matFile)) continue;
  let materialization;
  try {
    materialization = JSON.parse(readFileSync(matFile, 'utf8'));
  } catch {
    continue;
  }
  if (materialization?.serverArchitecture !== 'production-server') continue;
  if (!inShard(entry, cellDir)) continue;
  if (Date.now() - started > budgetMs) {
    console.log(`[container-check] Time budget used up; ${entry} left unverified.`);
    continue;
  }
  const result = await verifyCellContainer({ cellDir, materialization, hostPort: 18080 + (n++ % 100) });
  writeContainerCheck(cellDir, result);
  console.log(`[container-check] ${entry}: ${!result.applicable ? `skipped (${result.error})` : result.started ? `built in ${result.buildSeconds}s, answered HTTP ${result.httpStatus}` : `FAILED: ${result.error}`}`);
}
console.log(`[container-check] ${n} full-app cell(s) checked.`);
