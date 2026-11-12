import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../util/env.mjs';
import { loadModelRegistryConfig, matchesModelSelector } from '../harness/model-registry.mjs';
import { expandHarnessSelection, isModelCompatibleWithHarness, getHarnessSpec } from '../harness/harness-registry.mjs';

function sanitizeSlug(str) {
  return String(str || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function chunkArray(items, chunkSize) {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function isShardModelHarnessCompatible(modelSlug, cellHarness, modelMap, explicitSinglePair) {
  if (cellHarness === 'pi' || explicitSinglePair) return true;
  const known = modelMap.get(modelSlug);
  if (known) {
    return isModelCompatibleWithHarness(known, cellHarness);
  }
  const low = String(modelSlug || '').toLowerCase();
  const hints = getHarnessSpec(cellHarness)?.modelHints;
  if (Array.isArray(hints) && hints.length > 0) return hints.some((h) => low.includes(h));
  return true;
}

function loadGenerationConfig() {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, 'config', 'benchmark.json'), 'utf8')).generation || {};
  } catch {
    return {};
  }
}

/**
 * Suggests registry keys that look like a mistyped selector (shared leading token or substring overlap).
 */
function suggestModelKeys(rawSelector, registryModels) {
  const low = String(rawSelector || '').trim().toLowerCase().replace(/[./\s]+/g, '-');
  const head = low.split('-')[0];
  return registryModels
    .map((m) => m.key)
    .filter((key) => key.startsWith(`${head}-`) || key === head || low.startsWith(key) || key.startsWith(low))
    .slice(0, 5);
}

/**
 * Resolves raw model selectors against config/models.json (+ synced catalog cache) so typos fail in the
 * planning job instead of after every generate shard has booted. Provider-qualified ids (`anthropic/foo`)
 * are allowed through because `bench` can resolve them from the built-in pi-ai catalog at runtime.
 */
export function validateModelSelectors(models, registryModels = []) {
  const unknown = [];
  for (const raw of models) {
    if (String(raw).includes('/')) continue;
    if (registryModels.some((m) => matchesModelSelector(m, raw))) continue;
    unknown.push({ selector: raw, suggestions: suggestModelKeys(raw, registryModels) });
  }
  return unknown;
}

/**
 * Largest number of agent-mode prompts one generate job can hold while still finishing inside the job
 * timeout if every cell runs to the per-cell agent timeout. Waves = ceil(prompts / agentConcurrency).
 */
export function maxAgentPromptsPerShard({
  jobTimeoutMinutes = 180,
  setupOverheadMinutes = 8,
  agentTimeoutMs = 1800000,
  agentConcurrency = 2,
} = {}) {
  const cellMinutes = Math.max(1, agentTimeoutMs / 60000);
  const waves = Math.max(1, Math.floor((jobTimeoutMinutes - setupOverheadMinutes) / cellMinutes));
  return waves * Math.max(1, agentConcurrency);
}

/**
 * Dynamically plans parallel Generate and Audit task shards for CI / multi-VM execution.
 * Scales shard counts automatically with (harnesses × models × modes × specs × prompts × auditRuns) while
 * staying safely below GitHub Actions' 256-job matrix ceiling.
 */
export function planWorkflowShards({
  modelsRaw = '',
  promptScope = 'all',
  customPromptsRaw = '',
  harness = 'pi',
  mode = 'agent',
  spec = 'freeform',
  auditRuns = 1,
  samples = 1,
  samplePromptCount = 2,
  reuseGenerationRunId = '',
  maxGenerateShards = 240,
  maxAuditShards = 160,
  generateJobTimeoutMinutes = 180,
  strictModels = false,
  promptRegistry = null,
  modelRegistry = null,
  generationConfig = null,
} = {}) {
  const models = (Array.isArray(modelsRaw) ? modelsRaw : String(modelsRaw || '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);

  if (models.length === 0) {
    throw new Error('At least one model must be provided in modelsRaw.');
  }

  const reg =
    promptRegistry ||
    JSON.parse(readFileSync(join(PROJECT_ROOT, 'prompts', 'index.json'), 'utf8'));
  const mReg = modelRegistry || loadModelRegistryConfig();
  const modelMap = new Map((mReg.models || []).map((m) => [m.key, m]));

  const unknownModels = validateModelSelectors(models, mReg.models || []);
  if (strictModels && unknownModels.length > 0) {
    const detail = unknownModels
      .map((u) => `"${u.selector}"${u.suggestions.length ? ` (did you mean: ${u.suggestions.join(', ')}?)` : ''}`)
      .join('; ');
    throw new Error(
      `Unrecognized model selector(s): ${detail}. Use a key or alias from config/models.json, ` +
        'or a provider-qualified id such as anthropic/<model-id> for built-in pi-ai catalog models.'
    );
  }
  const genCfg = generationConfig || loadGenerationConfig();
  const warnings = [];

  const allPrompts = (reg.prompts || []).map((p) => p.id);
  const pilotPrompts = (reg.prompts || []).filter((p) => p.pilot).map((p) => p.id);

  let selectedPromptIds = [];
  const normalizedScope = String(promptScope || 'pilot').trim().toLowerCase();
  if (normalizedScope === 'all') {
    selectedPromptIds = allPrompts;
  } else if (normalizedScope === 'pilot') {
    selectedPromptIds = pilotPrompts;
  } else if (normalizedScope === 'fullapp') {
    // Prompts that need accounts, stored user content or an admin area: the builds where server-side quality
    // and the security probes have something to measure.
    selectedPromptIds = (reg.prompts || []).filter((p) => (p.tags || []).includes('full-app')).map((p) => p.id);
  } else {
    const parsedCustom = String(customPromptsRaw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    selectedPromptIds = parsedCustom.length > 0 ? parsedCustom : ['plumbing-appointment'];
  }

  const harnesses = expandHarnessSelection(harness || 'pi');

  const normalizedMode = String(mode || 'agent').trim().toLowerCase();
  const modes =
    normalizedMode === 'both' ? ['agent', 'oneshot'] : [normalizedMode === 'oneshot' ? 'oneshot' : 'agent'];

  const normalizedSpec = String(spec || 'freeform').trim().toLowerCase();
  const specs =
    normalizedSpec === 'both' ? ['freeform', 'guided'] : [normalizedSpec === 'guided' ? 'guided' : 'freeform'];

  const runsPerCell = Math.max(1, Math.min(7, Number(auditRuns) || 1));
  const cleanReuseRunId = String(reuseGenerationRunId || '').trim();
  const skipGenerate = cleanReuseRunId.length > 0;

  // Enumerate valid (harness, spec, model, mode) combos
  const explicitSinglePair = models.length === 1 && harnesses.length === 1;
  const activeCombos = [];
  for (const cellHarness of harnesses) {
    for (const cellSpec of specs) {
      for (const model of models) {
        if (!isShardModelHarnessCompatible(model, cellHarness, modelMap, explicitSinglePair)) continue;
        for (const cellMode of modes) {
          if (cellHarness !== 'pi' && cellMode === 'oneshot') continue;
          activeCombos.push({ cellHarness, cellSpec, model, cellMode });
        }
      }
    }
  }

  const comboCount = activeCombos.length;
  // Repeat samples regenerate only a couple of anchor prompts per combo: enough to measure run-to-run variation
  // without paying for the whole matrix twice.
  const sampleCount = Math.max(1, Math.min(5, Math.floor(Number(samples) || 1)));
  const samplePromptIds = sampleCount > 1 ? selectedPromptIds.slice(0, Math.max(1, Math.floor(Number(samplePromptCount) || 2))) : [];
  const repeatCells = comboCount * samplePromptIds.length * (sampleCount - 1);
  const totalCells = comboCount * selectedPromptIds.length + repeatCells;

  // --- 1. Plan Stage 1 Generate Shards ---
  // One-shot shards are fast, so they get a fixed share of the job budget; agent shards get the rest and
  // are additionally capped so a full shard of worst-case (agentTimeoutMs) cells still fits the job timeout.
  const generateShards = [];
  if (!skipGenerate) {
    const promptTotal = selectedPromptIds.length;
    const ONESHOT_IDEAL_CHUNK = 10;
    const AGENT_IDEAL_CHUNK = 4;
    const oneshotCombos = activeCombos.filter((c) => c.cellMode === 'oneshot').length;
    const agentCombos = comboCount - oneshotCombos;
    if (comboCount > maxGenerateShards) {
      throw new Error(
        `Matrix has ${comboCount} model/harness/mode/spec combinations but at most ${maxGenerateShards} generate jobs fit ` +
          'one workflow run; split the run into smaller model or harness selections.'
      );
    }
    // One-shot combos keep their ideal chunking unless that would starve the agent combos (which need at
    // least one shard each); then their chunks grow to fit what is left.
    const oneshotChunksEach =
      oneshotCombos > 0
        ? Math.max(
            1,
            Math.min(
              Math.ceil(promptTotal / ONESHOT_IDEAL_CHUNK),
              Math.floor((maxGenerateShards - agentCombos) / oneshotCombos)
            )
          )
        : 0;
    const oneshotChunkSize = Math.max(1, Math.ceil(promptTotal / Math.max(1, oneshotChunksEach)));
    const agentBudget = Math.max(agentCombos, maxGenerateShards - oneshotCombos * oneshotChunksEach);
    const maxAgentChunksPerCombo = Math.max(1, Math.floor(agentBudget / Math.max(1, agentCombos)));
    const agentTimeCap = maxAgentPromptsPerShard({
      jobTimeoutMinutes: generateJobTimeoutMinutes,
      agentTimeoutMs: genCfg.agentTimeoutMs || 1800000,
      agentConcurrency: genCfg.agentConcurrency || 2,
    });
    const agentChunkSize = Math.max(
      Math.min(AGENT_IDEAL_CHUNK, agentTimeCap),
      Math.ceil(promptTotal / maxAgentChunksPerCombo)
    );
    if (agentCombos > 0 && agentChunkSize > agentTimeCap) {
      warnings.push(
        `Agent shards hold ${agentChunkSize} prompts but only ${agentTimeCap} are guaranteed to finish within ` +
          `${generateJobTimeoutMinutes} min at the per-cell agent timeout; raise maxGenerateShards or reduce the matrix.`
      );
    }

    for (const { cellHarness, cellSpec, model, cellMode } of activeCombos) {
      const modelSlug = sanitizeSlug(model);
      const specSuffix = cellSpec === 'guided' ? '-guided' : '';
      const harnessSuffix = cellHarness !== 'pi' ? `-${sanitizeSlug(cellHarness)}` : '';
      const specTag = specs.length > 1 || cellSpec === 'guided' ? `:${cellSpec}` : '';
      const harnessTag = harnesses.length > 1 || cellHarness !== 'pi' ? `:${cellHarness}` : '';

      const chunkSize = cellMode === 'agent' ? agentChunkSize : oneshotChunkSize;
      const promptChunks = chunkArray(selectedPromptIds, chunkSize);
      promptChunks.forEach((chunk, idx) => {
        const shardNum = idx + 1;
        generateShards.push({
          model,
          modelSlug,
          harness: cellHarness,
          mode: cellMode,
          spec: cellSpec,
          shardId: `${modelSlug}-${cellMode}${specSuffix}${harnessSuffix}-gen-${shardNum}`,
          label: `${model} [${cellMode}${specTag}${harnessTag}] (${shardNum}/${promptChunks.length}: ${chunk.length}p)`,
          promptCount: chunk.length,
          promptFlag: `--prompts=${chunk.join(',')}`,
          sampleFlag: '',
        });
      });
      for (let k = 2; k <= sampleCount; k++) {
        generateShards.push({
          model,
          modelSlug,
          harness: cellHarness,
          mode: cellMode,
          spec: cellSpec,
          sample: k,
          shardId: `${modelSlug}-${cellMode}${specSuffix}${harnessSuffix}-s${k}-gen-1`,
          label: `${model} [${cellMode}${specTag}${harnessTag}] (repeat sample ${k}: ${samplePromptIds.length}p)`,
          promptCount: samplePromptIds.length,
          promptFlag: `--prompts=${samplePromptIds.join(',')}`,
          sampleFlag: `--sample-index=${k}`,
        });
      }
    }
    if (generateShards.length > maxGenerateShards) {
      warnings.push(`Repeat samples bring the run to ${generateShards.length} generate jobs, over the ${maxGenerateShards} planned for; reduce the matrix or the samples.`);
    }
  }

  // --- 2. Plan Stage 2 Isolated-VM Audit Shards ---
  const maxAuditChunksPerCombo = Math.max(1, Math.floor(maxAuditShards / Math.max(1, comboCount)));
  const idealCellsPerAuditShard = runsPerCell >= 5 ? 1 : runsPerCell >= 3 ? 2 : 4;
  const minAuditChunkForCap = Math.ceil(selectedPromptIds.length / maxAuditChunksPerCombo);
  const cellsPerAuditShard = Math.max(idealCellsPerAuditShard, minAuditChunkForCap);

  const auditShards = [];
  for (const { cellHarness, cellSpec, model, cellMode } of activeCombos) {
    const modelSlug = sanitizeSlug(model);
    const specSuffix = cellSpec === 'guided' ? '-guided' : '';
    const harnessSuffix = cellHarness !== 'pi' ? `-${sanitizeSlug(cellHarness)}` : '';
    const specTag = specs.length > 1 || cellSpec === 'guided' ? `:${cellSpec}` : '';
    const harnessTag = harnesses.length > 1 || cellHarness !== 'pi' ? `:${cellHarness}` : '';

    const promptChunks = chunkArray(selectedPromptIds, cellsPerAuditShard);
    promptChunks.forEach((chunk, idx) => {
      const shardNum = idx + 1;
      auditShards.push({
        model,
        modelSlug,
        harness: cellHarness,
        mode: cellMode,
        spec: cellSpec,
        shardId: `${modelSlug}-${cellMode}${specSuffix}${harnessSuffix}-audit-${shardNum}`,
        label: `${model} [${cellMode}${specTag}${harnessTag}] (${shardNum}/${promptChunks.length}: ${chunk.length} cells)`,
        cellCount: chunk.length,
        promptFlag: `--prompts=${chunk.join(',')}`,
        sampleFlag: '',
        artifactPattern: skipGenerate
          ? 'generated-cells-*'
          : `generated-cells-${modelSlug}-${cellMode}${specSuffix}${harnessSuffix}-gen-*`,
      });
    });
    for (let k = 2; k <= sampleCount; k++) {
      auditShards.push({
        model,
        modelSlug,
        harness: cellHarness,
        mode: cellMode,
        spec: cellSpec,
        sample: k,
        shardId: `${modelSlug}-${cellMode}${specSuffix}${harnessSuffix}-s${k}-audit-1`,
        label: `${model} [${cellMode}${specTag}${harnessTag}] (repeat sample ${k}: ${samplePromptIds.length} cells)`,
        cellCount: samplePromptIds.length,
        promptFlag: `--prompts=${samplePromptIds.join(',')}`,
        sampleFlag: `--sample-index=${k}`,
        artifactPattern: skipGenerate
          ? 'generated-cells-*'
          : `generated-cells-${modelSlug}-${cellMode}${specSuffix}${harnessSuffix}-s${k}-gen-*`,
      });
    }
  }

  return {
    scope: normalizedScope,
    models,
    harnesses,
    modes,
    specs,
    selectedPromptIds,
    promptCount: selectedPromptIds.length,
    totalCells,
    auditRuns: runsPerCell,
    samples: sampleCount,
    samplePromptIds,
    repeatCells,
    unknownModels,
    warnings,
    skipGenerate,
    reuseGenerationRunId: cleanReuseRunId,
    generateShards,
    auditShards,
  };
}
