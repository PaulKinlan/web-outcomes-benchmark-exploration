// Pure helpers for the report, kept free of the DOM so they can be unit tested in Node.

export const TRACK_KINDS = [
  { id: 'oneshot', label: 'Direct, one shot', color: 's1' },
  { id: 'agent', label: 'Direct, agent', color: 's2' },
  { id: 'harness', label: 'Vendor coding agent', color: 's3' },
];

export const trackKind = (track) => (track === 'direct-oneshot' ? 'oneshot' : track === 'direct-agent' ? 'agent' : 'harness');

export function avg(nums) {
  const v = nums.filter((n) => typeof n === 'number' && Number.isFinite(n));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}

export function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

export const passRate = (s) => (s.pass + s.fail > 0 ? Math.round((s.pass / (s.pass + s.fail)) * 1000) / 10 : null);

/** Six sequential steps for a 0-100 value; h0 means no data. */
export function heatClass(v) {
  if (v == null) return 'h0';
  return `h${Math.max(1, Math.min(6, Math.floor(v / 100 * 6) + 1))}`;
}

export const fmt = (v) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(1).replace(/\.0$/, ''));

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** Expands a cell's compact [catalogIndex, statusCode, score] rows into displayable test rows. */
export function cellTestRows(cell, catalog) {
  return (cell.tests || []).map(([i, code, score]) => ({ ...catalog[i], status: code === 1 ? 'pass' : code === 0 ? 'fail' : 'na', score, value: null, detail: null, evidence: [] }));
}
