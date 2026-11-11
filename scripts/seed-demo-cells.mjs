#!/usr/bin/env node
/**
 * Writes synthetic cells into runs/cells/ so the report can be developed and tested without spending model
 * budget. Every cell is marked `demo: true` and the report shows a "demo data" banner when any such cell is
 * present. Never publish a report built from these.
 *
 *   node scripts/seed-demo-cells.mjs            # 4 models x 3 tracks x 6 prompts
 *   node scripts/seed-demo-cells.mjs --clean    # remove demo cells only
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/util/env.mjs';
import { loadPromptRegistry } from '../src/registry/prompts.mjs';
import { loadModelRegistryConfig } from '../src/harness/model-registry.mjs';
import { buildCellId } from '../src/harness/generate.mjs';
import { getHarnessSpec, getTrackForCell } from '../src/harness/harness-registry.mjs';
import { evaluateCsp, evaluateHeaders, evaluateCookies, evaluateCors, scoreSecurityChecks, SEVERITY_WEIGHT } from '../src/benchmarks/security.bench.mjs';

const CELLS_ROOT = join(PROJECT_ROOT, 'runs', 'cells');

function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANES = [
  { model: 'claude-sonnet-5-5', harness: 'claude-acp', skill: 0.82 },
  { model: 'gpt-6-1-sol', harness: 'codex-acp', skill: 0.78 },
  { model: 'gemini-3-8-flash', harness: 'gemini-acp', skill: 0.66 },
  { model: 'kimi-k3', harness: 'kimi-acp', skill: 0.6 },
];
const TRACK_SHIFT = { 'direct-oneshot': -0.1, 'direct-agent': 0, harness: 0.06 };

const LH_AUDITS = [
  ['performance', 'largest-contentful-paint', 'Largest Contentful Paint'], ['performance', 'total-blocking-time', 'Total Blocking Time'], ['performance', 'cumulative-layout-shift', 'Cumulative Layout Shift'], ['performance', 'unused-javascript', 'Reduce unused JavaScript'], ['performance', 'render-blocking-resources', 'Eliminate render-blocking resources'], ['performance', 'uses-responsive-images', 'Properly size images'],
  ['accessibility', 'color-contrast', 'Background and foreground colors have a sufficient contrast ratio'], ['accessibility', 'image-alt', 'Image elements have [alt] attributes'], ['accessibility', 'label', 'Form elements have associated labels'], ['accessibility', 'button-name', 'Buttons have an accessible name'], ['accessibility', 'heading-order', 'Heading elements appear in a sequentially-descending order'], ['accessibility', 'html-has-lang', '<html> element has a [lang] attribute'],
  ['best-practices', 'errors-in-console', 'No browser errors logged to the console'], ['best-practices', 'csp-xss', 'Ensure CSP is effective against XSS attacks'], ['best-practices', 'image-aspect-ratio', 'Displays images with correct aspect ratio'], ['best-practices', 'doctype', 'Page has the HTML doctype'],
  ['seo', 'meta-description', 'Document has a meta description'], ['seo', 'document-title', 'Document has a <title> element'], ['seo', 'link-text', 'Links have descriptive text'], ['seo', 'crawlable-anchors', 'Links are crawlable'],
];

function makeCell({ lane, trackKind, prompt, modelEntry }) {
  const harness = trackKind === 'harness' ? lane.harness : 'pi';
  const mode = trackKind === 'direct-oneshot' ? 'oneshot' : 'agent';
  const cellId = buildCellId(lane.model, prompt.id, mode, 'freeform', harness);
  const r = rng(cellId);
  const q = Math.max(0.05, Math.min(0.98, lane.skill + TRACK_SHIFT[trackKind] + (r() - 0.5) * 0.25));
  const ok = (bias = 0) => r() < q + bias;
  const around = (lo, hi) => Math.round(hi - (hi - lo) * q + (r() - 0.5) * (hi - lo) * 0.3);
  const ownsServer = mode === 'agent' && r() < 0.55;
  const cellDir = join(CELLS_ROOT, cellId);
  rmSync(cellDir, { recursive: true, force: true });
  mkdirSync(join(cellDir, 'results'), { recursive: true });
  const w = (name, obj) => writeFileSync(join(cellDir, name), JSON.stringify(obj, null, 2) + '\n');
  const failedBuild = r() < 0.04;
  const now = new Date().toISOString();

  w('generation.json', {
    demo: true, modelKey: lane.model, modelLabel: modelEntry?.label || lane.model, family: modelEntry?.family || 'Other', promptId: prompt.id, category: prompt.category,
    mode, spec: 'freeform', harness, harnessLabel: getHarnessSpec(harness)?.label || harness, track: getTrackForCell(harness, mode),
    harnessVersion: harness === 'pi' ? '0.85.1' : getHarnessSpec(harness)?.version || null, provider: 'demo', modelId: lane.model,
    startedAt: now, completedAt: now, durationMs: around(40000, 420000), costUsd: Math.round((0.02 + r() * 0.6) * 100) / 100, outputChars: around(9000, 60000), exitCode: 0,
    systemPromptSource: harness === 'pi' ? 'pi default (captured)' : 'harness-native', error: failedBuild ? 'Demo: build failed' : null,
  });
  w('materialization.json', { ok: !failedBuild, serverArchitecture: failedBuild ? 'failed' : ownsServer ? 'production-server' : 'static-harness', outputShape: ownsServer ? 'fullstack-workspace' : 'static-site' });
  if (failedBuild) return cellId;

  const steps = (prompt.canonicalJourney || []).map((s, i) => {
    const succeeded = ok(0.12);
    return { stepId: s.id || `s${i + 1}`, label: s.label || s.action || `Step ${i + 1}`, action: s.action, succeeded, mutated: succeeded && ok(0.1) };
  });
  const done = steps.filter((s) => s.succeeded).length;
  const mut = steps.filter((s) => s.mutated).length;
  w('compiled-flow.json', { flowCompletionPct: steps.length ? Math.round(((done * 0.5 + mut * 0.5) / steps.length) * 100) : 50, steps });

  w('results/tech-stack.json', { benchmarkId: 'tech-stack', primaryFramework: r() < q * 0.5 ? 'react' : 'vanilla', primaryBackend: ownsServer ? 'express' : 'static-only', staticAnalysis: { modernWebFeatures: {}, modernWebAdoptionCount: around(0, 9) }, runtime: {} });

  const js = (n) => Math.max(20, Math.min(100, Math.round(q * 100 + (r() - 0.5) * n)));
  const gate = r() < 0.94;
  w('results/prompt-judge.json', { benchmarkId: 'prompt-judge', passedGate: gate, failureCategory: gate ? null : 'stub-or-placeholder', overall: js(20), evaluationMode: 'deterministic', scores: { onTopic: js(14), featureCoverage: js(30), functionalReadiness: js(34), visualCoherence: js(24) }, verifiedFeatures: [], missingRequirements: ok(0.1) ? [] : ['Persist data between visits'], rationale: 'Demo data.' });

  const counts = { pageExceptionCount: ok(0.15) ? 0 : 1, consoleErrorCount: ok(0.1) ? 0 : 1 + Math.floor(r() * 3), consoleWarningCount: Math.floor(r() * 3), browserLogErrorCount: ok(0.2) ? 0 : 1, httpErrorCount: 0, criticalHttpErrorCount: ok(0.2) ? 0 : 1, nonCriticalHttpErrorCount: 0, favicon404Count: ok() ? 0 : 1, failedRequestCount: 0, loadErrorCount: 0, journeyErrorCount: ok(0.2) ? 0 : 1 };
  w('results/console-errors.json', { benchmarkId: 'console-errors', counts, pageExceptions: counts.pageExceptionCount ? [{ text: "TypeError: Cannot read properties of null (reading 'addEventListener')" }] : [], consoleErrors: [], httpErrors: [], failedRequests: [], browserLogErrors: [] });

  const failing = [];
  const passed = [];
  for (const [category, id, title] of LH_AUDITS) {
    const pass = ok(category === 'seo' ? 0.2 : category === 'performance' ? -0.1 : 0.05);
    (pass ? passed : failing).push({ id, title, category, categories: [category], score: pass ? 100 : Math.round(r() * 80), displayValue: null });
  }
  const catScore = (cat) => { const all = LH_AUDITS.filter((a) => a[0] === cat).length; const p = passed.filter((a) => a.category === cat).length; return Math.round((p / all) * 100); };
  const mobile = { formFactor: 'mobile', scores: { performance: catScore('performance'), accessibility: catScore('accessibility'), bestPractices: catScore('best-practices'), seo: catScore('seo') }, metrics: { fcpMs: around(700, 2600), lcpMs: around(1100, 5200), tbtMs: around(20, 900), cls: Math.round(r() * (1 - q) * 300) / 1000, speedIndexMs: around(900, 4800), interactiveMs: around(1200, 6000) }, auditCounts: { passed: passed.length, failed: failing.length, notApplicable: 0 }, failingAudits: failing, passedAudits: passed };
  const lhComposite = Math.round(mobile.scores.performance * 0.4 + mobile.scores.accessibility * 0.25 + mobile.scores.bestPractices * 0.2 + mobile.scores.seo * 0.15);
  const outcomes = { fast: js(30), inclusive: js(26), discoverable: js(24), trust: js(34), resilient: js(30), modern: js(40) };
  w('results/lighthouse-uplift.json', { benchmarkId: 'lighthouse-uplift', lighthouse: { compositeScore: lhComposite, mobile, desktop: mobile }, uplift: { evaluationMode: 'evidence-primitives', mwgVersion: '0.0.197', overall: Math.round(Object.values(outcomes).reduce((a, b) => a + b, 0) / 6), outcomes, axeViolationCount: ok(0.05) ? 0 : 1 + Math.floor(r() * 4), undersizedTargetCount: ok() ? 0 : Math.floor(r() * 6), discoverabilityMeta: { isJsShell: !ok(0.25) }, primitiveHighlights: { imageHygiene: { totalImages: 8, missingDimensions: ok() ? 0 : 3, notLazyBelowFold: ok() ? 0 : 4, oversized: ok(0.1) ? 0 : 1 }, liveCssomFeatures: ok() ? ['container-queries', ':has()'] : [], securityAndSecrets: { presentValidHeaders: [], criticalOrHighSecrets: 0 } } } });

  w('results/deep-perf.json', { benchmarkId: 'deep-perf', serverTelemetry: { serverArchitecture: ownsServer ? 'production-server' : 'static-harness', singleTtfbMs: around(4, 180), burstP95TtfbMs: around(8, 520), idleServerRssMb: ownsServer ? around(45, 160) : 0, loadServerRssMb: ownsServer ? around(50, 190) : 0, securityHeaders: [] }, desktopLoad: {}, mobileLoad: { vitals: { lcpMs: mobile.metrics.lcpMs, tbtMs: mobile.metrics.tbtMs, cls: mobile.metrics.cls }, coverage: { unusedJsPct: around(4, 70) }, network: { apiWaterfallCount: Math.floor(r() * 4), brokenCriticalSubresourceCount: ok(0.25) ? 0 : 1 } }, journey: { inpMs: around(30, 520), clsInteractive: 0, loafCount: Math.floor(r() * 5), interactionCount: steps.length, framePacing: { droppedFramePct: around(0, 30), avgFps: around(60, 38) } } });

  const leak = !ok(0.2);
  w('results/memory.json', { benchmarkId: 'memory', idleDrift: { t0s: { jsHeapUsedBytes: around(3, 46) * 1048576 }, suspectedRunawayLoop: !ok(0.35) && r() < 0.2 }, interactionLeakTest: { heapGrowthAfterCyclesBytes: leak ? around(1, 9) * 1048576 : 180000, listenerDelta: leak ? around(4, 40) : 0, snapshotDiff: { detachedDomDelta: leak ? Math.floor(r() * 12) : 0 }, memlab: { leakClusterCount: leak && r() < 0.5 ? 1 : 0 } } });

  // Security: real evaluators over synthetic inputs, so demo rows have the same shape as real ones.
  const headers = {};
  if (ownsServer) {
    if (!ok(-0.3)) headers['x-powered-by'] = 'Express';
    if (ok(-0.25)) headers['x-content-type-options'] = 'nosniff';
    if (ok(-0.35)) headers['x-frame-options'] = 'DENY';
    if (ok(-0.45)) headers['referrer-policy'] = 'strict-origin-when-cross-origin';
    if (ok(-0.55)) headers['content-security-policy'] = ok(-0.2) ? "default-src 'self'; object-src 'none'; base-uri 'self'" : "default-src 'self' 'unsafe-inline' https:";
  }
  const mk = (id, group, title, severity, pass, detail, extra = {}) => ({ id, group, title, severity, weight: SEVERITY_WEIGHT[severity], status: pass === null ? 'na' : pass ? 'pass' : 'fail', detail, confidence: extra.confidence || 'measured', evidence: extra.evidence || [] });
  const checks = [
    ...evaluateCsp({ headerValue: headers['content-security-policy'] || null }),
    ...evaluateHeaders(headers, { ownsServer }),
    ...evaluateCookies(ownsServer && r() < 0.5 ? [ok(-0.2) ? 'sid=x; HttpOnly; SameSite=Lax' : 'sid=x; Path=/'] : []),
    ...evaluateCors(ownsServer ? [{ path: '/', headers: {} }] : []),
    mk('no-unescaped-html-sinks', 'client', 'Does not build HTML from unescaped data', 'high', ok(-0.15), 'Demo data.', { confidence: 'heuristic', evidence: ['app.js: 2 dynamic HTML write(s), no escaping helper in the file'] }),
    mk('no-eval', 'client', 'Does not evaluate strings as code', 'medium', ok(0.3), 'Demo data.'),
    mk('no-inline-event-handlers', 'client', 'No inline event handler attributes', 'low', ok(0.05), 'Demo data.'),
    mk('third-party-sri', 'client', 'Third-party scripts and styles are integrity-checked', 'medium', ok(-0.1), 'Demo data.'),
    mk('no-insecure-urls', 'client', 'No plain-http resources or form targets', 'medium', ok(0.3), 'Demo data.'),
    mk('no-secrets-in-client-files', 'secrets', 'No credentials in files sent to the browser', 'critical', r() < 0.97, 'Demo data.'),
    mk('no-hardcoded-secrets', 'secrets', 'No credentials hard-coded in server source', 'high', ownsServer ? ok(0.1) : null, 'Demo data.'),
    mk('no-sensitive-files-served', 'secrets', 'Does not serve private files', 'critical', r() < 0.96, 'Demo data.'),
    mk('no-manifest-served', 'secrets', 'Does not serve its package manifest', 'low', ok(0.2), 'Demo data.'),
    mk('no-known-vulnerable-dependencies', 'dependencies', 'No dependencies with known advisories', 'high', ok(0.1), 'Demo data.'),
    mk('dependencies-locked', 'dependencies', 'Dependency versions are locked', 'low', ownsServer ? ok(0.1) : null, 'Demo data.'),
    mk('no-sql-string-building', 'server', 'Database queries use parameters', 'high', ownsServer ? ok(0.1) : null, 'Demo data.', { confidence: 'heuristic' }),
    mk('password-hashing', 'server', 'Passwords are hashed with a slow algorithm', 'critical', ownsServer && r() < 0.4 ? ok(0.1) : null, 'Demo data.', { confidence: 'heuristic' }),
    mk('no-shell-injection', 'server', 'Request data is never passed to a shell', 'high', ownsServer ? r() < 0.97 : null, 'Demo data.', { confidence: 'heuristic' }),
    mk('no-stack-traces-to-client', 'server', 'Errors do not leak stack traces', 'low', ownsServer ? ok(0.1) : null, 'Demo data.', { confidence: 'heuristic' }),
  ];
  const scored = scoreSecurityChecks(checks);
  w('results/security.json', { benchmarkId: 'security', version: 'demo', score: scored.overall, ...scored, scope: { ownsServer, demo: true }, checks });
  return cellId;
}

function cleanDemoCells() {
  if (!existsSync(CELLS_ROOT)) return 0;
  let n = 0;
  for (const d of readdirSync(CELLS_ROOT)) {
    try {
      if (JSON.parse(readFileSync(join(CELLS_ROOT, d, 'generation.json'), 'utf8')).demo === true) {
        rmSync(join(CELLS_ROOT, d), { recursive: true, force: true });
        n++;
      }
    } catch {
      // not a cell
    }
  }
  return n;
}

const removed = cleanDemoCells();
if (process.argv.includes('--clean')) {
  console.log(`[demo] Removed ${removed} demo cell(s).`);
} else {
  const prompts = loadPromptRegistry().prompts.filter((p) => p.pilot).slice(0, 6);
  const models = loadModelRegistryConfig().models;
  let n = 0;
  for (const lane of LANES) {
    const modelEntry = models.find((m) => m.key === lane.model);
    for (const trackKind of ['direct-oneshot', 'direct-agent', 'harness']) {
      for (const prompt of prompts) {
        makeCell({ lane, trackKind, prompt, modelEntry });
        n++;
      }
    }
  }
  console.log(`[demo] Wrote ${n} demo cells to runs/cells/. They are marked demo:true; do not publish them.`);
}
