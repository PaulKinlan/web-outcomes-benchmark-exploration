#!/usr/bin/env node
// Builds and starts the container kit of every full-app cell under a cells folder (default runs/cells) and
// records the verdict in <cell>/container-check.json. Never fails the job: a kit that does not build is a
// finding for the report, not a pipeline error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyCellContainer, writeContainerCheck } from '../src/hosting/verify-container.mjs';

const cellsRoot = resolve(process.argv[2] || 'runs/cells');
const budgetMs = Number(process.env.CONTAINER_VERIFY_BUDGET_MS || 20 * 60000);
if (spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 20000 }).status !== 0) {
  console.log('[container-check] Docker is not available on this machine; nothing verified.');
  process.exit(0);
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
  if (Date.now() - started > budgetMs) {
    console.log(`[container-check] Time budget used up; ${entry} left unverified.`);
    continue;
  }
  const result = await verifyCellContainer({ cellDir, materialization, hostPort: 18080 + (n++ % 100) });
  writeContainerCheck(cellDir, result);
  console.log(`[container-check] ${entry}: ${!result.applicable ? `skipped (${result.error})` : result.started ? `built in ${result.buildSeconds}s, answered HTTP ${result.httpStatus}` : `FAILED: ${result.error}`}`);
}
console.log(`[container-check] ${n} full-app cell(s) checked.`);
