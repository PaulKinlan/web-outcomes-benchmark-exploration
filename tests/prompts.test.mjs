import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPromptRegistry, selectPrompts } from '../src/registry/prompts.mjs';
import {
  validatePromptRegistry,
  validateSinglePrompt,
  BANNED_STEERING_PATTERNS,
} from '../src/registry/validate-prompts.mjs';
import { loadBenchmarkConfig } from '../src/util/env.mjs';

test('prompt registry passes zero-bias validation across all 10 categories', () => {
  const registry = loadPromptRegistry();
  const report = validatePromptRegistry(registry);

  assert.equal(report.valid, true, `Validation errors:\n${report.errors.join('\n')}`);
  assert.equal(report.categoryCount, 10);
  assert.ok(report.promptCount >= 35, `Expected >= 35 prompts, got ${report.promptCount}`);
  assert.equal(report.pilotCount, 10, 'Expected 1 pilot prompt per category (10 total)');

  const categoryIds = new Set(registry.categories.map((c) => c.id));
  for (const requiredCat of [
    'portfolio',
    'blog',
    'educational-course',
    'booking-scheduling',
    'membership-community',
    'directory-listing',
    'ecommerce-retail',
    'saas-business',
    'productivity-apps',
    'games-creative',
  ]) {
    assert.ok(categoryIds.has(requiredCat), `Missing required category: ${requiredCat}`);
    const inCat = selectPrompts({ categories: [requiredCat] });
    assert.ok(inCat.length >= 3, `Expected >= 3 prompts in ${requiredCat}, got ${inCat.length}`);
  }
});

test('validateSinglePrompt rejects speed, benchmark, memory, and framework steering words', () => {
  const baseValid = {
    id: 'sample-site',
    category: 'portfolio',
    title: 'Sample Site',
    prompt: 'Create a photography portfolio website with gallery filtering, a lightbox viewer, and an inquiry form.',
    canonicalJourney: [
      { id: 's1', label: 'Filter', action: 'click', patterns: ['portrait'] },
      { id: 's2', label: 'Open', action: 'click', patterns: ['view'] },
      { id: 's3', label: 'Inquire', action: 'click', patterns: ['contact'] },
    ],
    leakLoop: { doPatterns: ['view'], undoPatterns: ['close'] },
  };

  assert.deepEqual(validateSinglePrompt(baseValid), []);

  const biasedSamples = [
    'Create a fast homepage for my coffee shop.',
    'Build an ecommerce store optimized for Lighthouse and Core Web Vitals.',
    'Create a portfolio website using React and Tailwind CSS.',
    'Build a booking page in vanilla JS with zero dependencies and no memory leaks.',
    'Create a single-file index.html voxel game with Three.js.',
  ];

  for (const badPrompt of biasedSamples) {
    const errs = validateSinglePrompt({ ...baseValid, prompt: badPrompt });
    assert.ok(errs.length > 0, `Expected steering rejection for: "${badPrompt}"`);
  }

  // Explicit control experiments are allowed only when allowSteeringControl === true
  const explicitControl = validateSinglePrompt({
    ...baseValid,
    allowSteeringControl: true,
    prompt: 'Create a fast coffee shop homepage using vanilla JS.',
  });
  assert.deepEqual(explicitControl, []);
});

test('benchmark.json agentWorkspaceContract and neutralSystemPrompt contain zero stack or speed bias', () => {
  const cfg = loadBenchmarkConfig();
  const texts = [
    ['agentWorkspaceContract', cfg.generation?.agentWorkspaceContract || ''],
    ['neutralSystemPrompt', cfg.generation?.neutralSystemPrompt || ''],
  ];

  for (const [name, text] of texts) {
    assert.ok(text.length > 30, `Expected non-empty ${name}`);
    for (const rule of BANNED_STEERING_PATTERNS) {
      assert.equal(
        rule.pattern.test(text),
        false,
        `${name} violated zero-bias neutrality (${rule.reason}): "${text}"`
      );
    }
  }
});
