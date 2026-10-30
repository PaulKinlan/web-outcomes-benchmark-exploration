import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../util/env.mjs';

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

/**
 * Dynamically plans parallel Generate and Audit task shards for CI / multi-VM execution.
 * Scales shard counts automatically with (models × modes × specs × prompts × auditRuns) while
 * staying safely below GitHub Actions' 256-job matrix ceiling.
 */
export function planWorkflowShards({
  modelsRaw = '',
  promptScope = 'pilot',
  customPromptsRaw = '',
  mode = 'agent',
  spec = 'freeform',
  auditRuns = 1,
  reuseGenerationRunId = '',
  maxGenerateShards = 120,
  maxAuditShards = 160,
  promptRegistry = null,
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

  const normalizedMode = String(mode || 'agent').trim().toLowerCase();
  const modes =
    normalizedMode === 'both' ? ['agent', 'oneshot'] : [normalizedMode === 'oneshot' ? 'oneshot' : 'agent'];

  const normalizedSpec = String(spec || 'freeform').trim().toLowerCase();
  const specs =
    normalizedSpec === 'both' ? ['freeform', 'guided'] : [normalizedSpec === 'guided' ? 'guided' : 'freeform'];

  const runsPerCell = Math.max(1, Math.min(7, Number(auditRuns) || 1));
  const cleanReuseRunId = String(reuseGenerationRunId || '').trim();
  const skipGenerate = cleanReuseRunId.length > 0;

  const totalCells = models.length * modes.length * specs.length * selectedPromptIds.length;
  const comboCount = models.length * modes.length * specs.length;

  // --- 1. Plan Stage 1 Generate Shards ---
  const generateShards = [];
  if (!skipGenerate) {
    const maxChunksPerCombo = Math.max(1, Math.floor(maxGenerateShards / Math.max(1, comboCount)));

    for (const cellSpec of specs) {
      const specSuffix = cellSpec === 'guided' ? '-guided' : '';
      const specTag = specs.length > 1 || cellSpec === 'guided' ? `:${cellSpec}` : '';
      for (const model of models) {
        const modelSlug = sanitizeSlug(model);
        for (const cellMode of modes) {
          const idealChunkSize = cellMode === 'agent' ? 4 : 10;
          const minChunkForCap = Math.ceil(selectedPromptIds.length / maxChunksPerCombo);
          const chunkSize = Math.max(idealChunkSize, minChunkForCap);
          const promptChunks = chunkArray(selectedPromptIds, chunkSize);

          promptChunks.forEach((chunk, idx) => {
            const shardNum = idx + 1;
            generateShards.push({
              model,
              modelSlug,
              mode: cellMode,
              spec: cellSpec,
              shardId: `${modelSlug}-${cellMode}${specSuffix}-gen-${shardNum}`,
              label: `${model} [${cellMode}${specTag}] (${shardNum}/${promptChunks.length}: ${chunk.length}p)`,
              promptCount: chunk.length,
              promptFlag: `--prompts=${chunk.join(',')}`,
            });
          });
        }
      }
    }
  }

  // --- 2. Plan Stage 2 Isolated-VM Audit Shards ---
  const maxAuditChunksPerCombo = Math.max(1, Math.floor(maxAuditShards / Math.max(1, comboCount)));
  const idealCellsPerAuditShard = runsPerCell >= 5 ? 1 : runsPerCell >= 3 ? 2 : 4;
  const minAuditChunkForCap = Math.ceil(selectedPromptIds.length / maxAuditChunksPerCombo);
  const cellsPerAuditShard = Math.max(idealCellsPerAuditShard, minAuditChunkForCap);

  const auditShards = [];
  for (const cellSpec of specs) {
    const specSuffix = cellSpec === 'guided' ? '-guided' : '';
    const specTag = specs.length > 1 || cellSpec === 'guided' ? `:${cellSpec}` : '';
    for (const model of models) {
      const modelSlug = sanitizeSlug(model);
      for (const cellMode of modes) {
        const promptChunks = chunkArray(selectedPromptIds, cellsPerAuditShard);
        promptChunks.forEach((chunk, idx) => {
          const shardNum = idx + 1;
          auditShards.push({
            model,
            modelSlug,
            mode: cellMode,
            spec: cellSpec,
            shardId: `${modelSlug}-${cellMode}${specSuffix}-audit-${shardNum}`,
            label: `${model} [${cellMode}${specTag}] (${shardNum}/${promptChunks.length}: ${chunk.length} cells)`,
            cellCount: chunk.length,
            promptFlag: `--prompts=${chunk.join(',')}`,
            artifactPattern: skipGenerate
              ? 'generated-cells-*'
              : `generated-cells-${modelSlug}-${cellMode}${specSuffix}-gen-*`,
          });
        });
      }
    }
  }

  return {
    scope: normalizedScope,
    models,
    modes,
    specs,
    selectedPromptIds,
    totalCells,
    auditRuns: runsPerCell,
    skipGenerate,
    reuseGenerationRunId: cleanReuseRunId,
    generateShards,
    auditShards,
  };
}
