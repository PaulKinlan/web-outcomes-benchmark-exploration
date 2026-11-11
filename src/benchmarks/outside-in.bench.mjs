import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openQuickTunnel } from '../hosting/tunnel.mjs';

/**
 * Outside-in checks: the generated server is given a temporary public address and looked at by services
 * that run somewhere else. It answers "does this hold up when something other than our own machine tests it?"
 *
 * Off unless BENCH_PUBLIC_TUNNEL=1, only for builds where the model wrote its own server, and not scored:
 * third-party services come and go, so their verdicts are shown beside the benchmark's own, never mixed in.
 */

export const OUTSIDE_IN_VERSION = '1.0.0';

async function getJson(url, { method = 'GET', timeoutMs = 90000, fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(url, { method, signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return res.ok && json ? { ok: true, json } : { ok: false, error: json?.error?.message || json?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** MDN HTTP Observatory: a second opinion on response headers, cookies and CSP. */
export async function runObservatory(host, opts = {}) {
  const r = await getJson(`https://observatory-api.mdn.mozilla.net/api/v2/scan?host=${encodeURIComponent(host)}`, { method: 'POST', timeoutMs: 60000, ...opts });
  if (!r.ok) return { service: 'MDN HTTP Observatory', ok: false, error: r.error };
  if (r.json.error) return { service: 'MDN HTTP Observatory', ok: false, error: String(r.json.message || r.json.error) };
  return { service: 'MDN HTTP Observatory', ok: true, grade: r.json.grade ?? null, score: r.json.score ?? null, testsPassed: r.json.tests_passed ?? null, testsFailed: r.json.tests_failed ?? null, testsTotal: r.json.tests_quantity ?? null };
}

/** PageSpeed Insights: Lighthouse run from Google's machines over the real network. */
export async function runPageSpeed(url, { apiKey = process.env.PSI_API_KEY || '', ...opts } = {}) {
  const cats = ['performance', 'accessibility', 'best-practices', 'seo'].map((c) => `category=${c}`).join('&');
  const r = await getJson(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&${cats}${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`, { timeoutMs: 120000, ...opts });
  if (!r.ok) return { service: 'PageSpeed Insights', ok: false, error: r.error };
  const lr = r.json.lighthouseResult || {};
  const pct = (c) => (typeof lr.categories?.[c]?.score === 'number' ? Math.round(lr.categories[c].score * 100) : null);
  const num = (a) => (typeof lr.audits?.[a]?.numericValue === 'number' ? Math.round(lr.audits[a].numericValue) : null);
  return {
    service: 'PageSpeed Insights',
    ok: true,
    lighthouseVersion: lr.lighthouseVersion || null,
    performance: pct('performance'),
    accessibility: pct('accessibility'),
    bestPractices: pct('best-practices'),
    seo: pct('seo'),
    lcpMs: num('largest-contentful-paint'),
    tbtMs: num('total-blocking-time'),
    cls: typeof lr.audits?.['cumulative-layout-shift']?.numericValue === 'number' ? Math.round(lr.audits['cumulative-layout-shift'].numericValue * 1000) / 1000 : null,
  };
}

export async function runOutsideIn({ localUrl, openTunnel = openQuickTunnel, fetchImpl = globalThis.fetch, services = { observatory: runObservatory, pagespeed: runPageSpeed } }) {
  const out = { benchmarkId: 'outside-in', version: OUTSIDE_IN_VERSION, measuredAt: new Date().toISOString(), tunnel: { ok: false }, reachable: null, services: [] };
  let tunnel;
  try {
    tunnel = await openTunnel(localUrl);
  } catch (err) {
    out.tunnel = { ok: false, error: err.message };
    return out;
  }
  try {
    out.tunnel = { ok: true, provider: 'Cloudflare quick tunnel' };
    try {
      const [pub, local] = await Promise.all([fetchImpl(tunnel.url, { redirect: 'manual', signal: AbortSignal.timeout(15000) }), fetchImpl(localUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) })]);
      out.reachable = { ok: pub.status === local.status, publicStatus: pub.status, localStatus: local.status, https: true };
    } catch (err) {
      out.reachable = { ok: false, error: err.message };
    }
    const results = await Promise.all([services.observatory(tunnel.host, { fetchImpl }), services.pagespeed(`${tunnel.url}/`, { fetchImpl })]);
    out.services = results;
  } finally {
    tunnel.close();
  }
  return out;
}

export default {
  id: 'outside-in',
  label: 'Outside-in checks (temporary public address)',
  version: OUTSIDE_IN_VERSION,
  requiresBrowser: false,

  async run(ctx) {
    const { url, cellDir, materialization, serverHandle, onProgress } = ctx;
    if (process.env.BENCH_PUBLIC_TUNNEL !== '1') return null;
    if ((serverHandle?.serverArchitecture || materialization?.serverArchitecture) !== 'production-server') return null;
    onProgress?.({ stage: 'outside-in', detail: 'Opening a temporary public address for outside checks' });
    const out = await runOutsideIn({ localUrl: String(url).replace(/\/+$/, '') });
    mkdirSync(join(cellDir, 'results'), { recursive: true });
    writeFileSync(join(cellDir, 'results', 'outside-in.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
    return out;
  },

  // Shown beside the benchmark's own results, never scored.
  score() {
    return { overall: null };
  },
};
