import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../util/env.mjs';
import { loadModelRegistryConfig } from '../harness/model-registry.mjs';
import { expandHarnessSelection, isModelCompatibleWithHarness } from '../harness/harness-registry.mjs';

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
  if (cellHarness === 'claude-acp') return low.includes('claude') || low.includes('anthropic');
  if (cellHarness === 'codex-acp') return low.includes('gpt') || low.includes('codex') || low.includes('o3') || low.includes('o4');
  return true;
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
  reuseGenerationRunId = '',
  maxGenerateShards = 120,
  maxAuditShards = 160,
  promptRegistry = null,
  modelRegistry = null,
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

  const allPrompts = (reg.prompts || []).map((p) => p.id);
  const pilotPrompts = (reg.prompts || []).filter((p) => p.pilot).map((p) => p.id);

  let selectedPromptIds = [];
  const normalizedScope = String(promptScope || 'pilot').trim().toLowerCase();
  if (normalizedScope === 'all') {
    selectedPromptIds = allPrompts;
  } else if (normalizedScope === 'pilot') {
    selectedPromptIds = pilotPrompts;
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
  const totalCells = comboCount * selectedPromptIds.length;

  // --- 1. Plan Stage 1 Generate Shards ---
  const generateShards = [];
  if (!skipGenerate) {
    const maxChunksPerCombo = Math.max(1, Math.floor(maxGenerateShards / Math.max(1, comboCount)));

    for (const { cellHarness, cellSpec, model, cellMode } of activeCombos) {
      const modelSlug = sanitizeSlug(model);
      const specSuffix = cellSpec === 'guided' ? '-guided' : '';
      const harnessSuffix = cellHarness !== 'pi' ? `-${sanitizeSlug(cellHarness)}` : '';
      const specTag = specs.length > 1 || cellSpec === 'guided' ? `:${cellSpec}` : '';
      const harnessTag = harnesses.length > 1 || cellHarness !== 'pi' ? `:${cellHarness}` : '';

      const idealChunkSize = cellMode === 'agent' ? 4 : 10;
      const minChunkForCap = Math.ceil(selectedPromptIds.length / maxChunksPerCombo);
      const chunkSize = Math.max(idealChunkSize, minChunkForCap);
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
        });
      });
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
        artifactPattern: skipGenerate
          ? 'generated-cells-*'
          : `generated-cells-${modelSlug}-${cellMode}${specSuffix}${harnessSuffix}-gen-*`,
      });
    });
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
    skipGenerate,
    reuseGenerationRunId: cleanReuseRunId,
    generateShards,
    auditShards,
  };
}
