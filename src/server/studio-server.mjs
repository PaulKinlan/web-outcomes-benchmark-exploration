#!/usr/bin/env node
import { createServer, request as httpRequest } from 'node:http';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, loadBenchmarkConfig } from '../util/env.mjs';
import { loadPromptRegistry, addCustomPrompt } from '../registry/prompts.mjs';
import { validateSinglePrompt } from '../registry/validate-prompts.mjs';
import { initializeModelRuntime, addModelToConfig } from '../harness/model-registry.mjs';
import { syncLatestModels } from '../harness/sync-models.mjs';
import { buildCanonicalPromptAndEnvMetadata, detectPiVersion } from '../harness/generate.mjs';
import { parsePiSessionTimeline } from '../harness/pi-transcript.mjs';
import { BENCHMARK_PLUGINS } from '../benchmarks/registry.mjs';
import { aggregateAllResults, CELLS_ROOT, SUMMARY_OUT_PATH } from '../scoring/aggregate.mjs';
import { runBenchmarkJob } from '../runner/orchestrator.mjs';
import { extractGeneratedFiles } from '../materialize/extract-files.mjs';
import { startCellServer } from '../materialize/server-runner.mjs';

const UI_DIR = join(PROJECT_ROOT, 'src', 'ui');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 2 * 1024 * 1024) {
        rejectPromise(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolvePromise(data ? JSON.parse(data) : {});
      } catch (err) {
        rejectPromise(err);
      }
    });
    req.on('error', rejectPromise);
  });
}

function serveFileSafe(res, rootDir, subPath, spaFallback = false) {
  const resolvedRoot = resolve(rootDir);
  const cleanRel = subPath === '/' || !subPath ? '/index.html' : subPath;
  let candidate = resolve(resolvedRoot, '.' + cleanRel);
  if (!candidate.startsWith(resolvedRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    candidate = join(candidate, 'index.html');
  }
  if (!existsSync(candidate) && spaFallback && !extname(cleanRel)) {
    candidate = join(resolvedRoot, 'index.html');
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const mime = MIME_MAP[extname(candidate).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(candidate));
}

function sanitizeEmbedHeaders(rawHeaders = {}) {
  const out = { ...rawHeaders };
  delete out['x-frame-options'];
  if (typeof out['content-security-policy'] === 'string') {
    const cleaned = out['content-security-policy']
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && !/^frame-ancestors\b/i.test(d))
      .join('; ');
    if (cleaned) out['content-security-policy'] = cleaned;
    else delete out['content-security-policy'];
  }
  return out;
}

function proxyHttpToTarget(req, res, targetBaseUrl, subPath, search = '') {
  const upstreamUrl = new URL((subPath || '/') + (search || ''), targetBaseUrl);
  const headers = { ...req.headers, host: upstreamUrl.host };
  const proxyReq = httpRequest(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, sanitizeEmbedHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`Preview upstream error: ${err.message}`);
  });
  req.pipe(proxyReq);
}

async function wrapWithEmbeddableOriginProxy(upstreamHandle) {
  const proxySrv = createServer((req, res) => {
    const u = new URL(req.url || '/', upstreamHandle.url);
    proxyHttpToTarget(req, res, upstreamHandle.url, u.pathname, u.search);
  });
  await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r));
  const addr = proxySrv.address();
  const proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    ...upstreamHandle,
    upstreamUrl: upstreamHandle.url,
    url: `http://127.0.0.1:${proxyPort}`,
    port: proxyPort,
    close: async () => {
      proxySrv.closeAllConnections?.();
      await new Promise((r) => proxySrv.close(r));
      await upstreamHandle.close?.();
    },
  };
}

export async function startStudioServer({ port = null } = {}) {
  const config = loadBenchmarkConfig();
  const listenPort = Number(port || process.env.PORT || config.studioPort || 4321);

  const activeJobs = new Map();

  // On-demand LRU pool of isolated ephemeral-origin preview servers (max 20 concurrent, 10m idle TTL)
  const previewPool = new Map(); // cellId -> { handle, lastUsedAt, bootingPromise }
  const MAX_PREVIEW_SERVERS = 20;
  const PREVIEW_IDLE_TTL_MS = 10 * 60 * 1000;

  async function ensurePreviewServer(cellId, cellDir, materialization) {
    const existing = previewPool.get(cellId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      if (existing.bootingPromise) return existing.bootingPromise;
      return existing.handle;
    }

    // Evict oldest idle server if pool is at capacity
    if (previewPool.size >= MAX_PREVIEW_SERVERS) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, entry] of previewPool.entries()) {
        if (!entry.bootingPromise && entry.lastUsedAt < oldestTs) {
          oldestTs = entry.lastUsedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const victim = previewPool.get(oldestKey);
        previewPool.delete(oldestKey);
        victim?.handle?.close?.().catch(() => {});
      }
    }

    const record = { handle: null, lastUsedAt: Date.now(), bootingPromise: null };
    record.bootingPromise = startCellServer({ cellDir, materialization, timeoutMs: 25000 })
      .then((rawHandle) => wrapWithEmbeddableOriginProxy(rawHandle))
      .then((handle) => {
        record.handle = handle;
        record.bootingPromise = null;
        record.lastUsedAt = Date.now();
        return handle;
      })
      .catch((err) => {
        previewPool.delete(cellId);
        throw err;
      });
    previewPool.set(cellId, record);
    return record.bootingPromise;
  }

  const reaperInterval = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of previewPool.entries()) {
      if (!entry.bootingPromise && now - entry.lastUsedAt > PREVIEW_IDLE_TTL_MS) {
        previewPool.delete(k);
        entry.handle?.close?.().catch(() => {});
      }
    }
  }, 60 * 1000);
  reaperInterval.unref?.();

  async function closeAllPreviewServers() {
    clearInterval(reaperInterval);
    const closing = [];
    for (const [, entry] of previewPool.entries()) {
      if (entry.handle?.close) closing.push(entry.handle.close().catch(() => {}));
    }
    previewPool.clear();
    await Promise.all(closing);
  }

  const server = createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://127.0.0.1:${listenPort}`);
      const pathname = decodeURIComponent(urlObj.pathname);

      // 1. API: Full Studio State
      if (req.method === 'GET' && pathname === '/api/state') {
        const runtime = await initializeModelRuntime();
        const promptReg = loadPromptRegistry();
        const summary = existsSync(SUMMARY_OUT_PATH)
          ? JSON.parse(readFileSync(SUMMARY_OUT_PATH, 'utf8'))
          : aggregateAllResults();

        const runningJobs = Array.from(activeJobs.values()).map((j) => ({
          id: j.id,
          status: j.status,
          startedAt: j.startedAt,
          logs: j.logs.slice(-40),
        }));

        sendJson(res, 200, {
          staticMode: false,
          piVersion: runtime.piRuntime?.version || detectPiVersion(),
          piRuntime: runtime.piRuntime || null,
          providerBridges: (runtime.providerBridges || []).map((b) => ({
            id: b.id,
            label: b.label,
            providers: b.providers,
            packageName: b.packageName,
            installed: b.installed,
            portable: b.portable,
            source: b.source,
            version: b.version,
            builtInAuthSupported: Boolean(b.builtInAuthSupported),
            envOverrideVar: b.envOverrideVar,
          })),
          nodeVersion: process.version,
          config: loadBenchmarkConfig(),
          models: runtime.models.map((m) => ({
            key: m.key,
            label: m.label,
            family: m.family,
            tier: m.tier,
            pilot: m.pilot,
            enabled: m.enabled,
            releaseDate: m.releaseDate,
            ready: m.ready,
            activeProvider: m.activeRoute?.provider || null,
            activeModelId: m.activeRoute?.modelId || null,
            via: m.activeRoute?.via || null,
            missingProviders: m.missingProviders,
          })),
          prompts: promptReg.prompts,
          categories: promptReg.categories,
          benchmarks: BENCHMARK_PLUGINS.map((b) => ({
            id: b.id,
            label: b.label,
            version: b.version,
          })),
          summary,
          runningJobs,
        });
        return;
      }

      // 2. API: Cell Detailed Artifacts (raw source, full benchmark JSONs, trajectory, prompt)
      if (req.method === 'GET' && pathname.startsWith('/api/cells/')) {
        const cellId = pathname.slice('/api/cells/'.length).replace(/[^a-zA-Z0-9_-]/g, '');
        const cellDir = join(CELLS_ROOT, cellId);
        if (!existsSync(cellDir)) {
          sendJson(res, 404, { error: 'Cell not found' });
          return;
        }

        const readJsonOpt = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
        const extractedDir = join(cellDir, 'extracted');
        let extractedFiles = [];
        if (existsSync(extractedDir)) {
          const walk = (d, base = d) => {
            for (const f of readdirSync(d)) {
              if (f === 'node_modules' || f === '.git') continue;
              const full = join(d, f);
              if (statSync(full).isDirectory()) walk(full, base);
              else {
                extractedFiles.push({
                  path: full.slice(base.length + 1),
                  content: readFileSync(full, 'utf8').slice(0, 60000),
                });
              }
            }
          };
          walk(extractedDir);
        } else if (existsSync(join(cellDir, 'agent-workspace'))) {
          const wsExtracted = extractGeneratedFiles({ cellDir });
          extractedFiles = (wsExtracted.files || [])
            .filter((f) => !f.path.endsWith('package-lock.json') && !f.path.endsWith('pnpm-lock.yaml'))
            .slice(0, 28)
            .map((f) => ({
              path: f.path,
              content: String(f.content || '').slice(0, 40000),
            }));
        }

        const promptReg = loadPromptRegistry();
        const latestConfig = loadBenchmarkConfig();
        const gen = readJsonOpt(join(cellDir, 'generation.json'));
        const materialization = readJsonOpt(join(cellDir, 'materialization.json'));
        const promptEntry = promptReg.prompts.find((p) => p.id === gen?.promptId) || null;
        const { exactPrompt, harnessEnvironment } = buildCanonicalPromptAndEnvMetadata(gen, promptEntry, latestConfig);
        const sessionPath = join(cellDir, 'pi-session.jsonl');
        const transcriptTimeline = existsSync(sessionPath) ? parsePiSessionTimeline(sessionPath) : null;
        const rawOutputPath = join(cellDir, 'raw-output.md');
        const rawOutputPreview = existsSync(rawOutputPath)
          ? readFileSync(rawOutputPath, 'utf8').slice(0, 48000)
          : '';

        let livePreviewUrl = `./preview/${encodeURIComponent(cellId)}/`;
        if (materialization?.ok) {
          try {
            const handle = await ensurePreviewServer(cellId, cellDir, materialization);
            livePreviewUrl = handle.url + '/';
          } catch {
            livePreviewUrl = `./preview/${encodeURIComponent(cellId)}/`;
          }
        }

        sendJson(res, 200, {
          cellId,
          promptEntry,
          generation: gen,
          exactPrompt,
          harnessEnvironment,
          materialization,
          compiledFlow: readJsonOpt(join(cellDir, 'compiled-flow.json')),
          trajectory: readJsonOpt(join(cellDir, 'trajectory.json')),
          transcriptTimeline,
          rawOutputPreview,
          hasPiTranscript: existsSync(join(cellDir, 'pi-transcript.html')),
          hasPiSession: existsSync(sessionPath),
          livePreviewUrl,
          benchmarks: {
            'tech-stack': readJsonOpt(join(cellDir, 'results', 'tech-stack.json')),
            'lighthouse-uplift': readJsonOpt(join(cellDir, 'results', 'lighthouse-uplift.json')),
            'deep-perf': readJsonOpt(join(cellDir, 'results', 'deep-perf.json')),
            memory: readJsonOpt(join(cellDir, 'results', 'memory.json')),
          },
          extractedFiles,
        });
        return;
      }

      // 3. API: Launch Selective Benchmark Job + SSE stream
      if (req.method === 'POST' && pathname === '/api/runs') {
        const body = await readJsonBody(req);
        const emitter = new EventEmitter();
        const ac = new AbortController();
        const tempId = `run-${Date.now()}`;

        const jobRecord = {
          id: tempId,
          status: 'running',
          startedAt: new Date().toISOString(),
          logs: [],
          clients: new Set(),
          abortController: ac,
        };
        activeJobs.set(tempId, jobRecord);

        const pushEvent = (type, payload) => {
          const entry = { ts: new Date().toISOString(), type, ...payload };
          jobRecord.logs.push(entry);
          const msg = `data: ${JSON.stringify(entry)}\n\n`;
          for (const clientRes of jobRecord.clients) {
            clientRes.write(msg);
          }
        };

        emitter.on('job:start', (d) => pushEvent('job:start', d));
        emitter.on('job:canary-done', (d) => pushEvent('job:canary-done', d));
        emitter.on('cell:start', (d) => pushEvent('cell:start', d));
        emitter.on('cell:stage', (d) => pushEvent('cell:stage', d));
        emitter.on('cell:done', (d) => pushEvent('cell:done', d));
        emitter.on('job:done', (d) => {
          jobRecord.status = 'completed';
          pushEvent('job:done', {
            completedCells: d.completedCells,
            failedCells: d.failedCells,
          });
          for (const clientRes of jobRecord.clients) {
            clientRes.end();
          }
          jobRecord.clients.clear();
        });

        runBenchmarkJob({ ...body, signal: ac.signal }, emitter).catch((err) => {
          jobRecord.status = 'failed';
          pushEvent('job:error', { error: err.message || String(err) });
          for (const clientRes of jobRecord.clients) clientRes.end();
          jobRecord.clients.clear();
        });

        sendJson(res, 202, { runId: tempId, status: 'started' });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/api/runs/') && pathname.endsWith('/events')) {
        const runId = pathname.slice('/api/runs/'.length, -'/events'.length);
        const job = activeJobs.get(runId);
        if (!job) {
          sendJson(res, 404, { error: 'Run not found' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        for (const past of job.logs) {
          res.write(`data: ${JSON.stringify(past)}\n\n`);
        }
        if (job.status !== 'running') {
          res.end();
          return;
        }

        job.clients.add(res);
        req.on('close', () => job.clients.delete(res));
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/api/runs/') && pathname.endsWith('/cancel')) {
        const runId = pathname.slice('/api/runs/'.length, -'/cancel'.length);
        const job = activeJobs.get(runId);
        if (job) {
          job.abortController.abort();
          job.status = 'cancelled';
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // 4. API: Sync Latest Models from OpenRouter / Vendors
      if (req.method === 'POST' && pathname === '/api/models/sync') {
        const syncResult = await syncLatestModels();
        sendJson(res, 200, syncResult);
        return;
      }

      // 5. API: Add Custom Model
      if (req.method === 'POST' && pathname === '/api/models') {
        const body = await readJsonBody(req);
        if (!body.key || !Array.isArray(body.routes) || body.routes.length === 0) {
          sendJson(res, 400, { error: 'Model key and at least one provider route are required.' });
          return;
        }
        const saved = addModelToConfig({
          enabled: true,
          pilot: false,
          tier: 'custom',
          ...body,
        });
        sendJson(res, 201, { model: saved });
        return;
      }

      // 6. API: Add Zero-Bias Validated Custom Prompt
      if (req.method === 'POST' && pathname === '/api/prompts') {
        const body = await readJsonBody(req);
        const promptReg = loadPromptRegistry();
        const catIds = new Set(promptReg.categories.map((c) => c.id));
        const errors = validateSinglePrompt(body, catIds);
        if (errors.length > 0) {
          sendJson(res, 400, { error: errors.join('; '), errors });
          return;
        }
        const filePath = addCustomPrompt(body);
        sendJson(res, 201, { savedPath: filePath });
        return;
      }

      // 6b. API: Upload Reference Style Image for Consistent Multimodal Prompts
      if (req.method === 'POST' && pathname === '/api/prompts/reference-image') {
        const body = await readJsonBody(req);
        const dataUrl = String(body.dataUrl || '');
        const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
        if (!m) {
          sendJson(res, 400, { error: 'Expected base64 dataUrl (PNG, JPEG, WebP, or GIF).' });
          return;
        }
        const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
        const slug = String(body.slug || 'style-ref')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-')
          .slice(0, 48);
        const filename = `${slug}-${Date.now()}.${ext}`;
        const refDir = join(PROJECT_ROOT, 'assets', 'reference-images');
        mkdirSync(refDir, { recursive: true });
        writeFileSync(join(refDir, filename), Buffer.from(m[2], 'base64'));
        sendJson(res, 201, { path: `assets/reference-images/${filename}` });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/assets/reference-images/')) {
        const sub = pathname.slice('/assets/reference-images'.length);
        serveFileSafe(res, join(PROJECT_ROOT, 'assets', 'reference-images'), sub, false);
        return;
      }

      // 7. API: Recompute Scores with Custom Weights
      if (req.method === 'POST' && pathname === '/api/reweight') {
        const body = await readJsonBody(req);
        const summary = aggregateAllResults({ customWeights: body.weights || null });
        sendJson(res, 200, { summary });
        return;
      }

      // 8. Cell Artifacts: Screenshots, web-uplift scorecard, & Live Sandboxed Site Preview
      if (req.method === 'GET' && pathname.startsWith('/artifacts/')) {
        const rest = pathname.slice('/artifacts/'.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx > 0) {
          const cellId = rest.slice(0, slashIdx).replace(/[^a-zA-Z0-9_-]/g, '');
          const subPath = rest.slice(slashIdx);
          serveFileSafe(res, join(CELLS_ROOT, cellId), subPath, false);
          return;
        }
      }

      if (pathname.startsWith('/preview/')) {
        const rest = pathname.slice('/preview/'.length);
        const slashIdx = rest.indexOf('/');
        const cellId = (slashIdx > 0 ? rest.slice(0, slashIdx) : rest).replace(/[^a-zA-Z0-9_-]/g, '');
        if (slashIdx < 0) {
          res.writeHead(302, { Location: `/preview/${cellId}/` });
          res.end();
          return;
        }
        const subPath = rest.slice(slashIdx);
        const cellDir = join(CELLS_ROOT, cellId);
        const matPath = join(cellDir, 'materialization.json');
        const mat = existsSync(matPath) ? JSON.parse(readFileSync(matPath, 'utf8')) : null;

        if (mat?.ok) {
          const handle = await ensurePreviewServer(cellId, cellDir, mat);
          const cleanSub = subPath === '/index.html' ? '/' : subPath;
          const wantsProxy = urlObj.searchParams.get('proxy') === '1' || req.method !== 'GET';
          if (wantsProxy) {
            const fwdSearch = new URLSearchParams(urlObj.searchParams);
            fwdSearch.delete('proxy');
            const qs = fwdSearch.toString() ? `?${fwdSearch.toString()}` : '';
            proxyHttpToTarget(req, res, handle.url, cleanSub, qs);
            return;
          }
          res.writeHead(307, {
            Location: `${handle.url}${cleanSub}${urlObj.search || ''}`,
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }

        serveFileSafe(res, join(cellDir, 'dist'), subPath, true);
        return;
      }

      // 9. Studio Static Frontend Assets
      serveFileSafe(res, UI_DIR, pathname, true);
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
  });

  server.on('close', () => {
    closeAllPreviewServers().catch(() => {});
  });

  const onSig = async () => {
    await closeAllPreviewServers();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  await new Promise((resolvePromise) => server.listen(listenPort, '127.0.0.1', resolvePromise));
  const studioUrl = `http://127.0.0.1:${listenPort}`;
  console.log(`\n  Web Generation & Performance Benchmark Studio`);
  console.log(`  → Local URL: ${studioUrl}\n`);
  return { server, url: studioUrl, port: listenPort, closeAllPreviewServers };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startStudioServer();
}
