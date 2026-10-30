import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, '..', '..');
export const PROMPTS_INDEX_PATH = join(PROJECT_ROOT, 'prompts', 'index.json');
export const DESIGN_DOC_PATH = join(PROJECT_ROOT, 'prompts', 'design.md');
export const SEED_DATA_PATH = join(PROJECT_ROOT, 'prompts', 'seed-data.json');
export const CUSTOM_PROMPTS_DIR = join(PROJECT_ROOT, 'prompts', 'custom');

export function loadDesignDoc() {
  if (!existsSync(DESIGN_DOC_PATH)) return '';
  return readFileSync(DESIGN_DOC_PATH, 'utf8');
}

export function loadSeedDataMap() {
  if (!existsSync(SEED_DATA_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SEED_DATA_PATH, 'utf8'));
    return parsed?.prompts || parsed || {};
  } catch {
    return {};
  }
}

export function loadPromptRegistry() {
  const base = JSON.parse(readFileSync(PROMPTS_INDEX_PATH, 'utf8'));
  const builtinIds = new Set((base.prompts || []).map((p) => p.id));
  const categories = [...(base.categories || [])];
  const prompts = [...(base.prompts || [])];
  const designDoc = loadDesignDoc();
  const seedMap = loadSeedDataMap();

  if (existsSync(CUSTOM_PROMPTS_DIR)) {
    const files = readdirSync(CUSTOM_PROMPTS_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const entry = JSON.parse(readFileSync(join(CUSTOM_PROMPTS_DIR, file), 'utf8'));
      if (Array.isArray(entry)) {
        prompts.push(...entry);
      } else if (entry && entry.id) {
        prompts.push(entry);
      }
    }
  }

  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const enrichedPrompts = prompts.map((p) => {
    const rawSeed = p.seedData || seedMap[p.id] || null;
    let cleanSeedData = null;
    if (rawSeed && typeof rawSeed === 'object') {
      const { layoutMockupPrompt: _ignoredMockup, ...rest } = rawSeed;
      cleanSeedData = rest;
    }

    const defaultRefRel = `assets/reference-images/${p.id}.jpg`;
    const hasDefaultRefFile = existsSync(join(PROJECT_ROOT, defaultRefRel));
    const guidedReferenceImages =
      Array.isArray(p.referenceImages) && p.referenceImages.length > 0
        ? p.referenceImages
        : [
            {
              path: defaultRefRel,
              label: `${p.title} — Proposed Desktop Layout Reference`,
              available: hasDefaultRefFile,
            },
          ];

    return {
      ...p,
      isBuiltin: builtinIds.has(p.id),
      categoryLabel: categoryMap.get(p.category)?.label || p.category,
      seedData: cleanSeedData,
      guidedReferenceImages,
    };
  });

  return {
    version: base.version,
    categories,
    prompts: enrichedPrompts,
    designDoc,
  };
}

export function selectPrompts({ ids = null, categories = null, pilot = false } = {}) {
  const { prompts } = loadPromptRegistry();
  let filtered = prompts;
  if (ids && ids.length > 0) {
    const set = new Set(ids);
    filtered = filtered.filter((p) => set.has(p.id));
  } else {
    if (categories && categories.length > 0) {
      const catSet = new Set(categories);
      filtered = filtered.filter((p) => catSet.has(p.category));
    }
    if (pilot) {
      filtered = filtered.filter((p) => p.pilot === true);
    }
  }
  return filtered;
}

export function addCustomPrompt(promptEntry) {
  mkdirSync(CUSTOM_PROMPTS_DIR, { recursive: true });
  const safeId = String(promptEntry.id || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');
  if (!safeId) throw new Error('Prompt id is required');
  const outPath = join(CUSTOM_PROMPTS_DIR, `${safeId}.json`);
  writeFileSync(outPath, JSON.stringify({ ...promptEntry, id: safeId }, null, 2) + '\n', 'utf8');
  return outPath;
}
