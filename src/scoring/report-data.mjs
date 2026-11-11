/**
 * The compact, self-contained dataset behind the public report: one row per cell with its scores and per-test
 * results, plus the test catalogue and pillar definitions. Small enough to keep one per archived run.
 */
export const REPORT_DATA_VERSION = 1;

export function buildReportData(summary, { runId = null, runLabel = null, source = null } = {}) {
  const cells = (summary.cells || []).map((c) => ({
    id: c.cellId,
    model: c.modelKey,
    modelLabel: c.modelLabel,
    family: c.family,
    prompt: c.promptId,
    promptTitle: c.promptTitle,
    category: c.category,
    categoryLabel: c.categoryLabel,
    track: c.track,
    trackLabel: c.trackLabel,
    harness: c.harness,
    harnessVersion: c.harnessVersion || null,
    mode: c.mode,
    spec: c.spec,
    sample: c.sample || 1,
    sampleGroup: c.sampleGroup || c.cellId,
    built: Boolean(c.buildSucceeded),
    valid: Boolean(c.validBuild),
    disqualified: Boolean(c.disqualifiedByJudge),
    error: c.generationError ? String(c.generationError).slice(0, 200) : null,
    demo: Boolean(c.demo),
    scores: c.scores,
    tests: c.testResults || [],
    costUsd: c.costUsd ?? null,
    generationMs: c.generationMs ?? null,
    hasPreview: Boolean(c.hasStaticPreview),
    server: c.serverArchitecture || null,
  }));
  return {
    version: REPORT_DATA_VERSION,
    runId,
    runLabel,
    source,
    generatedAt: summary.generatedAt,
    weights: summary.weights,
    pillars: summary.pillars || [],
    catalog: (summary.testCatalog || []).map((t) => ({ id: t.id, pillar: t.pillar, group: t.group, title: t.title, severity: t.severity, confidence: t.confidence, ref: t.ref })),
    environment: {
      piVersion: summary.environment?.piVersion || null,
      mwgVersion: summary.environment?.webUpliftMwgVersion || null,
      harnesses: (summary.environment?.harnesses || []).map((h) => ({ id: h.id, label: h.label, version: h.version })),
    },
    noise: summary.sampleNoise
      ? { ...summary.sampleNoise, groups: (summary.sampleNoise.groups || []).slice(0, 60) }
      : { repeatedCells: 0, totalSamples: 0, medianRange: null, maxRange: null, typicalStdDev: null, groups: [] },
    totals: { cells: cells.length, demoCells: cells.filter((c) => c.demo).length },
    cells,
  };
}

/** One line per run for runs/index.json. */
export function describeRun(reportData) {
  const valid = reportData.cells.filter((c) => c.valid);
  const avg = valid.length ? Math.round((valid.reduce((n, c) => n + (c.scores?.composite || 0), 0) / valid.length) * 10) / 10 : null;
  return {
    runId: reportData.runId,
    label: reportData.runLabel || reportData.runId,
    generatedAt: reportData.generatedAt,
    cells: reportData.cells.length,
    models: new Set(reportData.cells.map((c) => c.model)).size,
    tracks: new Set(reportData.cells.map((c) => c.track)).size,
    avgComposite: avg,
    demo: reportData.totals.demoCells > 0,
  };
}
