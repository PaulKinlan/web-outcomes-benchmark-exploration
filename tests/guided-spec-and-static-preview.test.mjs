import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROJECT_ROOT, loadBenchmarkConfig } from '../src/util/env.mjs';
import { loadPromptRegistry } from '../src/registry/prompts.mjs';
import { validatePromptRegistry } from '../src/registry/validate-prompts.mjs';
import {
  buildCellId,
  parseCellDirIdentity,
  composeSpecPromptMaterials,
  buildCanonicalPromptAndEnvMetadata,
} from '../src/harness/generate.mjs';
import {
  resolveCellStaticPreviewSource,
  captureStaticPreviewMirror,
  prepareExportedStaticPreview,
} from '../src/materialize/static-mirror.mjs';
import {
  prepareCellRuntime,
  normalizeShellScriptCommand,
} from '../src/materialize/server-runner.mjs';
import { extractGeneratedFiles } from '../src/materialize/extract-files.mjs';
import { loadModelRegistryConfig, matchesModelSelector } from '../src/harness/model-registry.mjs';
import { planWorkflowShards } from '../src/runner/shard-planner.mjs';

test('all 37 prompts have valid zero-bias design.md, seed-data.json, and gemini-nano-banana-2.1 reference JPEGs', () => {
  const validation = validatePromptRegistry();
  assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join('; ')}`);

  const reg = loadPromptRegistry();
  assert.equal(reg.prompts.length, 37);
  assert.ok(reg.designDoc && reg.designDoc.length > 500, 'Expected prompts/design.md to be loaded');

  for (const p of reg.prompts) {
    assert.ok(p.seedData && typeof p.seedData === 'object', `Missing seedData on ${p.id}`);
    assert.ok(p.seedData.brandName, `Missing seedData.brandName on ${p.id}`);
    assert.equal(
      'layoutMockupPrompt' in p.seedData,
      false,
      `layoutMockupPrompt should be stripped from runtime seedData on ${p.id}`
    );

    assert.ok(Array.isArray(p.guidedReferenceImages) && p.guidedReferenceImages.length === 1);
    const refPath = join(PROJECT_ROOT, p.guidedReferenceImages[0].path);
    assert.equal(existsSync(refPath), true, `Missing reference layout image for ${p.id}: ${refPath}`);
    const st = statSync(refPath);
    assert.ok(st.size > 20_000, `Reference JPEG for ${p.id} looks unexpectedly small (${st.size} bytes)`);
    const header = readFileSync(refPath).subarray(0, 3);
    assert.equal(header[0], 0xff);
    assert.equal(header[1], 0xd8);
    assert.equal(header[2], 0xff);
  }
});

test('freeform vs guided spec modes compose cleanly with distinct cell IDs and prompt materials', () => {
  const config = loadBenchmarkConfig();
  const reg = loadPromptRegistry();
  const plumbing = reg.prompts.find((p) => p.id === 'plumbing-appointment');
  assert.ok(plumbing);

  assert.equal(buildCellId('deepseek-flash', 'plumbing-appointment', 'agent', 'freeform'), 'deepseek-flash__plumbing-appointment__agent');
  assert.equal(buildCellId('deepseek-flash', 'plumbing-appointment', 'agent', 'guided'), 'deepseek-flash__plumbing-appointment__agent__guided');

  assert.deepEqual(parseCellDirIdentity('deepseek-flash__minecraft-clone__agent'), {
    modelKey: 'deepseek-flash',
    promptId: 'minecraft-clone',
    mode: 'agent',
    spec: 'freeform',
  });
  assert.deepEqual(parseCellDirIdentity('deepseek-flash__minecraft-clone__agent__guided'), {
    modelKey: 'deepseek-flash',
    promptId: 'minecraft-clone',
    mode: 'agent',
    spec: 'guided',
  });

  const freeMaterials = composeSpecPromptMaterials({ promptEntry: plumbing, spec: 'freeform', config });
  assert.equal(freeMaterials.spec, 'freeform');
  assert.equal(freeMaterials.resolvedRefImages.length, 0);
  assert.equal(freeMaterials.seedData, null);
  assert.equal(freeMaterials.designDocText, null);
  assert.equal(freeMaterials.composedUserPrompt, plumbing.prompt);

  const guidedMaterials = composeSpecPromptMaterials({ promptEntry: plumbing, spec: 'guided', config });
  assert.equal(guidedMaterials.spec, 'guided');
  assert.equal(guidedMaterials.resolvedRefImages.length, 1);
  assert.ok(guidedMaterials.seedData?.brandName);
  assert.ok(guidedMaterials.designDocText?.includes('UI Design & Visual System'));
  assert.ok(guidedMaterials.composedUserPrompt.includes(plumbing.seedData.brandName));
  assert.ok(guidedMaterials.composedUserPrompt.includes(plumbing.seedData.location));

  const metaGuided = buildCanonicalPromptAndEnvMetadata(
    { mode: 'agent', spec: 'guided', modelKey: 'deepseek-flash', promptId: plumbing.id },
    plumbing,
    config
  );
  assert.equal(metaGuided.exactPrompt.spec, 'guided');
  assert.equal(metaGuided.exactPrompt.referenceImages.length, 1);
  assert.equal(metaGuided.exactPrompt.seedData.brandName, plumbing.seedData.brandName);
});

test('static preview resolver & exporter rescues Vite agent-workspace/dist and mirrors full-stack $PORT /api JSON', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bench-static-mirror-'));
  try {
    // Case A: Existing Vite + Three.js production-server workspace (like deepseek-flash__minecraft-clone__agent)
    const viteCellDir = join(tmp, 'deepseek-flash__minecraft-clone__agent');
    // Unbuilt root index.html importing /src/main.ts must be skipped in favor of agent-workspace/dist/index.html
    mkdirSync(join(viteCellDir, 'agent-workspace', 'dist', 'assets'), { recursive: true });
    writeFileSync(
      join(viteCellDir, 'agent-workspace', 'index.html'),
      `<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>`,
      'utf8'
    );
    writeFileSync(
      join(viteCellDir, 'agent-workspace', 'dist', 'index.html'),
      `<!doctype html><html><head><link rel="stylesheet" crossorigin href="/assets/index-abc.css"><script type="module" crossorigin src="/assets/index-abc.js"></script></head><body><canvas id="game"></canvas></body></html>`,
      'utf8'
    );
    writeFileSync(
      join(viteCellDir, 'agent-workspace', 'dist', 'assets', 'index-abc.css'),
      `body { background: url("/assets/dirt.png"); }`,
      'utf8'
    );
    writeFileSync(
      join(viteCellDir, 'agent-workspace', 'dist', 'assets', 'index-abc.js'),
      `const tex = "/assets/dirt.png"; const preload = (dep) => { return "/"+dep; }; console.log(tex, preload("assets/chunk.js"));`,
      'utf8'
    );

    const src = resolveCellStaticPreviewSource(viteCellDir);
    assert.ok(src);
    assert.equal(src.source, 'agent-workspace/dist');

    const exportedViteDir = join(tmp, 'exported-minecraft-preview');
    prepareExportedStaticPreview(src.dir, exportedViteDir);

    const outHtml = readFileSync(join(exportedViteDir, 'index.html'), 'utf8');
    assert.ok(outHtml.includes('data-bench-static-shim="1"'));
    assert.ok(!outHtml.includes('href="/assets/'), `Expected root-relative /assets/ CSS href to be rewritten: ${outHtml}`);
    assert.ok(!outHtml.includes('src="/assets/'), `Expected root-relative /assets/ JS src to be rewritten: ${outHtml}`);
    assert.ok(outHtml.includes('assets/index-abc.js'));

    const outCss = readFileSync(join(exportedViteDir, 'assets', 'index-abc.css'), 'utf8');
    assert.ok(!outCss.includes('"/assets/dirt.png"'), `Expected CSS url() to be relative: ${outCss}`);

    const outJs = readFileSync(join(exportedViteDir, 'assets', 'index-abc.js'), 'utf8');
    assert.ok(!outJs.includes('"/assets/dirt.png"'), `Expected Vite JS asset literal to be relative: ${outJs}`);

    // Case B: Full-stack SSR + /api/* JSON Express/Node server captured during Stage 2 audit
    const ssrCellDir = join(tmp, 'gemini-flash__plumbing__agent');
    mkdirSync(join(ssrCellDir, 'agent-workspace'), { recursive: true });
    writeFileSync(
      join(ssrCellDir, 'agent-workspace', 'server.js'),
      `// uses /api/slots and /api/services`,
      'utf8'
    );

    const srv = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><h1>HarborPipe</h1><script src="/client.js"></script></body></html>`);
      } else if (req.url === '/app.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end(`h1 { color: teal; }`);
      } else if (req.url === '/client.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(`fetch('/api/slots').then(r => r.json()).then(console.log);`);
      } else if (req.url === '/api/slots') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 'slot-1', window: '08:00-10:00' }]));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });

    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    try {
      const mirrorRes = await captureStaticPreviewMirror({
        serverUrl: `http://127.0.0.1:${port}/`,
        cellDir: ssrCellDir,
        materialization: { ok: true, serverArchitecture: 'production-server' },
      });
      assert.equal(mirrorRes.ok, true);
      assert.equal(mirrorRes.seededApiCount, 1);

      const resolvedSsr = resolveCellStaticPreviewSource(ssrCellDir);
      assert.equal(resolvedSsr?.source, 'static-preview');

      const exportedSsrDir = join(tmp, 'exported-ssr-preview');
      prepareExportedStaticPreview(resolvedSsr.dir, exportedSsrDir);
      const exportedSsrHtml = readFileSync(join(exportedSsrDir, 'index.html'), 'utf8');
      assert.ok(exportedSsrHtml.includes('HarborPipe'));
      assert.ok(exportedSsrHtml.includes('/api/slots'));
      assert.ok(exportedSsrHtml.includes('slot-1'));
      assert.equal(existsSync(join(exportedSsrDir, 'app.css')), true);
      assert.equal(existsSync(join(exportedSsrDir, 'client.js')), true);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('planWorkflowShards supports freeform, guided, and both spec modes', () => {
  const freePlan = planWorkflowShards({
    modelsRaw: 'gemini-3-8-flash,deepseek-flash',
    promptScope: 'pilot',
    mode: 'agent',
    spec: 'freeform',
  });
  assert.equal(freePlan.totalCells, 20);
  assert.deepEqual(freePlan.specs, ['freeform']);

  const bothPlan = planWorkflowShards({
    modelsRaw: 'gemini-3-8-flash,deepseek-flash',
    promptScope: 'pilot',
    mode: 'agent',
    spec: 'both',
  });
  assert.equal(bothPlan.totalCells, 40);
  assert.deepEqual(bothPlan.specs, ['freeform', 'guided']);
  assert.equal(bothPlan.generateShards.length, 12);
});

test('prepareCellRuntime handles bash pipefail start.sh, missing data/ dir, and non-fatal build warnings', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bench-mat-resilience-'));
  try {
    // 1. Verify bash pipefail normalization + missing data/ directory + non-fatal broken build script
    const cellDir = join(tmp, 'claude__photo-portfolio__agent');
    const ws = join(cellDir, 'agent-workspace');
    mkdirSync(ws, { recursive: true });

    // Note: intentionally do NOT create `ws/data` and do NOT chmod +x `start.sh`
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({
        name: 'resilience-test',
        private: true,
        scripts: {
          build: 'node scripts/missing-build.js',
          start: 'node server.js',
        },
      }),
      'utf8'
    );
    writeFileSync(
      join(ws, '.bench-runtime.json'),
      JSON.stringify({
        buildCommand: 'npm run build',
        startCommand: 'sh ./start.sh',
        healthPath: '/',
      }),
      'utf8'
    );
    writeFileSync(
      join(ws, 'start.sh'),
      `#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\nexec node server.js\n`,
      { encoding: 'utf8', mode: 0o644 }
    );
    writeFileSync(
      join(ws, 'db.js'),
      `const fs = require('node:fs');\nconst path = require('node:path');\nconst dbFile = path.join(__dirname, 'data', 'portfolio.db');\nfs.writeFileSync(dbFile, 'ok');\nmodule.exports = { dbFile };\n`,
      'utf8'
    );
    writeFileSync(
      join(ws, 'server.js'),
      `const http = require('node:http');\nrequire('./db');\nconst port = Number(process.env.PORT || 3000);\nhttp.createServer((req, res) => { res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><html><body>Booted OK</body></html>'); }).listen(port, '127.0.0.1');\n`,
      'utf8'
    );

    if (existsSync('/bin/bash')) {
      assert.equal(normalizeShellScriptCommand('sh ./start.sh'), 'bash ./start.sh');
      assert.equal(normalizeShellScriptCommand('./start.sh'), 'bash ./start.sh');
    }

    const extraction = extractGeneratedFiles({ cellDir });
    const mat = await prepareCellRuntime({ cellDir, extraction, forceBuild: true });
    assert.equal(mat.ok, true, `Expected prepareCellRuntime to succeed, got: ${mat.error}`);
    assert.equal(mat.serverArchitecture, 'production-server');
    assert.ok(mat.warning && mat.warning.includes('MODULE_NOT_FOUND'), 'Expected missing build script to be logged as warning');
    assert.equal(existsSync(join(ws, 'data', 'portfolio.db')), true, 'Expected missing data/ dir to be auto-created before boot');

    // 2. Verify model shorthand aliases (e.g. gpt-6-sol -> gpt-6-1-sol)
    const cfg = loadModelRegistryConfig();
    const gptSol = cfg.models.find((m) => m.key === 'gpt-6-1-sol');
    assert.ok(gptSol);
    assert.equal(matchesModelSelector(gptSol, 'gpt-6-sol'), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
