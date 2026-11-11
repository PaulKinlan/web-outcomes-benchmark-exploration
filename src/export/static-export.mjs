#!/usr/bin/env node
import { writeCellContainerKit } from '../hosting/containerize.mjs';
import {
  mkdirSync,
  cpSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, loadBenchmarkConfig } from '../util/env.mjs';
import { loadPromptRegistry } from '../registry/prompts.mjs';
import { loadModelRegistryConfig } from '../harness/model-registry.mjs';
import { buildCanonicalPromptAndEnvMetadata, detectPiVersion } from '../harness/generate.mjs';
import { parseAcpSessionTimeline } from '../harness/acp-client.mjs';
import { parsePiSessionTimeline } from '../harness/pi-transcript.mjs';
import { extractGeneratedFiles } from '../materialize/extract-files.mjs';
import {
  resolveCellStaticPreviewSource,
  prepareExportedStaticPreview,
} from '../materialize/static-mirror.mjs';
import { BENCHMARK_PLUGINS } from '../benchmarks/registry.mjs';
import { aggregateAllResults, CELLS_ROOT } from '../scoring/aggregate.mjs';
import { flattenCellTests } from '../scoring/test-catalog.mjs';
import { buildReportData, describeRun } from '../scoring/report-data.mjs';

function collectCompactSourceFiles(cellDir) {
  const extractedDir = join(cellDir, 'extracted');
  const out = [];
  if (existsSync(extractedDir)) {
    const walk = (d, base = d) => {
      for (const f of readdirSync(d)) {
        if (out.length >= 16) return;
        if (f === 'node_modules' || f === '.git' || f === '.bench-reference') continue;
        const full = join(d, f);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full, base);
        else if (st.size <= 160_000 && !f.endsWith('package-lock.json')) {
          try {
            out.push({
              path: full.slice(base.length + 1),
              content: readFileSync(full, 'utf8').slice(0, 24000),
            });
          } catch {
            // ignore binary/unreadable file
          }
        }
      }
    };
    walk(extractedDir);
    return out;
  }

  if (existsSync(join(cellDir, 'agent-workspace'))) {
    try {
      const wsExtracted = extractGeneratedFiles({ cellDir });
      return (wsExtracted.files || [])
        .filter((f) => !f.path.endsWith('package-lock.json') && !f.path.endsWith('pnpm-lock.yaml'))
        .slice(0, 16)
        .map((f) => ({
          path: f.path,
          content: String(f.content || '').slice(0, 24000),
        }));
    } catch {
      return [];
    }
  }
  return out;
}

export function exportStaticReport(outDir = join(PROJECT_ROOT, 'dist-report')) {
  mkdirSync(outDir, { recursive: true });
  const uiDir = join(PROJECT_ROOT, 'src', 'ui');
  cpSync(uiDir, outDir, { recursive: true });
  const outIndexPath = join(outDir, 'index.html');
  if (existsSync(outIndexPath)) {
    const rawHtml = readFileSync(outIndexPath, 'utf8');
    if (!rawHtml.includes('data-static-report=')) {
      writeFileSync(
        outIndexPath,
        rawHtml.replace(/<html([^>]*)>/i, '<html$1 data-static-report="true">'),
        'utf8'
      );
    }
  }

  const config = loadBenchmarkConfig();
  const promptReg = loadPromptRegistry();
  const modelReg = loadModelRegistryConfig();
  const summary = aggregateAllResults();
  const exportedPreviewCells = new Set();

  // Copy per-cell screenshots, static previews, uplift scorecards, and compact cell details
  const apiCellsDir = join(outDir, 'api-static', 'cells');
  mkdirSync(apiCellsDir, { recursive: true });

  if (existsSync(CELLS_ROOT)) {
    for (const cellId of readdirSync(CELLS_ROOT)) {
      const cellDir = join(CELLS_ROOT, cellId);
      if (!statSync(cellDir).isDirectory()) continue;

      for (const sub of ['screenshots', 'uplift']) {
        const srcSub = join(cellDir, sub);
        if (existsSync(srcSub)) {
          const destSub = join(outDir, 'artifacts', cellId, sub);
          mkdirSync(destSub, { recursive: true });
          cpSync(srcSub, destSub, {
            recursive: true,
            filter: (p) => !p.includes('agent-run') && !p.endsWith('.heapsnapshot'),
          });
        }
      }

      const srcTranscript = join(cellDir, 'pi-transcript.html');
      if (existsSync(srcTranscript)) {
        const destCellArtifacts = join(outDir, 'artifacts', cellId);
        mkdirSync(destCellArtifacts, { recursive: true });
        cpSync(srcTranscript, join(destCellArtifacts, 'pi-transcript.html'));
      }

      const readOpt = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
      const materialization = readOpt(join(cellDir, 'materialization.json'));
      const previewSource = materialization?.ok ? resolveCellStaticPreviewSource(cellDir) : null;
      let hasStaticPreview = false;

      if (previewSource) {
        const destPreview = join(outDir, 'preview', cellId);
        prepareExportedStaticPreview(previewSource.dir, destPreview);
        if (existsSync(join(destPreview, 'index.html'))) {
          hasStaticPreview = true;
          exportedPreviewCells.add(cellId);
        }
      }

      // Full-app builds get a Dockerfile and source archive so anyone can run and test the exact site.
      let container = null;
      try {
        const kit = writeCellContainerKit({ cellDir, outDir: join(outDir, 'artifacts', cellId, 'container'), materialization });
        if (kit.ok) container = { ...kit, path: `artifacts/${cellId}/container/`, verified: readOpt(join(cellDir, 'container-check.json')) };
      } catch (err) {
        container = null;
        console.warn(`[export] Could not write a container kit for ${cellId}: ${err.message}`);
      }

      const gen = readOpt(join(cellDir, 'generation.json'));
      const promptEntry = promptReg.prompts.find((p) => p.id === gen?.promptId) || null;
      const { exactPrompt, harnessEnvironment } = buildCanonicalPromptAndEnvMetadata(gen, promptEntry, config);
      const sessionPath = join(cellDir, 'pi-session.jsonl');
      const acpSessionPath = join(cellDir, 'acp-session.jsonl');
      const transcriptTimeline = existsSync(sessionPath)
        ? parsePiSessionTimeline(sessionPath)
        : existsSync(acpSessionPath)
          ? parseAcpSessionTimeline(acpSessionPath)
          : null;
      const rawOutputPath = join(cellDir, 'raw-output.md');
      const rawOutputPreview = existsSync(rawOutputPath)
        ? readFileSync(rawOutputPath, 'utf8').slice(0, 32000)
        : '';

      const rawBenchmarks = {};
      const pillarScores = {};
      for (const plugin of BENCHMARK_PLUGINS) {
        const res = readOpt(join(cellDir, 'results', `${plugin.id}.json`));
        if (res) {
          rawBenchmarks[plugin.id] = res;
          pillarScores[plugin.id] = plugin.score(res);
        }
      }
      const compiledFlowForTests = readOpt(join(cellDir, 'compiled-flow.json'));

      writeFileSync(
        join(apiCellsDir, `${cellId}.json`),
        JSON.stringify({
          cellId,
          tests: materialization?.ok ? flattenCellTests({ rawBenchmarks, pillarScores, compiledFlow: compiledFlowForTests }) : [],
          promptEntry,
          generation: gen,
          exactPrompt,
          harnessEnvironment,
          materialization,
          hasStaticPreview,
          container,
          staticPreviewSource: previewSource?.source || null,
          auditTelemetry: readOpt(join(cellDir, 'audit-telemetry.json')),
          compiledFlow: readOpt(join(cellDir, 'compiled-flow.json')),
          trajectory: readOpt(join(cellDir, 'trajectory.json')),
          transcriptTimeline,
          rawOutputPreview,
          hasPiTranscript: existsSync(srcTranscript),
          hasPiSession: existsSync(sessionPath),
          hasAcpSession: existsSync(acpSessionPath),
          benchmarks: {
            'tech-stack': readOpt(join(cellDir, 'results', 'tech-stack.json')),
            'prompt-judge': readOpt(join(cellDir, 'results', 'prompt-judge.json')),
            'console-errors': readOpt(join(cellDir, 'results', 'console-errors.json')),
            'lighthouse-uplift': readOpt(join(cellDir, 'results', 'lighthouse-uplift.json')),
            'deep-perf': readOpt(join(cellDir, 'results', 'deep-perf.json')),
            memory: readOpt(join(cellDir, 'results', 'memory.json')),
            security: readOpt(join(cellDir, 'results', 'security.json')),
            'outside-in': readOpt(join(cellDir, 'results', 'outside-in.json')),
          },
          extractedFiles: collectCompactSourceFiles(cellDir),
        }),
        'utf8'
      );
    }
  }

  for (const c of summary.cells || []) {
    c.hasStaticPreview = exportedPreviewCells.has(c.cellId);
  }

  const refAssetsDir = join(PROJECT_ROOT, 'assets', 'reference-images');
  if (existsSync(refAssetsDir)) {
    const outRefDir = join(outDir, 'assets', 'reference-images');
    mkdirSync(outRefDir, { recursive: true });
    cpSync(refAssetsDir, outRefDir, { recursive: true });
  }

  mkdirSync(join(outDir, 'api-static'), { recursive: true });
  writeFileSync(
    join(outDir, 'api-static', 'state.json'),
    JSON.stringify({
      staticMode: true,
      piVersion: summary.environment?.piVersion || detectPiVersion(),
      piRuntime: summary.environment || null,
      harnesses: summary.environment?.harnesses || [],
      providerBridges: summary.environment?.providerBridges || [],
      nodeVersion: process.version,
      config,
      designDoc: promptReg.designDoc || '',
      models: modelReg.models.map((m) => ({
        key: m.key,
        label: m.label,
        family: m.family,
        tier: m.tier,
        pilot: m.pilot,
        ready: false,
      })),
      prompts: promptReg.prompts,
      categories: promptReg.categories,
      benchmarks: BENCHMARK_PLUGINS.map((b) => ({ id: b.id, label: b.label, version: b.version })),
      summary,
      runningJobs: [],
    }),
    'utf8'
  );
  // Compact dataset for the public report, plus an archive entry so earlier runs stay browsable.
  // Earlier runs are restored into <outDir>/runs/ before export by scripts/fetch-run-archive.mjs.
  const runId = (process.env.BENCH_RUN_ID || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')).replace(/[^A-Za-z0-9._-]/g, '-');
  const reportData = buildReportData(summary, {
    runId,
    runLabel: process.env.BENCH_RUN_LABEL || new Date(summary.generatedAt).toISOString().slice(0, 10),
    source: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  });
  writeFileSync(join(outDir, 'api-static', 'report-data.json'), JSON.stringify(reportData), 'utf8');
  const runsDir = join(outDir, 'runs');
  mkdirSync(join(runsDir, runId), { recursive: true });
  writeFileSync(join(runsDir, runId, 'report-data.json'), JSON.stringify(reportData), 'utf8');
  let priorRuns = [];
  try {
    priorRuns = JSON.parse(readFileSync(join(runsDir, 'index.json'), 'utf8')).runs || [];
  } catch {
    priorRuns = [];
  }
  const maxRuns = Number(process.env.BENCH_ARCHIVE_MAX_RUNS || 20);
  const runs = [describeRun(reportData), ...priorRuns.filter((r) => r.runId !== runId && existsSync(join(runsDir, r.runId, 'report-data.json')))].slice(0, maxRuns);
  writeFileSync(join(runsDir, 'index.json'), JSON.stringify({ runs }, null, 2) + '\n', 'utf8');

  writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');

  return {
    outDir,
    cellCount: summary.totals.cells,
    demoCellCount: summary.totals.demoCells || 0,
    runId,
    archivedRuns: runs.length,
    previewCount: exportedPreviewCells.size,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const res = exportStaticReport();
  if (res.demoCellCount > 0) {
    console.warn(`[export] WARNING: ${res.demoCellCount} demo cell(s) are in this report. Do not publish it. Remove them with: node scripts/seed-demo-cells.mjs --clean`);
    if (process.env.GITHUB_ACTIONS) {
      console.error('[export] Refusing to export demo data in CI.');
      process.exit(1);
    }
  }
  console.log(
    `[export] Exported standalone static report (${res.cellCount} cells, ${res.previewCount} hosted previews) -> ${res.outDir}`
  );
}
