/**
 * Flattens every pillar's result into individual tests, so the report can show one test on its own, filter and
 * group tests, and roll them up per group and per pillar (for example Modern Web Guidance as a whole).
 *
 * A test row: { pillar, group, id, title, status: 'pass' | 'fail' | 'na', score (0-100 or null), value, detail,
 * evidence[], ref }. `id` is stable across cells so the same test can be compared between models and tracks.
 */

export const PILLARS = [
  { id: 'judge', label: 'Brief coverage', weightKey: 'judge', blurb: 'Did the site build what the prompt asked for? Judged against the prompt, then used as a gate: off-topic or stub builds score zero overall.' },
  { id: 'lighthouse', label: 'Lighthouse', weightKey: 'lighthouse', blurb: 'Every Lighthouse audit on a throttled mobile profile: performance, accessibility, best practices and SEO.' },
  { id: 'uplift', label: 'Modern Web Guidance', weightKey: 'uplift', blurb: 'web-uplift outcomes measured from browser evidence against Modern Web Guidance.' },
  { id: 'deepPerf', label: 'Deep performance', weightKey: 'deepPerf', blurb: 'Core Web Vitals measured during a real user journey: LCP, INP, blocking time, layout shift and server response.' },
  { id: 'security', label: 'Security', weightKey: 'security', blurb: 'What the site ships by default: headers and CSP, cookies, client and server code, secrets, exposed files and dependency advisories. Then how the running server copes with hostile input: script payloads, broken SQL, path traversal, forged cross-site posts and malformed requests.' },
  { id: 'functionalFlow', label: 'User journey', weightKey: 'functionalFlow', blurb: 'Each step of the prompt\'s canonical user journey, replayed in a browser.' },
  { id: 'consoleErrors', label: 'Runtime errors', weightKey: 'consoleErrors', blurb: 'JavaScript exceptions, console errors and failed requests during load and the journey.' },
  { id: 'memory', label: 'Memory', weightKey: 'memory', blurb: 'Heap size, leaks and detached DOM after repeating the journey.' },
];

const row = (pillar, group, id, title, status, extra = {}) => ({
  pillar,
  group,
  id: `${pillar}:${id}`,
  title,
  status,
  score: extra.score ?? (status === 'pass' ? 100 : status === 'fail' ? 0 : null),
  value: extra.value ?? null,
  detail: extra.detail ?? null,
  evidence: (extra.evidence || []).slice(0, 4),
  ...(extra.severity ? { severity: extra.severity } : {}),
  ...(extra.confidence && extra.confidence !== 'measured' ? { confidence: extra.confidence } : {}),
  ...(extra.ref ? { ref: extra.ref } : {}),
});

const graded = (score, passAt) => (typeof score !== 'number' ? 'na' : score >= passAt ? 'pass' : 'fail');
const ms = (v) => (typeof v === 'number' ? (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`) : null);

const LH_CATEGORY_LABEL = { performance: 'Performance', accessibility: 'Accessibility', 'best-practices': 'Best practices', seo: 'SEO' };
const UPLIFT_LABEL = { fast: 'Fast', inclusive: 'Inclusive', discoverable: 'Discoverable', trust: 'Trustworthy', resilient: 'Resilient', modern: 'Modern platform use', memory: 'Memory' };

export function flattenCellTests({ rawBenchmarks = {}, pillarScores = {}, compiledFlow = null } = {}) {
  const out = [];

  // --- Brief coverage (judge) ---
  const pj = rawBenchmarks['prompt-judge'];
  if (pj) {
    out.push(row('judge', 'Gate', 'gate', 'On topic and not a stub', pj.passedGate ? 'pass' : 'fail', { detail: pj.failureCategory ? `Failed gate: ${pj.failureCategory}.` : pj.rationale ? String(pj.rationale).slice(0, 240) : null }));
    for (const [key, title] of [['onTopic', 'Matches the brief'], ['featureCoverage', 'Covers the requested features'], ['functionalReadiness', 'Features actually work'], ['visualCoherence', 'Visually coherent'], ['guidedFidelity', 'Follows the supplied design']]) {
      const s = pj.scores?.[key];
      if (typeof s === 'number') out.push(row('judge', 'Criteria', key, title, graded(s, 60), { score: Math.round(s), value: `${Math.round(s)}/100` }));
    }
    for (const req of (pj.missingRequirements || []).slice(0, 12)) {
      out.push(row('judge', 'Missing requirements', `missing:${String(req).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`, String(req).slice(0, 120), 'fail'));
    }
  }

  // --- Lighthouse: one row per audit ---
  const lhMobile = rawBenchmarks['lighthouse-uplift']?.lighthouse?.mobile;
  if (lhMobile) {
    for (const [list, status] of [[lhMobile.failingAudits || [], 'fail'], [lhMobile.passedAudits || [], 'pass']]) {
      for (const a of list) {
        out.push(row('lighthouse', LH_CATEGORY_LABEL[a.category] || a.category || 'Other', a.id, a.title, status, {
          score: a.score,
          value: a.displayValue,
          detail: a.description ? String(a.description).slice(0, 220) : null,
          evidence: (a.items || []).slice(0, 4).map((it) => it.url || it.selector || it.snippet || JSON.stringify(it).slice(0, 120)),
          ref: a.helpUrl,
        }));
      }
    }
  }

  // --- Modern Web Guidance (web-uplift) ---
  const up = rawBenchmarks['lighthouse-uplift']?.uplift;
  if (up) {
    for (const [key, s] of Object.entries(up.outcomes || {})) {
      if (key === 'memory') continue; // measured properly by the memory pillar
      out.push(row('uplift', 'Outcomes', key, UPLIFT_LABEL[key] || key, graded(s, 75), { score: Math.round(s), value: `${Math.round(s)}/100` }));
    }
    const h = up.primitiveHighlights || {};
    if (typeof up.axeViolationCount === 'number') out.push(row('uplift', 'Accessibility evidence', 'axe-violations', 'No axe accessibility violations', up.axeViolationCount === 0 ? 'pass' : 'fail', { value: `${up.axeViolationCount} violation(s)` }));
    if (typeof up.undersizedTargetCount === 'number') out.push(row('uplift', 'Accessibility evidence', 'tap-targets', 'Tap targets are large enough', up.undersizedTargetCount === 0 ? 'pass' : 'fail', { value: `${up.undersizedTargetCount} undersized` }));
    if (h.imageHygiene && h.imageHygiene.totalImages > 0) {
      const ih = h.imageHygiene;
      out.push(row('uplift', 'Images', 'image-dimensions', 'Images declare width and height', ih.missingDimensions ? 'fail' : 'pass', { value: `${ih.missingDimensions} of ${ih.totalImages} missing` }));
      out.push(row('uplift', 'Images', 'image-lazy', 'Below-the-fold images load lazily', ih.notLazyBelowFold ? 'fail' : 'pass', { value: `${ih.notLazyBelowFold} eager` }));
      out.push(row('uplift', 'Images', 'image-sized', 'Images are not oversized', ih.oversized ? 'fail' : 'pass', { value: `${ih.oversized} oversized` }));
    }
    if (up.discoverabilityMeta) out.push(row('uplift', 'Discoverability', 'not-js-shell', 'Content is in the HTML, not only rendered by JavaScript', up.discoverabilityMeta.isJsShell ? 'fail' : 'pass'));
    if (Array.isArray(h.liveCssomFeatures)) out.push(row('uplift', 'Modern platform', 'modern-css', 'Uses modern CSS features', h.liveCssomFeatures.length > 0 ? 'pass' : 'fail', { value: `${h.liveCssomFeatures.length} feature(s)`, evidence: h.liveCssomFeatures.slice(0, 4).map(String) }));
  }

  // --- Deep performance ---
  const dp = pillarScores['deep-perf'];
  if (rawBenchmarks['deep-perf'] && dp?.subscores) {
    const hd = dp.headline || {};
    const rd = rawBenchmarks['deep-perf'];
    const cls = (rd.mobileLoad?.vitals?.cls || 0) + (rd.journey?.clsInteractive || 0);
    for (const [key, title, value, group] of [
      ['lcpScore', 'Largest Contentful Paint (mobile)', ms(hd.mobileLcpMs), 'Core Web Vitals'],
      ['inpScore', 'Interaction to Next Paint (journey)', ms(hd.inpMs), 'Core Web Vitals'],
      ['clsScore', 'Cumulative Layout Shift (load + journey)', cls.toFixed(3), 'Core Web Vitals'],
      ['tbtScore', 'Total Blocking Time (mobile)', ms(hd.mobileTbtMs), 'Responsiveness'],
      ['serverTtfbScore', 'Server response under 10 concurrent requests (p95)', ms(hd.burstP95TtfbMs), 'Server'],
      ['efficiencyScore', 'Code efficiency: unused JS, dropped frames, request waterfalls', `${Math.round(hd.unusedJsPct || 0)}% unused JS`, 'Efficiency'],
    ]) {
      const s = dp.subscores[key];
      out.push(row('deepPerf', group, key.replace(/Score$/, ''), title, graded(s, 75), { score: typeof s === 'number' ? Math.round(s) : null, value }));
    }
    const broken = rd.mobileLoad?.network?.brokenCriticalSubresourceCount || 0;
    out.push(row('deepPerf', 'Efficiency', 'no-broken-assets', 'No broken scripts, styles or images', broken ? 'fail' : 'pass', { value: `${broken} broken` }));
  }

  // --- Security ---
  for (const c of rawBenchmarks.security?.checks || []) {
    const groupLabel = { headers: 'Response headers & CSP', cookies: 'Cookies & cross-origin access', client: 'Client-side code', secrets: 'Secrets & exposed files', dependencies: 'Dependencies', server: 'Server-side code' }[c.group] || c.group;
    out.push(row('security', groupLabel, c.id, c.title, c.status, { detail: c.detail, evidence: c.evidence, severity: c.severity, confidence: c.confidence, ref: c.ref }));
  }

  // --- User journey ---
  for (const [i, s] of (compiledFlow?.steps || []).entries()) {
    out.push(row('functionalFlow', 'Journey steps', `step-${i + 1}`, `Step ${i + 1}: ${s.label || s.action || s.stepId}`, s.succeeded ? 'pass' : 'fail', {
      score: s.succeeded ? (s.mutated ? 100 : 50) : 0,
      detail: s.error ? s.error : s.succeeded && !s.mutated ? 'The control was found, but using it changed nothing on the page.' : null,
    }));
  }

  // --- Runtime errors ---
  const ce = rawBenchmarks['console-errors'];
  if (ce?.counts) {
    const c = ce.counts;
    const sample = (arr) => (arr || []).slice(0, 3).map((e) => String(e.text || e.message || e.url || e.description || JSON.stringify(e)).slice(0, 160));
    for (const [key, title, group, ev] of [
      ['pageExceptionCount', 'No uncaught JavaScript exceptions', 'JavaScript', sample(ce.pageExceptions)],
      ['consoleErrorCount', 'No console errors', 'JavaScript', sample(ce.consoleErrors)],
      ['criticalHttpErrorCount', 'No failed requests for pages, scripts, styles or APIs', 'Network', sample((ce.httpErrors || []).filter((e) => e.critical !== false))],
      ['nonCriticalHttpErrorCount', 'No other 4xx or 5xx responses', 'Network', []],
      ['failedRequestCount', 'No requests that failed to connect', 'Network', sample(ce.failedRequests)],
      ['browserLogErrorCount', 'No browser security, CORS or CSP errors', 'Browser', sample(ce.browserLogErrors)],
      ['journeyErrorCount', 'No new errors while using the site', 'Journey', []],
    ]) {
      if (typeof c[key] === 'number') out.push(row('consoleErrors', group, key.replace(/Count$/, ''), title, c[key] === 0 ? 'pass' : 'fail', { value: `${c[key]}`, evidence: ev }));
    }
  }

  // --- Memory ---
  const mem = pillarScores.memory?.headline;
  if (rawBenchmarks.memory && mem) {
    out.push(row('memory', 'Heap', 'baseline-heap', 'JavaScript heap stays under 30 MB at rest', mem.baselineHeapMb <= 30 ? 'pass' : 'fail', { value: `${mem.baselineHeapMb} MB` }));
    out.push(row('memory', 'Heap', 'no-runaway-allocation', 'No runaway allocation while idle', mem.suspectedRunawayLoop ? 'fail' : 'pass'));
    out.push(row('memory', 'Leaks', 'retained-growth', 'Heap does not grow after repeating the journey 10 times', mem.retainedGrowthKb <= 2048 ? 'pass' : 'fail', { value: `${mem.retainedGrowthKb} KB` }));
    out.push(row('memory', 'Leaks', 'detached-dom', 'No detached DOM nodes retained', mem.detachedDomDelta > 0 ? 'fail' : 'pass', { value: `${mem.detachedDomDelta}` }));
    out.push(row('memory', 'Leaks', 'listener-leak', 'Event listeners are cleaned up', mem.listenerLeakDelta >= 10 ? 'fail' : 'pass', { value: `${mem.listenerLeakDelta} added` }));
    out.push(row('memory', 'Leaks', 'memlab-leaks', 'No leak clusters found by MemLab', mem.memlabLeakClusters > 0 ? 'fail' : 'pass', { value: `${mem.memlabLeakClusters}` }));
  }

  return out;
}

/** Rolls tests up to pillar > group, counting only tests that applied. */
export function rollupTests(tests = []) {
  const pillars = new Map();
  for (const t of tests) {
    if (!pillars.has(t.pillar)) pillars.set(t.pillar, { pillar: t.pillar, passed: 0, failed: 0, notApplicable: 0, groups: new Map() });
    const p = pillars.get(t.pillar);
    if (!p.groups.has(t.group)) p.groups.set(t.group, { group: t.group, passed: 0, failed: 0, notApplicable: 0 });
    const g = p.groups.get(t.group);
    const key = t.status === 'pass' ? 'passed' : t.status === 'fail' ? 'failed' : 'notApplicable';
    p[key]++;
    g[key]++;
  }
  const pct = (x) => (x.passed + x.failed > 0 ? Math.round((x.passed / (x.passed + x.failed)) * 1000) / 10 : null);
  return [...pillars.values()].map((p) => ({
    pillar: p.pillar,
    passed: p.passed,
    failed: p.failed,
    notApplicable: p.notApplicable,
    passRatePct: pct(p),
    groups: [...p.groups.values()].map((g) => ({ ...g, passRatePct: pct(g) })),
  }));
}

/**
 * Builds the catalogue of distinct tests across all cells, with how often each passes. Cells keep a compact
 * `testResults` list of [catalogIndex, statusCode, score] so the summary stays small.
 */
export function buildTestCatalog(cellsWithTests = []) {
  const index = new Map();
  const catalog = [];
  const STATUS_CODE = { pass: 1, fail: 0, na: 2 };
  const compact = new Map();
  for (const { cellId, tests } of cellsWithTests) {
    const rows = [];
    for (const t of tests) {
      if (!index.has(t.id)) {
        index.set(t.id, catalog.length);
        catalog.push({ id: t.id, pillar: t.pillar, group: t.group, title: t.title, severity: t.severity || null, confidence: t.confidence || 'measured', ref: t.ref || null, passed: 0, failed: 0, notApplicable: 0 });
      }
      const i = index.get(t.id);
      catalog[i][t.status === 'pass' ? 'passed' : t.status === 'fail' ? 'failed' : 'notApplicable']++;
      rows.push([i, STATUS_CODE[t.status] ?? 2, t.score]);
    }
    compact.set(cellId, rows);
  }
  for (const c of catalog) c.passRatePct = c.passed + c.failed > 0 ? Math.round((c.passed / (c.passed + c.failed)) * 1000) / 10 : null;
  return { catalog, compact };
}
