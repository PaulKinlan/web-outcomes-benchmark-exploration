#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../util/env.mjs';
import { withIsolatedChrome, resolveStableChromePath } from './cdp-helpers.mjs';

export const CANARY_OUT_PATH = join(PROJECT_ROOT, 'data', 'canary-latest.json');

const CANARY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Host Canary</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #faf9f6; color: #111; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 24px; }
    .card { padding: 14px; border: 1px solid #ddd; border-radius: 8px; background: #fff; }
  </style>
</head>
<body>
  <main id="root" class="grid"></main>
  <script>
    const t0 = performance.now();
    const root = document.getElementById('root');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 240; i++) {
      const el = document.createElement('article');
      el.className = 'card';
      el.innerHTML = '<h2>Canary Card ' + i + '</h2><p>Deterministic host layout & compute probe.</p>';
      frag.appendChild(el);
    }
    root.appendChild(frag);
    // Force deterministic layout + arithmetic pass
    let checksum = root.getBoundingClientRect().height;
    for (let j = 1; j <= 150000; j++) {
      checksum += Math.sqrt(j) * 0.0001;
    }
    window.__CANARY_RESULT__ = {
      computeAndLayoutMs: Math.round((performance.now() - t0) * 100) / 100,
      checksum: Math.round(checksum),
    };
  </script>
</body>
</html>`;

export function measureNodeCpuBaselineMs() {
  const t0 = performance.now();
  let acc = 0;
  for (let i = 1; i <= 500000; i++) {
    acc += Math.sqrt(i) * Math.sin(i * 0.01);
  }
  const elapsed = Math.round((performance.now() - t0) * 100) / 100;
  return { nodeCpuComputeMs: elapsed, guard: Math.round(acc) };
}

export function loadLatestCanary() {
  if (!existsSync(CANARY_OUT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CANARY_OUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export async function runHostCanaryCalibration({ save = true } = {}) {
  const { nodeCpuComputeMs } = measureNodeCpuBaselineMs();
  const cpus = os.cpus() || [];

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(CANARY_HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/`;

  let browserMetrics = {
    browserMainThreadComputeMs: null,
    referenceFcpMs: null,
    chromeVersion: null,
    error: null,
  };

  try {
    browserMetrics = await withIsolatedChrome({ headless: true }, async ({ client }) => {
      const { Page, Runtime, Browser } = client;
      const ver = await Browser.getVersion();
      const loadDone = new Promise((r) => Page.loadEventFired(r));
      await Page.navigate({ url });
      await loadDone;

      const evalRes = await Runtime.evaluate({
        expression: `new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
            resolve({
              canary: window.__CANARY_RESULT__ || null,
              fcpMs: fcpEntry ? Math.round(fcpEntry.startTime * 10) / 10 : null,
            });
          }));
        })`,
        awaitPromise: true,
        returnByValue: true,
      });

      const val = evalRes?.result?.value || {};
      return {
        browserMainThreadComputeMs: val.canary?.computeAndLayoutMs ?? null,
        referenceFcpMs: val.fcpMs ?? null,
        chromeVersion: ver?.product || null,
        error: null,
      };
    });
  } catch (err) {
    browserMetrics.error = err.message || String(err);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const noisyReasons = [];
  if (nodeCpuComputeMs > 120) {
    noisyReasons.push(`High Node CPU baseline (${nodeCpuComputeMs}ms > 120ms threshold)`);
  }
  if (
    browserMetrics.browserMainThreadComputeMs !== null &&
    browserMetrics.browserMainThreadComputeMs > 180
  ) {
    noisyReasons.push(
      `High Chrome main-thread layout/compute baseline (${browserMetrics.browserMainThreadComputeMs}ms > 180ms threshold)`
    );
  }

  const canary = {
    calibratedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpuModel: cpus[0]?.model?.trim() || 'unknown',
      cpuCores: cpus.length,
      totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      chromePath: resolveStableChromePath() || null,
      chromeVersion: browserMetrics.chromeVersion,
      ci: Boolean(process.env.CI || process.env.GITHUB_ACTIONS),
      githubRunner: process.env.RUNNER_NAME || null,
    },
    nodeCpuComputeMs,
    browserMainThreadComputeMs: browserMetrics.browserMainThreadComputeMs,
    referenceFcpMs: browserMetrics.referenceFcpMs,
    noisyEnvironment: noisyReasons.length > 0,
    status: browserMetrics.error ? 'degraded' : noisyReasons.length > 0 ? 'noisy-vm-warning' : 'stable',
    warnings: noisyReasons,
    error: browserMetrics.error,
  };

  if (save) {
    mkdirSync(dirname(CANARY_OUT_PATH), { recursive: true });
    writeFileSync(CANARY_OUT_PATH, JSON.stringify(canary, null, 2) + '\n', 'utf8');
  }

  return canary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runHostCanaryCalibration()
    .then((res) => {
      console.log(
        `[canary] Status: ${res.status.toUpperCase()} | Node CPU: ${res.nodeCpuComputeMs}ms | Chrome Layout+JS: ${res.browserMainThreadComputeMs ?? '-'}ms | Ref FCP: ${res.referenceFcpMs ?? '-'}ms | ${res.host.cpuModel} (${res.host.cpuCores} cores)`
      );
      if (res.warnings.length > 0) {
        for (const w of res.warnings) console.warn(`  ! ${w}`);
      }
    })
    .catch((err) => {
      console.error(`[canary] Fatal: ${err.message}`);
      process.exit(1);
    });
}
