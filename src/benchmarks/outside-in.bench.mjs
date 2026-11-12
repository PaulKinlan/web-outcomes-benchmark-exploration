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

async function getJson(url, { method = 'GET', timeoutMs = 90000, fetchImpl = globalThis.fetch, signal = null } = {}) {
  try {
    const res = await fetchImpl(url, { method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
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

/** Whole budget for one cell: tunnel start, reachability and the outside service. Kept well under the audit's per-cell deadline. */
export const OUTSIDE_IN_BUDGET_MS = 75000;

export async function runOutsideIn({ localUrl, openTunnel = openQuickTunnel, fetchImpl = globalThis.fetch, services = { observatory: runObservatory }, budgetMs = OUTSIDE_IN_BUDGET_MS }) {
  const out = { benchmarkId: 'outside-in', version: OUTSIDE_IN_VERSION, measuredAt: new Date().toISOString(), tunnel: { ok: false }, reachable: null, services: [] };
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(0, deadline - Date.now());
  const ac = new AbortController();
  let tunnel;
  try {
    tunnel = await openTunnel(localUrl, { startTimeoutMs: Math.min(20000, budgetMs / 3), readyTimeoutMs: Math.min(25000, budgetMs / 3), fetchImpl });
  } catch (err) {
    out.tunnel = { ok: false, error: err.message };
    return out;
  }
  let timer;
  try {
    out.tunnel = { ok: true, provider: 'Cloudflare quick tunnel' };
    try {
      const sig = () => AbortSignal.any([ac.signal, AbortSignal.timeout(Math.min(15000, Math.max(1, left())))]);
      const [pub, local] = await Promise.all([fetchImpl(tunnel.url, { redirect: 'manual', signal: sig() }), fetchImpl(localUrl, { redirect: 'manual', signal: sig() })]);
      out.reachable = { ok: pub.status === local.status, publicStatus: pub.status, localStatus: local.status, https: true };
    } catch (err) {
      out.reachable = { ok: false, error: err.message };
    }
    // The service gets what is left of the budget; if it has not answered by then it is reported as
    // timed out, its request is cancelled, and the tunnel closes before the audit moves on.
    const names = ['MDN HTTP Observatory'];
    const results = names.map((service) => ({ service, ok: false, error: `no answer within the ${Math.round(budgetMs / 1000)}s budget for outside checks` }));
    const runs = [services.observatory(tunnel.host, { fetchImpl, signal: ac.signal, timeoutMs: Math.max(1, left()) })].map((p, i) =>
      Promise.resolve(p).then(
        (r) => {
          results[i] = r;
        },
        (err) => {
          results[i] = { service: names[i], ok: false, error: err.message };
        }
      )
    );
    await Promise.race([Promise.all(runs), new Promise((r) => (timer = setTimeout(r, left())))]);
    out.services = results.map((r) => ({ ...r }));
  } finally {
    clearTimeout(timer);
    ac.abort();
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
