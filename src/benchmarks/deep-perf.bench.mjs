import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withIsolatedChrome,
  applyDesktopBroadbandShaping,
  applyMobileThrottling,
  navigateAndSettle,
} from './cdp-helpers.mjs';
import { replayCompiledJourney } from '../flows/replay-journey.mjs';
import { probeServerTelemetry } from '../materialize/server-runner.mjs';
import { sleep } from '../util/env.mjs';

const PERF_OBSERVERS_INIT_SCRIPT = `(() => {
  window.__benchPerf = {
    lcpMs: 0,
    fcpMs: 0,
    clsLoad: 0,
    clsInteractive: 0,
    journeyPhase: false,
    longTasks: [],
    interactions: new Map(),
    loafs: [],
    rafDeltas: [],
    rafRunning: false,
  };

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-contentful-paint') window.__benchPerf.fcpMs = e.startTime;
      }
    }).observe({ type: 'paint', buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__benchPerf.lcpMs = Math.max(window.__benchPerf.lcpMs, e.renderTime || e.loadTime || e.startTime);
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (window.__benchPerf.journeyPhase) {
          window.__benchPerf.clsInteractive += e.value;
        } else if (!e.hadRecentInput) {
          window.__benchPerf.clsLoad += e.value;
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__benchPerf.longTasks.push({
          startMs: Math.round(e.startTime),
          durationMs: Math.round(e.duration),
        });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}

  // Official W3C Event Timing observer for INP (durationThreshold: 0 captures every discrete interaction!)
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const id = e.interactionId || 0;
        if (!id) continue;
        const prev = window.__benchPerf.interactions.get(id);
        if (!prev || e.duration > prev.duration) {
          const inputDelay = Math.max(0, e.processingStart - e.startTime);
          const processingDuration = Math.max(0, e.processingEnd - e.processingStart);
          const presentationDelay = Math.max(0, e.duration - (e.processingEnd - e.startTime));
          const targetTag = e.target ? (e.target.tagName || '').toLowerCase() + (e.target.id ? '#' + e.target.id : '') : 'unknown';
          window.__benchPerf.interactions.set(id, {
            interactionId: id,
            name: e.name,
            duration: Math.round(e.duration * 10) / 10,
            inputDelayMs: Math.round(inputDelay * 10) / 10,
            processingDurationMs: Math.round(processingDuration * 10) / 10,
            presentationDelayMs: Math.round(presentationDelay * 10) / 10,
            target: targetTag,
          });
        }
      }
    }).observe({ type: 'event', durationThreshold: 0, buffered: true });
  } catch {}

  // Long Animation Frames (LoAF) observer with script attribution
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const scripts = (e.scripts || []).slice(0, 3).map(s => ({
          invoker: s.invoker || '',
          invokerType: s.invokerType || '',
          sourceURL: (s.sourceURL || '').slice(0, 140),
          sourceFunctionName: s.sourceFunctionName || '',
          durationMs: Math.round(s.duration || 0),
        }));
        window.__benchPerf.loafs.push({
          startTimeMs: Math.round(e.startTime),
          durationMs: Math.round(e.duration),
          blockingDurationMs: Math.round(e.blockingDuration || 0),
          scripts,
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {}

  window.__startBenchRafSampler = () => {
    if (window.__benchPerf.rafRunning) return;
    window.__benchPerf.rafRunning = true;
    window.__benchPerf.journeyPhase = true;
    let last = performance.now();
    function tick(now) {
      if (!window.__benchPerf.rafRunning) return;
      window.__benchPerf.rafDeltas.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };

  window.__stopBenchRafSampler = () => {
    window.__benchPerf.rafRunning = false;
  };
})();`;

function metricMapFromCdp(metricsList = []) {
  const m = {};
  for (const item of metricsList) m[item.name] = item.value;
  return m;
}

function computeJsCoverageSummary(scriptCoverages = []) {
  let totalBytes = 0;
  let usedBytes = 0;

  for (const script of scriptCoverages) {
    if (!script.url || script.url.startsWith('chrome-extension://')) continue;
    let scriptMaxEnd = 0;
    for (const fn of script.functions || []) {
      for (const r of fn.ranges || []) {
        if (r.endOffset > scriptMaxEnd) scriptMaxEnd = r.endOffset;
      }
    }
    if (scriptMaxEnd === 0) continue;

    // Flatten covered intervals using byte array for exactness on moderate bundles (cap 5MB per script)
    const len = Math.min(scriptMaxEnd, 5 * 1024 * 1024);
    const usedMask = new Uint8Array(len);
    for (const fn of script.functions || []) {
      for (const r of fn.ranges || []) {
        const s = Math.min(r.startOffset, len);
        const e = Math.min(r.endOffset, len);
        if (r.count > 0) {
          usedMask.fill(1, s, e);
        }
      }
    }
    let scriptUsed = 0;
    for (let i = 0; i < len; i++) scriptUsed += usedMask[i];

    totalBytes += len;
    usedBytes += scriptUsed;
  }

  const unusedBytes = Math.max(0, totalBytes - usedBytes);
  return {
    totalJsBytes: totalBytes,
    usedJsBytes: usedBytes,
    unusedJsBytes: unusedBytes,
    unusedJsPct: totalBytes > 0 ? Math.round((unusedBytes / totalBytes) * 1000) / 10 : 0,
  };
}

function logNormalScore(value, p10, median) {
  if (value <= 0) return 100;
  // Smooth approximation matching CWV log-normal curves
  if (value <= p10) return Math.round(90 + 10 * (1 - value / Math.max(p10, 1)));
  if (value <= median) {
    const ratio = (value - p10) / Math.max(median - p10, 1);
    return Math.round(90 - 40 * ratio);
  }
  const tail = Math.exp(-(value - median) / Math.max(median, 1));
  return Math.max(0, Math.round(50 * tail));
}

async function runColdLoadProfile(url, config, throttled = true) {
  const viewport = throttled
    ? { ...config.browser.viewportMobile, mobile: true, deviceScaleFactor: 2 }
    : { ...config.browser.viewportDesktop, mobile: false, deviceScaleFactor: 1 };

  return withIsolatedChrome({ viewport }, async ({ client }) => {
    const { Page, Profiler, CSS, Network, Performance, Runtime } = client;
    await Promise.all([Profiler.enable(), CSS.enable()]);
    await Profiler.startPreciseCoverage({ callCount: false, detailed: true });
    await CSS.startRuleUsageTracking();

    if (throttled) {
      await applyMobileThrottling(client, config.browser.mobileThrottle);
    } else {
      await applyDesktopBroadbandShaping(client, config.browser.desktopThrottle);
    }

    let transferredBytes = 0;
    let requestCount = 0;
    let renderBlockingCount = 0;
    let thirdPartyBytes = 0;
    let apiWaterfallCount = 0;
    const apiWaterfallUrls = [];
    const reqHosts = new Map();
    const reqMeta = new Map();
    const brokenCriticalSubresources = [];

    Network.requestWillBeSent((evt) => {
      requestCount++;
      const reqUrl = evt.request?.url || '';
      try {
        const u = new URL(reqUrl);
        reqHosts.set(evt.requestId, u.hostname);
        reqMeta.set(evt.requestId, {
          type: evt.type || 'Other',
          pathname: u.pathname,
          hostname: u.hostname,
        });
        if (evt.type === 'Fetch' || evt.type === 'XHR' || u.pathname.startsWith('/api/')) {
          apiWaterfallCount++;
          if (apiWaterfallUrls.length < 10) apiWaterfallUrls.push(u.pathname + u.search);
        }
      } catch {
        // ignore
      }
      if (evt.initiator?.type === 'parser' && (evt.type === 'Script' || evt.type === 'Stylesheet')) {
        // Heuristic for parser-blocking head resources
        renderBlockingCount++;
      }
    });

    Network.responseReceived((evt) => {
      const meta = reqMeta.get(evt.requestId);
      const status = evt.response?.status || 0;
      if (
        meta &&
        status >= 400 &&
        (meta.type === 'Stylesheet' || meta.type === 'Script') &&
        (meta.hostname === '127.0.0.1' || meta.hostname === 'localhost')
      ) {
        brokenCriticalSubresources.push({
          type: meta.type,
          path: meta.pathname,
          status,
        });
      }
    });

    Network.loadingFinished((evt) => {
      const bytes = evt.encodedDataLength || 0;
      transferredBytes += bytes;
      const host = reqHosts.get(evt.requestId);
      if (host && host !== '127.0.0.1' && host !== 'localhost') {
        thirdPartyBytes += bytes;
      }
    });

    await Page.addScriptToEvaluateOnNewDocument({ source: PERF_OBSERVERS_INIT_SCRIPT });
    await navigateAndSettle(client, url, config.browser.settleWaitMs || 1200);

    const [jsCov, cssCov, cdpMetricsRes, inPageRes] = await Promise.all([
      Profiler.takePreciseCoverage(),
      CSS.stopRuleUsageTracking(),
      Performance.getMetrics(),
      Runtime.evaluate({
        expression: `(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const p = window.__benchPerf || {};
          const tbtMs = (p.longTasks || []).reduce((acc, t) => acc + Math.max(0, t.durationMs - 50), 0);
          return {
            ttfbMs: nav ? Math.round(nav.responseStart) : 0,
            domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
            loadEventMs: nav ? Math.round(nav.loadEventEnd) : 0,
            fcpMs: Math.round(p.fcpMs || 0),
            lcpMs: Math.round(p.lcpMs || p.fcpMs || 0),
            cls: Number((p.clsLoad || 0).toFixed(4)),
            tbtMs: Math.round(tbtMs),
            longTaskCount: (p.longTasks || []).length,
            maxLongTaskMs: (p.longTasks || []).reduce((m, t) => Math.max(m, t.durationMs), 0),
          };
        })()`,
        returnByValue: true,
      }),
    ]);

    await Profiler.stopPreciseCoverage();

    const jsSummary = computeJsCoverageSummary(jsCov.result || []);
    const cssRules = cssCov.ruleUsage || [];
    let totalCssBytes = 0;
    let usedCssBytes = 0;
    for (const r of cssRules) {
      const len = Math.max(0, (r.endOffset || 0) - (r.startOffset || 0));
      totalCssBytes += len;
      if (r.used) usedCssBytes += len;
    }
    const unusedCssBytes = Math.max(0, totalCssBytes - usedCssBytes);

    const cm = metricMapFromCdp(cdpMetricsRes.metrics);
    const mainThread = {
      scriptDurationMs: Math.round((cm.ScriptDuration || 0) * 1000),
      layoutDurationMs: Math.round((cm.LayoutDuration || 0) * 1000),
      recalcStyleDurationMs: Math.round((cm.RecalcStyleDuration || 0) * 1000),
      taskDurationMs: Math.round((cm.TaskDuration || 0) * 1000),
      domNodes: cm.Nodes || 0,
      jsEventListeners: cm.JSEventListeners || 0,
    };

    return {
      profile: throttled ? 'mobile-throttled-4x' : 'desktop-wan-broadband',
      vitals: inPageRes.result?.value || {},
      mainThread,
      network: {
        requestCount,
        transferredBytes,
        thirdPartyBytes,
        renderBlockingCount,
        apiWaterfallCount,
        apiWaterfallUrls,
        brokenCriticalSubresourceCount: brokenCriticalSubresources.length,
        brokenCriticalSubresources: brokenCriticalSubresources.slice(0, 10),
      },
      coverage: {
        ...jsSummary,
        totalCssBytes,
        unusedCssBytes,
        unusedCssPct: totalCssBytes > 0 ? Math.round((unusedCssBytes / totalCssBytes) * 1000) / 10 : 0,
      },
    };
  });
}

async function runJourneyInteractionPass(url, compiledFlow, promptEntry, config) {
  return withIsolatedChrome(
    { viewport: { ...config.browser.viewportDesktop, mobile: false, deviceScaleFactor: 1 } },
    async ({ client }) => {
      const { Page, Emulation, Network, Runtime } = client;
      await Page.addScriptToEvaluateOnNewDocument({ source: PERF_OBSERVERS_INIT_SCRIPT });
      await applyDesktopBroadbandShaping(client, config.browser.desktopThrottle);
      await navigateAndSettle(client, url, config.browser.settleWaitMs || 1200);

      // Apply 4x CPU throttling + broadband WAN RTT during journey interaction so INP, LoAF & /api fetches reflect real conditions
      await Emulation.setCPUThrottlingRate({
        rate: config.browser.mobileThrottle?.cpuSlowdownMultiplier || 4,
      });

      let journeyApiRequestCount = 0;
      const visitedPaths = new Set();
      try {
        visitedPaths.add(new URL(url).pathname);
      } catch {
        // ignore
      }

      Network.requestWillBeSent((evt) => {
        const reqUrl = evt.request?.url || '';
        try {
          const u = new URL(reqUrl);
          if (evt.type === 'Fetch' || evt.type === 'XHR' || u.pathname.startsWith('/api/')) {
            journeyApiRequestCount++;
          } else if (evt.type === 'Document') {
            visitedPaths.add(u.pathname + u.search);
          }
        } catch {
          // ignore
        }
      });

      await Runtime.evaluate({ expression: `window.__startBenchRafSampler && window.__startBenchRafSampler()` });
      const stepTimings = await replayCompiledJourney(client, compiledFlow, promptEntry);
      await sleep(300);
      await Runtime.evaluate({ expression: `window.__stopBenchRafSampler && window.__stopBenchRafSampler()` });

      const finalLocRes = await Runtime.evaluate({
        expression: `location.pathname + location.search + location.hash`,
        returnByValue: true,
      });
      if (finalLocRes.result?.value) visitedPaths.add(finalLocRes.result.value);

      const { result } = await Runtime.evaluate({
        expression: `(() => {
          const p = window.__benchPerf || {};
          const interactions = Array.from((p.interactions || new Map()).values())
            .sort((a, b) => b.duration - a.duration);

          // W3C INP: for <50 interactions, worst interaction; for >=50, 98th percentile
          let inpEntry = null;
          if (interactions.length > 0) {
            const idx = interactions.length >= 50 ? Math.floor(interactions.length * 0.02) : 0;
            inpEntry = interactions[idx];
          }

          const deltas = (p.rafDeltas || []).filter(d => d > 0 && d < 5000).sort((a, b) => a - b);
          const totalRafMs = deltas.reduce((a, b) => a + b, 0);
          const avgFps = totalRafMs > 0 ? Math.round((deltas.length / (totalRafMs / 1000)) * 10) / 10 : 60;
          const p95FrameMs = deltas.length > 0 ? Math.round(deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))] * 10) / 10 : 16.7;
          const jankFramesOver50Ms = deltas.filter(d => d > 50).length;
          const droppedFramePct = deltas.length > 0 ? Math.round((deltas.filter(d => d > 25).length / deltas.length) * 1000) / 10 : 0;

          const loafs = p.loafs || [];
          const totalLoafBlockingMs = loafs.reduce((acc, l) => acc + (l.blockingDurationMs || 0), 0);
          const worstLoafMs = loafs.reduce((m, l) => Math.max(m, l.durationMs || 0), 0);

          return {
            interactionCount: interactions.length,
            inpMs: inpEntry ? inpEntry.duration : 0,
            inpBreakdown: inpEntry || null,
            allInteractions: interactions.slice(0, 12),
            loafCount: loafs.length,
            totalLoafBlockingMs,
            worstLoafMs,
            topLoafs: loafs.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
            clsInteractive: Number((p.clsInteractive || 0).toFixed(4)),
            framePacing: {
              sampledFrames: deltas.length,
              avgFps,
              p95FrameMs,
              jankFramesOver50Ms,
              droppedFramePct,
            },
          };
        })()`,
        returnByValue: true,
      });

      return {
        cpuThrottleMultiplier: config.browser.mobileThrottle?.cpuSlowdownMultiplier || 4,
        flowCompletionPct: compiledFlow?.flowCompletionPct ?? 0,
        journeyApiRequestCount,
        visitedRoutes: Array.from(visitedPaths),
        stepTimings,
        ...(result?.value || {}),
      };
    }
  );
}

export default {
  id: 'deep-perf',
  label: 'Deep Performance, Server TTFB, Journey INP & LoAF Audit',
  version: '2.0.0',
  requiresBrowser: true,

  async run(ctx) {
    const { url, serverHandle, cellDir, compiledFlow, promptEntry, config, onProgress } = ctx;

    onProgress?.({ stage: 'deep-perf', detail: 'Probing server TTFB, 10× burst concurrency, SSR HTML & OS RSS memory' });
    const serverTelemetry = await probeServerTelemetry(serverHandle || { url });

    onProgress?.({ stage: 'deep-perf', detail: 'Measuring broadband WAN desktop load & JS/CSS byte coverage' });
    const desktopLoad = await runColdLoadProfile(url, config, false);

    onProgress?.({ stage: 'deep-perf', detail: 'Measuring 4× CPU / slow-4G mobile load & V8 main-thread tasks' });
    const mobileLoad = await runColdLoadProfile(url, config, true);

    onProgress?.({
      stage: 'deep-perf',
      detail: `Replaying ${compiledFlow?.steps?.length || 0}-step canonical journey for W3C INP, API waterfalls & LoAF`,
    });
    const journey = await runJourneyInteractionPass(url, compiledFlow, promptEntry, config);

    const out = {
      benchmarkId: 'deep-perf',
      measuredAt: new Date().toISOString(),
      serverTelemetry,
      desktopLoad,
      mobileLoad,
      journey,
    };

    const resultsDir = join(cellDir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'deep-perf.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
    return out;
  },

  score(result) {
    const v = result?.mobileLoad?.vitals || {};
    const cov = result?.mobileLoad?.coverage || {};
    const net = result?.mobileLoad?.network || {};
    const j = result?.journey || {};
    const srv = result?.serverTelemetry || {};

    // CWV sub-scores calibrated against Google's Good / Poor thresholds:
    const lcpScore = logNormalScore(v.lcpMs || 0, 1800, 3500);
    const tbtScore = logNormalScore(v.tbtMs || 0, 150, 500);
    const totalCls = (v.cls || 0) + (j.clsInteractive || 0);
    const clsScore = logNormalScore(totalCls * 1000, 80, 220);
    const inpScore = logNormalScore(j.inpMs || 0, 120, 380);
    const serverTtfbScore = logNormalScore(srv.burstP95TtfbMs ?? srv.singleTtfbMs ?? 10, 80, 450);

    // Code efficiency, API waterfall hygiene, broken subresource integrity & frame pacing score
    const unusedJsPenalty = Math.min(30, Math.round((cov.unusedJsPct || 0) * 0.35));
    const jankPenalty = Math.min(30, Math.round((j.framePacing?.droppedFramePct || 0) * 0.5));
    const waterfallPenalty = Math.min(20, Math.max(0, ((net.apiWaterfallCount || 0) - 2) * 5));
    const brokenCount = net.brokenCriticalSubresourceCount || 0;
    const brokenAssetPenalty = Math.min(60, brokenCount * 30);
    const efficiencyScore = Math.max(
      0,
      100 - unusedJsPenalty - jankPenalty - waterfallPenalty - brokenAssetPenalty
    );

    const rawOverall = Math.round(
      lcpScore * 0.22 +
        inpScore * 0.28 +
        tbtScore * 0.18 +
        clsScore * 0.10 +
        serverTtfbScore * 0.10 +
        efficiencyScore * 0.12
    );
    const overall = Math.max(0, rawOverall - Math.min(36, brokenCount * 18));

    return {
      overall,
      subscores: {
        lcpScore,
        inpScore,
        tbtScore,
        clsScore,
        serverTtfbScore,
        efficiencyScore,
      },
      headline: {
        mobileLcpMs: v.lcpMs ?? null,
        mobileTbtMs: v.tbtMs ?? null,
        inpMs: j.inpMs ?? null,
        loafCount: j.loafCount ?? 0,
        unusedJsPct: cov.unusedJsPct ?? 0,
        avgFps: j.framePacing?.avgFps ?? null,
        burstP95TtfbMs: srv.burstP95TtfbMs ?? null,
        serverRssMb: srv.loadServerRssMb || srv.idleServerRssMb || null,
        apiWaterfallCount: net.apiWaterfallCount ?? 0,
      },
    };
  },
};
