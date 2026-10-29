#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { validatePromptRegistry } from './validate-prompts.mjs';
import { initializeModelRuntime } from '../harness/model-registry.mjs';
import { loadBenchmarkConfig } from '../util/env.mjs';

export async function validateAll() {
  const promptValidation = validatePromptRegistry();
  const config = loadBenchmarkConfig();
  const runtime = await initializeModelRuntime();

  const readyModels = runtime.models.filter((m) => m.ready);
  const errors = [...promptValidation.errors];

  if (runtime.models.length === 0) {
    errors.push('Model registry contains 0 models');
  }
  const weightSum = Object.values(config.scoring?.weights || {}).reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1.0) > 0.001) {
    errors.push(`Scoring weights in config/benchmark.json must sum to 1.0 (got ${weightSum})`);
  }

  return {
    valid: errors.length === 0,
    prompts: {
      categories: promptValidation.categoryCount,
      total: promptValidation.promptCount,
      pilot: promptValidation.pilotCount,
    },
    models: {
      total: runtime.models.length,
      readyCount: readyModels.length,
      readyKeys: readyModels.map((m) => `${m.key} -> ${m.activeRoute.provider}/${m.activeRoute.modelId} (${m.activeRoute.via})`),
    },
    piRuntime: runtime.piRuntime,
    providerBridges: (runtime.providerBridges || []).filter((b) => b.installed).map((b) => `${b.id}@${b.version}`),
    errors,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateAll()
    .then((res) => {
      console.log(
        `[validate] pi CLI:  v${res.piRuntime?.version || 'unavailable'} (${res.piRuntime?.source || 'missing'}) | Clean-room bridges: ${res.providerBridges.join(', ') || 'none'}`
      );
      console.log(`[validate] Prompts: ${res.prompts.total} across ${res.prompts.categories} categories (${res.prompts.pilot} pilot)`);
      console.log(`[validate] Models:  ${res.models.total} configured, ${res.models.readyCount} ready with live credentials:`);
      for (const rk of res.models.readyKeys) {
        console.log(`  ✓ ${rk}`);
      }
      if (!res.valid) {
        console.error('[validate] Validation errors:');
        for (const e of res.errors) console.error(`  ✗ ${e}`);
        process.exit(1);
      }
      console.log('[validate] All schemas, zero-bias prompt rules, journeys, and model routes are valid.');
    })
    .catch((err) => {
      console.error(`[validate] Fatal error: ${err.message}`);
      process.exit(1);
    });
}
