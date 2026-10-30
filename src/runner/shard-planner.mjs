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
 * Scales shard counts automatically with (models × modes × prompts × auditRuns) while
 * staying safely below GitHub Actions' 256-job matrix ceiling.
 */
export function planWorkflowShards({
  modelsRaw = '',
  promptScope = 'pilot',
  customPromptsRaw = '',
  mode = 'agent',
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
  const modes = normalizedMode === 'both' ? ['agent', 'oneshot'] : [normalizedMode === 'oneshot' ? 'oneshot' : 'agent'];
  const runsPerCell = Math.max(1, Math.min(7, Number(auditRuns) || 1));
  const cleanReuseRunId = String(reuseGenerationRunId || '').trim();
  const skipGenerate = cleanReuseRunId.length > 0;

  const totalCells = models.length * modes.length * selectedPromptIds.length;

  // --- 1. Plan Stage 1 Generate Shards ---
  const generateShards = [];
  if (!skipGenerate) {
    // Agent mode benefits from small shards (~4 prompts/shard); oneshot can batch ~10 prompts/shard.
    // Ensure total shards across all models & modes never exceed maxGenerateShards.
    const modelModePairs = models.length * modes.length;
    const maxChunksPerPair = Math.max(1, Math.floor(maxGenerateShards / Math.max(1, modelModePairs)));

    for (const model of models) {
      const modelSlug = sanitizeSlug(model);
      for (const cellMode of modes) {
        const idealChunkSize = cellMode === 'agent' ? 4 : 10;
        const minChunkForCap = Math.ceil(selectedPromptIds.length / maxChunksPerPair);
        const chunkSize = Math.max(idealChunkSize, minChunkForCap);
        const promptChunks = chunkArray(selectedPromptIds, chunkSize);

        promptChunks.forEach((chunk, idx) => {
          const shardNum = idx + 1;
          generateShards.push({
            model,
            modelSlug,
            mode: cellMode,
            shardId: `${modelSlug}-${cellMode}-gen-${shardNum}`,
            label: `${model} [${cellMode}] (${shardNum}/${promptChunks.length}: ${chunk.length}p)`,
            promptCount: chunk.length,
            promptFlag: `--prompts=${chunk.join(',')}`,
          });
        });
      }
    }
  }

  // --- 2. Plan Stage 2 Isolated-VM Audit Shards ---
  // Each VM runs strictly concurrency=1 Chrome locally, while multiple VMs run in parallel!
  // Target ~4 audit pass-equivalents per VM (~2–5 min wall-clock per VM shard).
  const modelModePairs = models.length * modes.length;
  const maxAuditChunksPerPair = Math.max(1, Math.floor(maxAuditShards / Math.max(1, modelModePairs)));
  const idealCellsPerAuditShard = runsPerCell >= 5 ? 1 : runsPerCell >= 3 ? 2 : 4;
  const minAuditChunkForCap = Math.ceil(selectedPromptIds.length / maxAuditChunksPerPair);
  const cellsPerAuditShard = Math.max(idealCellsPerAuditShard, minAuditChunkForCap);

  const auditShards = [];
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
          shardId: `${modelSlug}-${cellMode}-audit-${shardNum}`,
          label: `${model} [${cellMode}] (${shardNum}/${promptChunks.length}: ${chunk.length} cells)`,
          cellCount: chunk.length,
          promptFlag: `--prompts=${chunk.join(',')}`,
          artifactPattern: skipGenerate
            ? 'generated-cells-*'
            : `generated-cells-${modelSlug}-${cellMode}-*`,
        });
      });
    }
  }

  return {
    scope: normalizedScope,
    models,
    modes,
    selectedPromptIds,
    totalCells,
    auditRuns: runsPerCell,
    skipGenerate,
    reuseGenerationRunId: cleanReuseRunId,
    generateShards,
    auditShards,
  };
}
