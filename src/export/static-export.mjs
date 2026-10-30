#!/usr/bin/env node
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
import { parsePiSessionTimeline } from '../harness/pi-transcript.mjs';
import { BENCHMARK_PLUGINS } from '../benchmarks/registry.mjs';
import { aggregateAllResults, CELLS_ROOT } from '../scoring/aggregate.mjs';

export function exportStaticReport(outDir = join(PROJECT_ROOT, 'dist-report')) {
  mkdirSync(outDir, { recursive: true });
  const uiDir = join(PROJECT_ROOT, 'src', 'ui');
  cpSync(uiDir, outDir, { recursive: true });

  const config = loadBenchmarkConfig();
  const promptReg = loadPromptRegistry();
  const modelReg = loadModelRegistryConfig();
  const summary = aggregateAllResults();

  // Copy per-cell screenshots, dist previews, uplift scorecards, and compact cell details
  const apiCellsDir = join(outDir, 'api-static', 'cells');
  mkdirSync(apiCellsDir, { recursive: true });

  if (existsSync(CELLS_ROOT)) {
    for (const cellId of readdirSync(CELLS_ROOT)) {
      const cellDir = join(CELLS_ROOT, cellId);
      if (!statSync(cellDir).isDirectory()) continue;

      // Copy screenshots + scorecard
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

      // Copy self-contained pi session HTML transcript if present
      const srcTranscript = join(cellDir, 'pi-transcript.html');
      if (existsSync(srcTranscript)) {
        const destCellArtifacts = join(outDir, 'artifacts', cellId);
        mkdirSync(destCellArtifacts, { recursive: true });
        cpSync(srcTranscript, join(destCellArtifacts, 'pi-transcript.html'));
      }

      // Copy built site preview (`dist/`) and add opaque-sandbox storage shim ONLY in static export
      const srcDist = join(cellDir, 'dist');
      if (existsSync(srcDist)) {
        const destPreview = join(outDir, 'preview', cellId);
        mkdirSync(destPreview, { recursive: true });
        cpSync(srcDist, destPreview, { recursive: true });
        const shim = `<script>(function(){try{window.localStorage.length}catch(e){var mk=function(){var s=Object.create(null);return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[String(k)]=String(v)},removeItem:function(k){delete s[k]},clear:function(){s=Object.create(null)},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}};try{Object.defineProperty(window,'localStorage',{value:mk(),configurable:true});Object.defineProperty(window,'sessionStorage',{value:mk(),configurable:true})}catch(_){}}})();</script>`;
        const patchHtmlFiles = (dir) => {
          for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            if (statSync(p).isDirectory()) patchHtmlFiles(p);
            else if (entry.endsWith('.html')) {
              const html = readFileSync(p, 'utf8');
              if (!html.includes('Object.defineProperty(window,\'localStorage\'')) {
                const patched = /<head[^>]*>/i.test(html)
                  ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${shim}`)
                  : `${shim}\n${html}`;
                writeFileSync(p, patched, 'utf8');
              }
            }
          }
        };
        patchHtmlFiles(destPreview);
      }

      // Write static cell detail JSON
      const readOpt = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
      const gen = readOpt(join(cellDir, 'generation.json'));
      const promptEntry = promptReg.prompts.find((p) => p.id === gen?.promptId) || null;
      const { exactPrompt, harnessEnvironment } = buildCanonicalPromptAndEnvMetadata(gen, promptEntry, config);
      const sessionPath = join(cellDir, 'pi-session.jsonl');
      const transcriptTimeline = existsSync(sessionPath) ? parsePiSessionTimeline(sessionPath) : null;
      const rawOutputPath = join(cellDir, 'raw-output.md');
      const rawOutputPreview = existsSync(rawOutputPath)
        ? readFileSync(rawOutputPath, 'utf8').slice(0, 32000)
        : '';

      writeFileSync(
        join(apiCellsDir, `${cellId}.json`),
        JSON.stringify({
          cellId,
          promptEntry,
          generation: gen,
          exactPrompt,
          harnessEnvironment,
          materialization: readOpt(join(cellDir, 'materialization.json')),
          auditTelemetry: readOpt(join(cellDir, 'audit-telemetry.json')),
          compiledFlow: readOpt(join(cellDir, 'compiled-flow.json')),
          trajectory: readOpt(join(cellDir, 'trajectory.json')),
          transcriptTimeline,
          rawOutputPreview,
          hasPiTranscript: existsSync(srcTranscript),
          hasPiSession: existsSync(sessionPath),
          benchmarks: {
            'tech-stack': readOpt(join(cellDir, 'results', 'tech-stack.json')),
            'lighthouse-uplift': readOpt(join(cellDir, 'results', 'lighthouse-uplift.json')),
            'deep-perf': readOpt(join(cellDir, 'results', 'deep-perf.json')),
            memory: readOpt(join(cellDir, 'results', 'memory.json')),
          },
          extractedFiles: [],
        }),
        'utf8'
      );
    }
  }

  const refAssetsDir = join(PROJECT_ROOT, 'assets', 'reference-images');
  if (existsSync(refAssetsDir)) {
    const outRefDir = join(outDir, 'assets', 'reference-images');
    mkdirSync(outRefDir, { recursive: true });
    cpSync(refAssetsDir, outRefDir, { recursive: true });
  }

  // Write static state snapshot consumed automatically by app.js when /api/state is absent
  mkdirSync(join(outDir, 'api-static'), { recursive: true });
  writeFileSync(
    join(outDir, 'api-static', 'state.json'),
    JSON.stringify({
      staticMode: true,
      piVersion: summary.environment?.piVersion || detectPiVersion(),
      piRuntime: summary.environment || null,
      providerBridges: summary.environment?.providerBridges || [],
      nodeVersion: process.version,
      config,
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

  return { outDir, cellCount: summary.totals.cells };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const res = exportStaticReport();
  console.log(`[export] Exported standalone static report (${res.cellCount} cells) -> ${res.outDir}`);
}
