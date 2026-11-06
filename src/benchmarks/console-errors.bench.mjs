import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withIsolatedChrome,
  withTimeout,
  navigateAndSettle,
} from './cdp-helpers.mjs';
import { replayCompiledJourney } from '../flows/replay-journey.mjs';
import { sleep } from '../util/env.mjs';

function formatRemoteObject(arg) {
  if (!arg) return '';
  if (typeof arg.value === 'string') return arg.value;
  if (arg.value !== undefined) {
    try {
      return JSON.stringify(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  if (arg.description) return String(arg.description);
  if (arg.preview?.properties) {
    return arg.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ');
  }
  return arg.type || '';
}

function isBenignFavicon404(url = '', status = 0) {
  if (status !== 404) return false;
  return /\/(?:favicon\.(?:ico|png|svg)|apple-touch-icon(?:-precomposed)?\.png)(?:\?.*)?$/i.test(url);
}

function isCriticalHttpFailure({ url = '', status = 0, resourceType = '' }) {
  if (isBenignFavicon404(url, status)) return false;
  if (status >= 500) return true;
  if (/\/api\//i.test(url)) return true;
  return ['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch', 'WebSocket'].includes(resourceType);
}

/**
 * Computes a deterministic 0–100 score from captured console, runtime exception,
 * browser security/CORS/CSP log, and HTTP/network failure telemetry.
 */
export function computeConsoleErrorScore(counts = {}) {
  const {
    pageExceptionCount = 0,
    consoleErrorCount = 0,
    criticalHttpErrorCount = 0,
    nonCriticalHttpErrorCount = 0,
    favicon404Count = 0,
    failedRequestCount = 0,
    browserLogErrorCount = 0,
    consoleWarningCount = 0,
  } = counts;

  let penalty = 0;
  penalty += pageExceptionCount * 22;
  penalty += consoleErrorCount * 10;
  penalty += criticalHttpErrorCount * 14;
  penalty += nonCriticalHttpErrorCount * 6;
  penalty += Math.min(4, favicon404Count * 2);
  penalty += failedRequestCount * 12;
  penalty += browserLogErrorCount * 10;
  if (consoleWarningCount > 1) {
    penalty += Math.min(10, (consoleWarningCount - 1) * 1.5);
  }

  const score = Math.max(0, Math.min(100, Math.round((100 - penalty) * 10) / 10));
  const totalErrorCount =
    pageExceptionCount +
    consoleErrorCount +
    criticalHttpErrorCount +
    nonCriticalHttpErrorCount +
    failedRequestCount +
    browserLogErrorCount;

  return {
    overall: score,
    totalErrorCount,
    zeroErrors: totalErrorCount === 0,
    loadClean: (counts.loadErrorCount ?? totalErrorCount) === 0,
    journeyClean: (counts.journeyErrorCount ?? 0) === 0,
  };
}

export default {
  id: 'console-errors',
  label: 'Console, JS Exception & Network Error Audit',
  version: '1.0.0',
  requiresBrowser: true,

  async run(ctx) {
    const { url, cellDir, compiledFlow, promptEntry, config, onProgress } = ctx;
    onProgress?.({
      stage: 'console-errors',
      detail: 'Auditing JS console errors, uncaught exceptions & network 4xx/5xx across load + journey',
    });

    const pageExceptions = [];
    const consoleErrors = [];
    const consoleWarnings = [];
    const browserLogErrors = [];
    const httpErrors = [];
    const failedRequests = [];
    const inspectorIssueCounts = {};
    const requestMetaById = new Map();

    let currentPhase = 'load';

    await withIsolatedChrome(
      {
        viewport: config.browser?.viewportDesktop || { width: 1440, height: 900 },
        timeoutMs: 45000,
        label: 'console-errors',
      },
      async ({ client }) => {
        await Promise.all([
          client.Log?.enable?.().catch(() => {}),
          client.Audits?.enable?.().catch(() => {}),
        ]);

        client.Network.requestWillBeSent((evt) => {
          requestMetaById.set(evt.requestId, {
            url: evt.request?.url || '',
            method: evt.request?.method || 'GET',
            resourceType: evt.type || 'Other',
            phase: currentPhase,
          });
        });

        client.Network.responseReceived((evt) => {
          const status = evt.response?.status || 0;
          if (status >= 400) {
            const reqMeta = requestMetaById.get(evt.requestId) || {};
            const resUrl = evt.response?.url || reqMeta.url || '';
            const resourceType = evt.type || reqMeta.resourceType || 'Other';
            const benignFavicon = isBenignFavicon404(resUrl, status);
            const critical = isCriticalHttpFailure({ url: resUrl, status, resourceType });
            httpErrors.push({
              phase: currentPhase,
              status,
              statusText: evt.response?.statusText || '',
              method: reqMeta.method || 'GET',
              resourceType,
              url: resUrl.slice(0, 240),
              critical,
              benignFavicon,
            });
          }
        });

        client.Network.loadingFailed((evt) => {
          if (evt.canceled) return;
          const reqMeta = requestMetaById.get(evt.requestId) || {};
          const reqUrl = reqMeta.url || '';
          if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) return;
          failedRequests.push({
            phase: currentPhase,
            method: reqMeta.method || 'GET',
            resourceType: evt.type || reqMeta.resourceType || 'Other',
            url: reqUrl.slice(0, 240),
            errorText: String(evt.errorText || 'Network loading failed').slice(0, 160),
            blockedReason: evt.blockedReason || null,
          });
        });

        client.Runtime.consoleAPICalled((evt) => {
          const text = (evt.args || [])
            .map(formatRemoteObject)
            .filter(Boolean)
            .join(' ')
            .trim()
            .slice(0, 320);
          const topFrame = evt.stackTrace?.callFrames?.[0] || null;
          if (evt.type === 'error' || evt.type === 'assert') {
            consoleErrors.push({
              phase: currentPhase,
              type: evt.type,
              text: text || 'console.error',
              url: topFrame?.url ? topFrame.url.slice(0, 180) : null,
              lineNumber: topFrame?.lineNumber ?? null,
            });
          } else if (evt.type === 'warning') {
            consoleWarnings.push({
              phase: currentPhase,
              text: text || 'console.warn',
              url: topFrame?.url ? topFrame.url.slice(0, 180) : null,
            });
          }
        });

        client.Runtime.exceptionThrown((evt) => {
          const details = evt.exceptionDetails || {};
          const rawDesc =
            details.exception?.description ||
            details.exception?.value ||
            details.text ||
            'Uncaught runtime exception';
          pageExceptions.push({
            phase: currentPhase,
            text: String(rawDesc).slice(0, 360),
            url: details.url ? String(details.url).slice(0, 180) : null,
            lineNumber: details.lineNumber ?? null,
            columnNumber: details.columnNumber ?? null,
          });
        });

        client.Log?.entryAdded?.((evt) => {
          const entry = evt.entry || {};
          if (entry.level !== 'error') return;
          // Network HTTP 4xx/5xx status log entries are already tracked with full status/type in `httpErrors`
          if (entry.source === 'network' && /status of [45]\d\d/i.test(entry.text || '')) return;
          browserLogErrors.push({
            phase: currentPhase,
            source: entry.source || 'browser',
            text: String(entry.text || 'Browser console error').slice(0, 320),
            url: entry.url ? String(entry.url).slice(0, 180) : null,
            lineNumber: entry.lineNumber ?? null,
          });
        });

        client.Audits?.issueAdded?.((evt) => {
          const code = evt.issue?.code || 'InspectorIssue';
          inspectorIssueCounts[code] = (inspectorIssueCounts[code] || 0) + 1;
        });

        // Phase 1: Initial page load & settle
        await navigateAndSettle(client, url, config.browser?.settleWaitMs || 1200);

        // Phase 2: Canonical multi-step user journey replay
        if (compiledFlow?.steps?.length > 0) {
          currentPhase = 'journey';
          onProgress?.({
            stage: 'console-errors',
            detail: `Replaying ${compiledFlow.steps.length}-step user journey to catch interaction & API errors`,
          });
          await withTimeout(
            replayCompiledJourney(client, compiledFlow, promptEntry),
            25000,
            'console-errors replayCompiledJourney'
          ).catch(() => {});
          await sleep(350);
        }
      }
    );

    const criticalHttpErrors = httpErrors.filter((e) => e.critical);
    const favicon404s = httpErrors.filter((e) => e.benignFavicon);
    const nonCriticalHttpErrors = httpErrors.filter((e) => !e.critical && !e.benignFavicon);

    const countInPhase = (phase) =>
      pageExceptions.filter((x) => x.phase === phase).length +
      consoleErrors.filter((x) => x.phase === phase).length +
      httpErrors.filter((x) => x.phase === phase && !x.benignFavicon).length +
      failedRequests.filter((x) => x.phase === phase).length +
      browserLogErrors.filter((x) => x.phase === phase).length;

    const loadErrorCount = countInPhase('load');
    const journeyErrorCount = countInPhase('journey');

    const counts = {
      pageExceptionCount: pageExceptions.length,
      consoleErrorCount: consoleErrors.length,
      consoleWarningCount: consoleWarnings.length,
      browserLogErrorCount: browserLogErrors.length,
      httpErrorCount: httpErrors.length,
      criticalHttpErrorCount: criticalHttpErrors.length,
      nonCriticalHttpErrorCount: nonCriticalHttpErrors.length,
      favicon404Count: favicon404s.length,
      failedRequestCount: failedRequests.length,
      loadErrorCount,
      journeyErrorCount,
    };

    const scored = computeConsoleErrorScore(counts);

    const out = {
      benchmarkId: 'console-errors',
      measuredAt: new Date().toISOString(),
      score: scored.overall,
      zeroErrors: scored.zeroErrors,
      totalErrorCount: scored.totalErrorCount,
      counts,
      pageExceptions: pageExceptions.slice(0, 25),
      consoleErrors: consoleErrors.slice(0, 30),
      consoleWarnings: consoleWarnings.slice(0, 20),
      browserLogErrors: browserLogErrors.slice(0, 20),
      httpErrors: httpErrors.slice(0, 30),
      failedRequests: failedRequests.slice(0, 25),
      inspectorIssueCounts,
    };

    const resultsDir = join(cellDir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'console-errors.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
    return out;
  },

  score(result) {
    if (!result) {
      return {
        overall: null,
        totalErrorCount: 0,
        zeroErrors: true,
        loadClean: true,
        journeyClean: true,
      };
    }
    if (result.counts) {
      return computeConsoleErrorScore(result.counts);
    }
    return {
      overall: typeof result.score === 'number' ? result.score : 100,
      totalErrorCount: result.totalErrorCount ?? 0,
      zeroErrors: Boolean(result.zeroErrors),
      loadClean: true,
      journeyClean: true,
    };
  },
};
