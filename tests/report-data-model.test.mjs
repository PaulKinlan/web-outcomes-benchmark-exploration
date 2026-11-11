import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flattenCellTests, rollupTests, buildTestCatalog, PILLARS } from '../src/scoring/test-catalog.mjs';
import { buildReportData, describeRun } from '../src/scoring/report-data.mjs';
import { avg, trackKind, passRate, heatClass, cellTestRows, esc, fmt } from '../src/ui/report/report-lib.js';
import { loadBenchmarkConfig, PROJECT_ROOT } from '../src/util/env.mjs';

const raw = {
  'prompt-judge': { passedGate: true, scores: { onTopic: 90, featureCoverage: 40 }, missingRequirements: ['Save bookings'] },
  'lighthouse-uplift': {
    lighthouse: { mobile: { failingAudits: [{ id: 'color-contrast', title: 'Contrast', category: 'accessibility', score: 0, items: [{ selector: 'p.muted' }] }], passedAudits: [{ id: 'document-title', title: 'Has a title', category: 'seo', score: 100 }] } },
    uplift: { outcomes: { inclusive: 80, trust: 50, memory: 85 }, axeViolationCount: 2, undersizedTargetCount: 0 },
  },
  security: { checks: [{ id: 'csp-present', group: 'headers', title: 'Has a CSP', severity: 'high', status: 'fail', detail: 'None.', evidence: [] }, { id: 'nosniff', group: 'headers', title: 'nosniff', severity: 'medium', status: 'na', detail: 'Static.' }, { id: 'no-sql-string-building', group: 'server', title: 'SQL', severity: 'high', status: 'pass', detail: 'ok', confidence: 'heuristic' }] },
  'console-errors': { counts: { pageExceptionCount: 1, consoleErrorCount: 0 }, pageExceptions: [{ text: 'TypeError: x is null' }] },
};
const flow = { steps: [{ label: 'Open booking form', succeeded: true, mutated: true }, { label: 'Submit', succeeded: false, error: 'No submit control found' }] };

describe('Per-test data model', () => {
  const tests = flattenCellTests({ rawBenchmarks: raw, pillarScores: {}, compiledFlow: flow });
  const get = (id) => tests.find((t) => t.id === id);

  it('turns every pillar result into individually addressable tests', () => {
    assert.equal(get('lighthouse:color-contrast').status, 'fail');
    assert.equal(get('lighthouse:color-contrast').group, 'Accessibility');
    assert.deepEqual(get('lighthouse:color-contrast').evidence, ['p.muted']);
    assert.equal(get('lighthouse:document-title').status, 'pass');
    assert.equal(get('uplift:inclusive').status, 'pass');
    assert.equal(get('uplift:trust').status, 'fail');
    assert.equal(get('uplift:memory'), undefined);
    assert.equal(get('uplift:axe-violations').status, 'fail');
    assert.equal(get('judge:featureCoverage').status, 'fail');
    assert.ok(get('judge:missing:save-bookings'));
    assert.equal(get('security:nosniff').status, 'na');
    assert.equal(get('security:no-sql-string-building').confidence, 'heuristic');
    assert.equal(get('functionalFlow:step-2').detail, 'No submit control found');
    assert.deepEqual(get('consoleErrors:pageException').evidence, ['TypeError: x is null']);
    assert.ok(tests.every((t) => PILLARS.some((p) => p.id === t.pillar) && t.id.startsWith(`${t.pillar}:`) && t.title && t.group));
  });

  it('rolls tests up by group and pillar without counting "not applicable"', () => {
    const sec = rollupTests(tests).find((p) => p.pillar === 'security');
    assert.equal(sec.passed, 1);
    assert.equal(sec.failed, 1);
    assert.equal(sec.notApplicable, 1);
    assert.equal(sec.passRatePct, 50);
    assert.equal(sec.groups.find((g) => g.group === 'Response headers & CSP').passRatePct, 0);
  });

  it('builds one catalogue across cells and a compact result list per cell', () => {
    const other = tests.map((t) => (t.id === 'security:csp-present' ? { ...t, status: 'pass' } : t));
    const { catalog, compact } = buildTestCatalog([{ cellId: 'a', tests }, { cellId: 'b', tests: other }]);
    assert.equal(catalog.length, tests.length);
    const csp = catalog.find((t) => t.id === 'security:csp-present');
    assert.equal(csp.passRatePct, 50);
    const idx = catalog.indexOf(csp);
    assert.deepEqual(compact.get('a').find((r) => r[0] === idx).slice(0, 2), [idx, 0]);
    assert.deepEqual(compact.get('b').find((r) => r[0] === idx).slice(0, 2), [idx, 1]);

    const summary = { generatedAt: '2026-11-11T00:00:00Z', weights: {}, pillars: PILLARS, testCatalog: catalog, cells: [{ cellId: 'a', modelKey: 'm', modelLabel: 'M', track: 'direct-agent', trackLabel: 'Direct', buildSucceeded: true, validBuild: true, scores: { composite: 70 }, testResults: compact.get('a') }, { cellId: 'b', modelKey: 'm', modelLabel: 'M', track: 'harness:x', buildSucceeded: true, validBuild: false, scores: { composite: 0 }, testResults: compact.get('b'), demo: true }] };
    const data = buildReportData(summary, { runId: 'run-1' });
    assert.equal(data.cells[0].tests.length, tests.length);
    assert.equal(data.totals.demoCells, 1);
    const run = describeRun(data);
    assert.deepEqual([run.runId, run.cells, run.avgComposite, run.demo], ['run-1', 2, 70, true]);
    const rows = cellTestRows(data.cells[0], data.catalog);
    assert.equal(rows.find((r) => r.id === 'security:csp-present').status, 'fail');
  });

  it('gives every weighted pillar a definition the report can explain', () => {
    const w = loadBenchmarkConfig().scoring.weights;
    assert.deepEqual(Object.keys(w).sort(), PILLARS.map((p) => p.weightKey).sort());
    assert.ok(PILLARS.every((p) => p.blurb.length > 30));
  });
});

describe('Report helpers', () => {
  it('computes the small things the charts rely on', () => {
    assert.equal(avg([80, null, 90, NaN]), 85);
    assert.equal(avg([]), null);
    assert.deepEqual(['direct-oneshot', 'direct-agent', 'harness:claude-acp'].map(trackKind), ['oneshot', 'agent', 'harness']);
    assert.equal(passRate({ pass: 1, fail: 2 }), 33.3);
    assert.equal(passRate({ pass: 0, fail: 0 }), null);
    assert.deepEqual([null, 0, 50, 99, 100].map(heatClass), ['h0', 'h1', 'h4', 'h6', 'h6']);
    assert.equal(esc('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
    assert.equal(fmt(88.04), '88');
  });

  it('ships a report page that practises what the security pillar checks', () => {
    const html = readFileSync(join(PROJECT_ROOT, 'src', 'ui', 'report', 'index.html'), 'utf8');
    assert.match(html, /Content-Security-Policy/);
    assert.ok(!/'unsafe-inline'|'unsafe-eval'/.test(html));
    assert.ok(!/\son(?:click|load)=/.test(html));
    const js = readFileSync(join(PROJECT_ROOT, 'src', 'ui', 'report', 'report.js'), 'utf8');
    assert.ok(!/style="/.test(js), 'inline style attributes would be blocked by the page CSP');
  });
});
