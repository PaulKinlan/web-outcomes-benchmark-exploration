import { loadPromptRegistry } from './prompts.mjs';

// Words that steer either performance/quality qualities OR technology stack choices.
// Prompts must describe functional user needs only unless explicitly marked allowSteeringControl.
export const BANNED_STEERING_PATTERNS = [
  // Speed / Performance / Quality steering
  { pattern: /\bfast(er|est)?\b/i, reason: 'speed steering ("fast")' },
  { pattern: /\bspeedy?\b/i, reason: 'speed steering ("speed")' },
  { pattern: /\binstant(ly)?\b/i, reason: 'speed steering ("instant")' },
  { pattern: /\blightweight\b/i, reason: 'bundle/speed steering ("lightweight")' },
  { pattern: /\bperforman(t|ce)\b/i, reason: 'performance steering' },
  { pattern: /\blighthouse\b/i, reason: 'benchmark target leakage ("lighthouse")' },
  { pattern: /\bcore web vitals\b|\bcwv\b|\blcp\b|\binp\b|\bcls\b/i, reason: 'CWV metric leakage' },
  { pattern: /\baccessib(le|ility)\b|\ba11y\b|\baria\b|\bwcag\b/i, reason: 'accessibility steering' },
  { pattern: /\bseo\b/i, reason: 'SEO steering' },
  { pattern: /\bmemory leak\b|\blow memory\b|\bheap\b/i, reason: 'memory steering' },

  // Framework / Tech-stack steering
  { pattern: /\breact(\.js|js)?\b/i, reason: 'framework steering ("React")' },
  { pattern: /\bnext(\.js|js)\b/i, reason: 'framework steering ("Next.js")' },
  { pattern: /\bvue(\.js|js)?\b/i, reason: 'framework steering ("Vue")' },
  { pattern: /\bsvelte(kit)?\b/i, reason: 'framework steering ("Svelte")' },
  { pattern: /\bangular\b/i, reason: 'framework steering ("Angular")' },
  { pattern: /\bpreact\b|\bsolidjs\b|\balpine\.?js\b|\bhtmx\b|\bjquery\b/i, reason: 'framework steering' },
  { pattern: /\btailwind(css)?\b|\bbootstrap\b|\bshadcn\b|\bmaterial ui\b/i, reason: 'CSS library steering' },
  { pattern: /\bvanilla\s+(js|javascript|css|html)\b|\bno framework\b|\bzero dependencies\b/i, reason: 'vanilla stack steering' },
  { pattern: /\btypescript\b|\bjsx\b|\btsx\b|\bwebpack\b|\bvite\b/i, reason: 'build/language steering' },
  { pattern: /\bthree\.?js\b|\bwebgl\b|\bpixi\.?js\b|\bbabylon\.?js\b/i, reason: '3D engine steering' },
  { pattern: /\bsingle[- ]file\b|\bindex\.html\b/i, reason: 'file-structure steering' },
];

export function validateSinglePrompt(entry, knownCategories = null) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return ['Prompt entry must be an object'];
  }
  if (!entry.id || !/^[a-z0-9][a-z0-9-_]*$/.test(entry.id)) {
    errors.push(`Invalid prompt id "${entry.id}" (use lowercase alphanumeric/hyphens)`);
  }
  if (!entry.category || (knownCategories && !knownCategories.has(entry.category))) {
    errors.push(`Prompt "${entry.id}": unknown or missing category "${entry.category}"`);
  }
  if (!entry.title || typeof entry.title !== 'string') {
    errors.push(`Prompt "${entry.id}": missing title`);
  }
  if (!entry.prompt || typeof entry.prompt !== 'string' || entry.prompt.trim().length < 20) {
    errors.push(`Prompt "${entry.id}": prompt text must be at least 20 characters`);
  }

  if (!entry.allowSteeringControl && typeof entry.prompt === 'string') {
    for (const rule of BANNED_STEERING_PATTERNS) {
      if (rule.pattern.test(entry.prompt)) {
        errors.push(`Prompt "${entry.id}" violates zero-bias neutrality (${rule.reason}): "${entry.prompt}"`);
      }
    }
  }

  if (!Array.isArray(entry.canonicalJourney) || entry.canonicalJourney.length < 3) {
    errors.push(`Prompt "${entry.id}": canonicalJourney must contain at least 3 multi-flow steps`);
  } else {
    for (const step of entry.canonicalJourney) {
      if (!step.id || !step.action) {
        errors.push(`Prompt "${entry.id}": each canonicalJourney step requires id and action`);
      }
    }
  }

  if (!entry.leakLoop || typeof entry.leakLoop !== 'object') {
    errors.push(`Prompt "${entry.id}": missing leakLoop definition for memory leak testing`);
  }

  if (entry.referenceImages !== undefined) {
    if (!Array.isArray(entry.referenceImages)) {
      errors.push(`Prompt "${entry.id}": referenceImages must be an array when provided`);
    } else {
      for (const img of entry.referenceImages) {
        if (!img || typeof img.path !== 'string' || !img.path.trim() || img.path.includes('..')) {
          errors.push(`Prompt "${entry.id}": each referenceImage requires a safe relative path`);
        }
        if (!entry.allowSteeringControl && typeof img?.label === 'string') {
          for (const rule of BANNED_STEERING_PATTERNS) {
            if (rule.pattern.test(img.label)) {
              errors.push(`Prompt "${entry.id}": referenceImage label violates zero-bias (${rule.reason})`);
            }
          }
        }
      }
    }
  }

  return errors;
}

export function validatePromptRegistry(registry = loadPromptRegistry()) {
  const errors = [];
  const categoryIds = new Set((registry.categories || []).map((c) => c.id));
  if (categoryIds.size < 6) {
    errors.push(`Expected at least 6 website categories, found ${categoryIds.size}`);
  }

  const seenIds = new Set();
  for (const p of registry.prompts || []) {
    if (seenIds.has(p.id)) {
      errors.push(`Duplicate prompt id "${p.id}"`);
    }
    seenIds.add(p.id);
    errors.push(...validateSinglePrompt(p, categoryIds));
  }

  return {
    valid: errors.length === 0,
    categoryCount: categoryIds.size,
    promptCount: (registry.prompts || []).length,
    pilotCount: (registry.prompts || []).filter((p) => p.pilot).length,
    errors,
  };
}
