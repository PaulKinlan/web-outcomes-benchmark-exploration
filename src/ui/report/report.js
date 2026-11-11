// Public report for the Web Outcomes Benchmark. No dependencies: data in, DOM and SVG out.
// Routes: #/  #/pillars  #/pillar/<id>  #/harness  #/tests  #/test/<id>  #/cells  #/cell/<id>  #/method
import { pick, avg, groupBy, trackKind, TRACK_KINDS, cellTestRows, passRate, heatClass, fmt, esc } from './report-lib.js';

const main = document.getElementById('main');
const tip = document.getElementById('tip');
const state = { data: null, runs: [], runId: null, filters: { category: 'all', q: '', pillar: 'all', status: 'all', model: 'all', track: 'all' } };

// ---------------------------------------------------------------- data loading
async function getJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function loadRun(runId) {
  let data = null;
  if (runId && runId !== 'latest') data = await getJson(`../runs/${encodeURIComponent(runId)}/report-data.json`);
  if (!data) data = await getJson('../api-static/report-data.json');
  if (!data) data = await getJson('../api/report-data'); // live Studio
  state.data = data;
  state.runId = runId || 'latest';
  state.cellDetail = new Map();
}

async function cellDetail(id) {
  if (state.cellDetail.has(id)) return state.cellDetail.get(id);
  const isLatest = state.runId === 'latest' || state.runId === state.runs[0]?.runId;
  const d = isLatest ? (await getJson(`../api-static/cells/${encodeURIComponent(id)}.json`)) || (await getJson(`../api/cells/${encodeURIComponent(id)}`)) : null;
  state.cellDetail.set(id, d);
  return d;
}

// ---------------------------------------------------------------- helpers
const cells = () => state.data.cells.filter((c) => state.filters.category === 'all' || c.category === state.filters.category);
const scored = () => cells().filter((c) => c.valid);
const pillarDef = (id) => state.data.pillars.find((p) => p.id === id);
const laneKey = (c) => `${c.model}|${c.track}`;
const st = (s) => `<span class="st ${s}">${s === 'pass' ? 'Pass' : s === 'fail' ? 'Fail' : 'N/A'}</span>`;

function showTip(evt, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, evt.clientX + 12))}px`;
  tip.style.top = `${Math.max(8, evt.clientY - r.height - 10)}px`;
}
main.addEventListener('pointermove', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(e, t.dataset.tip);
  else tip.hidden = true;
});
main.addEventListener('pointerleave', () => { tip.hidden = true; });
main.addEventListener('focusin', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) { const r = t.getBoundingClientRect(); showTip({ clientX: r.left, clientY: r.top }, t.dataset.tip); }
});
main.addEventListener('focusout', () => { tip.hidden = true; });

function categoryFilter() {
  const cats = [...new Map(state.data.cells.map((c) => [c.category, c.categoryLabel])).entries()];
  if (cats.length < 2) return '';
  return `<label>Prompt category <select data-filter="category"><option value="all">All categories</option>${cats.map(([id, l]) => `<option value="${esc(id)}"${state.filters.category === id ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}

// ---------------------------------------------------------------- charts (SVG)
// Horizontal grouped bars: one row group per model, one thin bar per track kind. 0-100 scale.
function groupedBars(groups, { label = 'score' } = {}) {
  const W = 720, left = 168, right = 44, barH = 9, gap = 2, groupGap = 14;
  const plotW = W - left - right;
  let y = 6;
  const parts = [];
  for (const x of [0, 25, 50, 75, 100]) parts.push(`<line class="${x === 0 ? 'axisline' : 'gridline'}" x1="${left + (plotW * x) / 100}" x2="${left + (plotW * x) / 100}" y1="0" y2="__H__"/><text x="${left + (plotW * x) / 100}" y="__HL__" text-anchor="middle">${x}</text>`);
  for (const g of groups) {
    const h = g.bars.length * (barH + gap) - gap;
    parts.push(`<text class="name" x="${left - 10}" y="${y + h / 2 + 4}" text-anchor="end">${esc(g.label)}</text>`);
    for (const b of g.bars) {
      const w = b.value == null ? 0 : Math.max(2, (plotW * b.value) / 100);
      const tipHtml = `<b>${esc(g.label)}</b><br>${esc(b.series)}: ${b.value == null ? 'no result' : fmt(b.value)} ${esc(label)}${b.note ? `<br>${esc(b.note)}` : ''}`;
      parts.push(`<g class="row" data-tip="${esc(tipHtml)}" tabindex="0" role="img" aria-label="${esc(`${g.label}, ${b.series}: ${b.value == null ? 'no result' : fmt(b.value)}`)}"><rect class="hit" x="${left}" y="${y - 1}" width="${plotW + right}" height="${barH + 2}"/>${b.value == null ? `<text x="${left + 6}" y="${y + barH - 1}" class="muted">not run</text>` : `<path class="mark" fill="var(--${b.color})" d="M${left},${y}h${w - 4}a4,4 0 0 1 4,4v${barH - 8}a4,4 0 0 1 -4,4h-${w - 4}z"/><text class="val" x="${left + w + 6}" y="${y + barH - 0.5}">${fmt(b.value)}</text>`}</g>`);
      y += barH + gap;
    }
    y += groupGap - gap;
  }
  const H = y - groupGap + 8;
  return `<svg class="chart" viewBox="0 0 ${W} ${H + 18}" role="group" aria-label="Grouped bar chart">${parts.join('').replaceAll('__H__', H).replaceAll('__HL__', H + 14)}</svg>`;
}

// Dumbbell: direct agent vs vendor harness for the same model. One hue, two shades, delta in ink.
function dumbbells(rows) {
  const W = 720, left = 190, right = 86, rowH = 30;
  const plotW = W - left - right;
  const H = rows.length * rowH + 4;
  const x = (v) => left + (plotW * v) / 100;
  const parts = [0, 25, 50, 75, 100].map((t) => `<line class="${t === 0 ? 'axisline' : 'gridline'}" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H}"/><text x="${x(t)}" y="${H + 14}" text-anchor="middle">${t}</text>`);
  rows.forEach((r, i) => {
    const y = i * rowH + rowH / 2 + 2;
    const d = r.harness - r.direct;
    const tipHtml = `<b>${esc(r.label)}</b><br>Direct agent: ${fmt(r.direct)}<br>${esc(r.harnessLabel)}: ${fmt(r.harness)}<br>Difference: ${d >= 0 ? '+' : ''}${fmt(d)} over ${r.n} shared prompt(s)`;
    parts.push(`<g class="row" data-tip="${esc(tipHtml)}" tabindex="0" role="img" aria-label="${esc(`${r.label}: direct ${fmt(r.direct)}, ${r.harnessLabel} ${fmt(r.harness)}`)}"><rect class="hit" x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}"/><text class="name" x="${left - 12}" y="${y - 1}" text-anchor="end">${esc(r.label)}</text><text x="${left - 12}" y="${y + 12}" text-anchor="end" font-size="11">${esc(r.harnessLabel)}</text><line x1="${x(r.direct)}" x2="${x(r.harness)}" y1="${y}" y2="${y}" stroke="var(--axis)" stroke-width="2"/><circle class="mark" cx="${x(r.direct)}" cy="${y}" r="6" fill="var(--seq-2)" stroke="var(--surface)" stroke-width="2"/><circle class="mark" cx="${x(r.harness)}" cy="${y}" r="6" fill="var(--seq-5)" stroke="var(--surface)" stroke-width="2"/><text class="val" x="${W - right + 12}" y="${y + 4}">${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}</text></g>`);
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H + 18}" role="group" aria-label="Dumbbell chart of direct versus harness scores">${parts.join('')}</svg>`;
}

function heatTable(rowDefs, colDefs, valueOf, { rowHead = 'Model and track', link = null } = {}) {
  return `<div class="tablewrap"><table class="heat"><thead><tr><th>${esc(rowHead)}</th>${colDefs.map((c) => `<th class="num">${c.href ? `<a href="${c.href}">${esc(c.label)}</a>` : esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rowDefs.map((r) => `<tr><td>${link ? `<a href="${link(r)}">${esc(r.label)}</a>` : esc(r.label)}${r.sub ? `<br><span class="muted small">${esc(r.sub)}</span>` : ''}</td>${colDefs.map((c) => { const v = valueOf(r, c); return `<td class="cell"><span class="${heatClass(v)}">${v == null ? '–' : fmt(v)}</span></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const meter = (label, pct, fig, href) => `<div class="meter"><span>${href ? `<a href="${href}">${esc(label)}</a>` : esc(label)}</span><span class="track" role="img" aria-label="${pct == null ? 'no result' : `${fmt(pct)} percent`}"><span class="fill" data-w="${pct ?? 0}"></span></span><span class="fig">${esc(fig)}</span></div>`;

// ---------------------------------------------------------------- views
function lanes() {
  const by = groupBy(scored(), laneKey);
  return [...by.values()].map((list) => ({ key: laneKey(list[0]), model: list[0].model, label: list[0].modelLabel, track: list[0].track, trackLabel: list[0].trackLabel, kind: trackKind(list[0].track), sub: list[0].trackLabel, cells: list }));
}

function viewOverview() {
  const all = cells();
  const ok = scored();
  if (all.length === 0) return `<h1>No results yet</h1><p class="lede">Run the benchmark, then export the report.</p>`;
  const models = [...groupBy(ok, (c) => c.model).values()];
  const kindsPresent = TRACK_KINDS.filter((k) => ok.some((c) => trackKind(c.track) === k.id));
  const groups = models.map((list) => ({
    label: list[0].modelLabel,
    order: avg(list.map((c) => c.scores.composite)) ?? 0,
    bars: kindsPresent.map((k) => {
      const inKind = list.filter((c) => trackKind(c.track) === k.id);
      return { series: k.label, color: k.color, value: avg(inKind.map((c) => c.scores.composite)), note: inKind.length ? `${inKind.length} site(s)${k.id === 'harness' ? ` · ${inKind[0].trackLabel}` : ''}` : null };
    }),
  })).sort((a, b) => b.order - a.order);
  const ls = lanes().sort((a, b) => (avg(b.cells.map((c) => c.scores.composite)) ?? 0) - (avg(a.cells.map((c) => c.scores.composite)) ?? 0));
  const pillarCols = [{ id: 'composite', label: 'Overall' }, ...state.data.pillars.map((p) => ({ id: p.id, label: p.label, href: `#/pillar/${p.id}` }))];
  const cats = [...new Map(ok.map((c) => [c.category, c.categoryLabel])).entries()].map(([id, label]) => ({ id, label }));
  const failed = all.length - ok.length;
  return `
    <h1>How good is the website an AI builds by default?</h1>
    <p class="lede">Each model gets the same short prompts and no steering. We build what it produces and measure performance, accessibility, security and whether the site actually works. Every model is run directly and inside its vendor's coding agent, because the agent adds its own system prompt and tools.</p>
    <div class="filters">${categoryFilter()}</div>
    <div class="kpis">
      <div class="kpi"><b>${new Set(all.map((c) => c.model)).size}</b><span>models</span></div>
      <div class="kpi"><b>${new Set(all.map((c) => c.track)).size}</b><span>ways of running them</span></div>
      <div class="kpi"><b>${all.length}</b><span>sites generated${failed ? `, ${failed} unusable` : ''}</span></div>
      <div class="kpi"><b>${state.data.catalog.length}</b><span>distinct tests per site</span></div>
    </div>
    <section class="card"><h2>Overall score by model and track</h2>
      <p class="sub">Average overall score (0 to 100) across prompts. A site that fails to build, or ignores the brief, scores zero and is left out of this average; see <a href="#/cells">Sites</a> for those.</p>
      <ul class="legend">${kindsPresent.map((k) => `<li><i data-bg="${k.color}"></i>${esc(k.label)}</li>`).join('')}</ul>
      ${groupedBars(groups, { label: 'overall' })}
    </section>
    <section class="card"><h2>Scores by pillar</h2>
      <p class="sub">Each row is one model run one way. Darker means a higher score. Select a pillar to see its tests.</p>
      ${heatTable(ls, pillarCols, (r, c) => avg(r.cells.map((x) => x.scores[c.id])), { link: (r) => `#/cells?model=${encodeURIComponent(r.model)}&track=${encodeURIComponent(r.track)}` })}
    </section>
    ${cats.length > 1 ? `<section class="card"><h2>Overall score by kind of site</h2><p class="sub">Some models are strong on content sites and weaker on apps with a server. Each cell is the average overall score for that prompt category.</p>${heatTable(ls, cats, (r, c) => avg(r.cells.filter((x) => x.category === c.id).map((x) => x.scores.composite)))}</section>` : ''}`;
}

function testStats(filterFn = () => true) {
  // catalogue index -> { pass, fail, na } over the cells in scope
  const stats = state.data.catalog.map(() => ({ pass: 0, fail: 0, na: 0 }));
  for (const c of cells().filter((x) => x.built).filter(filterFn)) for (const [i, s] of c.tests) stats[i][s === 1 ? 'pass' : s === 0 ? 'fail' : 'na']++;
  return stats;
}

function viewPillars() {
  const ok = scored();
  const stats = testStats();
  return `<h1>Pillars</h1><p class="lede">The overall score is a weighted average of eight pillars. Each pillar is built from individual tests, grouped below with how often sites pass them.</p><div class="filters">${categoryFilter()}</div><div class="grid2">${state.data.pillars.map((p) => {
    const idx = state.data.catalog.map((t, i) => [t, i]).filter(([t]) => t.pillar === p.id);
    const groups = groupBy(idx, ([t]) => t.group);
    return `<section class="card"><h2><a href="#/pillar/${p.id}">${esc(p.label)}</a> <span class="pill">${p.weight != null ? `${Math.round(p.weight * 100)}% of overall` : 'not weighted'}</span></h2><p class="sub">${esc(p.blurb)}</p>
      <div class="meter"><b>Average score</b><span class="track"><span class="fill" data-w="${avg(ok.map((c) => c.scores[p.id])) ?? 0}"></span></span><span class="fig">${fmt(avg(ok.map((c) => c.scores[p.id])))} / 100</span></div>
      ${[...groups.entries()].map(([g, list]) => { const agg = list.reduce((a, [, i]) => ({ pass: a.pass + stats[i].pass, fail: a.fail + stats[i].fail }), { pass: 0, fail: 0 }); return meter(g, passRate(agg), `${fmt(passRate(agg))}% pass · ${list.length} test${list.length === 1 ? '' : 's'}`, `#/tests?pillar=${p.id}&group=${encodeURIComponent(g)}`); }).join('') || '<p class="muted small">No tests recorded for this pillar in this run.</p>'}
    </section>`;
  }).join('')}</div>`;
}

function viewPillar(id) {
  const p = pillarDef(id);
  if (!p) return notFound();
  const ls = lanes();
  const stats = testStats();
  const idx = state.data.catalog.map((t, i) => [t, i]).filter(([t]) => t.pillar === id);
  const groups = [...groupBy(idx, ([t]) => t.group).entries()];
  const laneStats = new Map(ls.map((l) => [l.key, testStats((c) => laneKey(c) === l.key)]));
  const cols = groups.map(([g]) => ({ id: g, label: g }));
  return `<p class="crumbs"><a href="#/pillars">Pillars</a> / ${esc(p.label)}</p><h1>${esc(p.label)}</h1><p class="lede">${esc(p.blurb)} ${p.weight != null ? `It counts for ${Math.round(p.weight * 100)}% of the overall score.` : ''}</p>
    <section class="card"><h2>Pass rate by group</h2><p class="sub">Share of applicable tests passed in each group, for each model and track.</p>
      ${heatTable(ls, cols, (r, c) => { const s = laneStats.get(r.key); const list = idx.filter(([t]) => t.group === c.id); return passRate(list.reduce((a, [, i]) => ({ pass: a.pass + s[i].pass, fail: a.fail + s[i].fail }), { pass: 0, fail: 0 })); })}
    </section>
    <section class="card"><h2>Every test in this pillar</h2>${groups.map(([g, list]) => `<h3>${esc(g)}</h3>${list.sort((a, b) => (passRate(stats[a[1]]) ?? 101) - (passRate(stats[b[1]]) ?? 101)).map(([t, i]) => meter(t.title, passRate(stats[i]), stats[i].pass + stats[i].fail ? `${stats[i].pass} of ${stats[i].pass + stats[i].fail} pass` : 'not applicable', `#/test/${encodeURIComponent(t.id)}`)).join('')}`).join('')}</section>`;
}

function viewHarness() {
  const ok = scored();
  const metricIds = ['composite', ...state.data.pillars.map((p) => p.id)];
  const metric = metricIds.includes(state.filters.metric) ? state.filters.metric : 'composite';
  const rows = [];
  for (const list of groupBy(ok, (c) => c.model).values()) {
    const direct = new Map(list.filter((c) => c.track === 'direct-agent').map((c) => [`${c.prompt}|${c.spec}`, c]));
    for (const hl of groupBy(list.filter((c) => trackKind(c.track) === 'harness'), (c) => c.track).values()) {
      const pairs = hl.map((h) => [direct.get(`${h.prompt}|${h.spec}`), h]).filter(([d, h]) => d && typeof d.scores[metric] === 'number' && typeof h.scores[metric] === 'number');
      if (pairs.length) rows.push({ label: hl[0].modelLabel, harnessLabel: hl[0].trackLabel, n: pairs.length, direct: avg(pairs.map(([d]) => d.scores[metric])), harness: avg(pairs.map(([, h]) => h.scores[metric])) });
    }
  }
  rows.sort((a, b) => b.harness - b.direct - (a.harness - a.direct));
  const pill = (id) => (id === 'composite' ? 'Overall' : pillarDef(id)?.label || id);
  return `<h1>Does the coding agent change the result?</h1><p class="lede">The same model, the same prompts, two ways of running it: a neutral agent loop with no added instructions, and the vendor's own coding agent with its system prompt and tools. Only prompts that both produced a usable site for are compared.</p>
    <div class="filters">${categoryFilter()}<label>Measure <select data-filter="metric">${metricIds.map((m) => `<option value="${m}"${m === metric ? ' selected' : ''}>${esc(pill(m))}</option>`).join('')}</select></label></div>
    <section class="card"><h2>${esc(pill(metric))}: direct agent versus vendor agent</h2>
      ${rows.length ? `<ul class="legend"><li><i data-bg="seq-2"></i>Direct agent (neutral loop)</li><li><i data-bg="seq-5"></i>Vendor coding agent</li><li>Number on the right: difference in points</li></ul>${dumbbells(rows)}
      <details><summary>Show as a table</summary><div class="tablewrap"><table><thead><tr><th>Model</th><th>Vendor agent</th><th class="num">Direct</th><th class="num">In agent</th><th class="num">Difference</th><th class="num">Shared prompts</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.harnessLabel)}</td><td class="num">${fmt(r.direct)}</td><td class="num">${fmt(r.harness)}</td><td class="num">${r.harness - r.direct >= 0 ? '+' : '−'}${fmt(Math.abs(r.harness - r.direct))}</td><td class="num">${r.n}</td></tr>`).join('')}</tbody></table></div></details>` : '<p class="empty">No model in this run has usable sites from both a direct agent run and a vendor agent run for the same prompt.</p>'}
    </section>
    <p class="sub">With one generation per prompt, small differences are noise. Treat a gap of a few points as a tie.</p>`;
}

function viewTests(params) {
  const f = state.filters;
  for (const k of ['pillar', 'status', 'model', 'track', 'q']) if (params.has(k)) f[k] = params.get(k);
  const group = params.get('group');
  const modelOpts = [...new Map(state.data.cells.map((c) => [c.model, c.modelLabel])).entries()];
  const trackOpts = [...new Map(state.data.cells.map((c) => [c.track, c.trackLabel])).entries()];
  const stats = testStats((c) => (f.model === 'all' || c.model === f.model) && (f.track === 'all' || c.track === f.track));
  const q = f.q.trim().toLowerCase();
  let rows = state.data.catalog.map((t, i) => ({ t, s: stats[i] })).filter(({ t, s }) => (f.pillar === 'all' || t.pillar === f.pillar) && (!group || t.group === group) && (!q || `${t.title} ${t.id} ${t.group}`.toLowerCase().includes(q)) && (f.status === 'all' || (f.status === 'failing' ? s.fail > 0 : f.status === 'always-pass' ? s.fail === 0 && s.pass > 0 : s.pass + s.fail === 0)));
  rows.sort((a, b) => (passRate(a.s) ?? 101) - (passRate(b.s) ?? 101) || a.t.title.localeCompare(b.t.title));
  const byPillar = groupBy(rows, (r) => r.t.pillar);
  const sel = (name, opts, cur) => `<select data-filter="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<h1>Every test</h1><p class="lede">${state.data.catalog.length} distinct tests run against each site. Filter them, then select a test to see which sites pass it.</p>
    <div class="filters">
      <label>Search <input type="search" data-filter="q" value="${esc(f.q)}" placeholder="e.g. contrast, CSP, LCP"></label>
      <label>Pillar ${sel('pillar', [['all', 'All pillars'], ...state.data.pillars.map((p) => [p.id, p.label])], f.pillar)}</label>
      <label>Result ${sel('status', [['all', 'Any result'], ['failing', 'Fails somewhere'], ['always-pass', 'Always passes'], ['na', 'Never applied']], f.status)}</label>
      <label>Model ${sel('model', [['all', 'All models'], ...modelOpts], f.model)}</label>
      <label>Track ${sel('track', [['all', 'All tracks'], ...trackOpts], f.track)}</label>
      ${categoryFilter()}
    </div>
    ${group ? `<p class="sub">Showing the group “${esc(group)}”. <a href="#/tests?pillar=${esc(f.pillar)}">Show the whole pillar</a></p>` : ''}
    <p class="sub">${rows.length} test${rows.length === 1 ? '' : 's'}, hardest first.</p>
    ${rows.length === 0 ? '<p class="empty">No tests match these filters.</p>' : [...byPillar.entries()].map(([pid, list]) => `<section class="card"><h2>${esc(pillarDef(pid)?.label || pid)}</h2><div class="tablewrap"><table><thead><tr><th>Test</th><th>Group</th><th class="num">Pass rate</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">N/A</th></tr></thead><tbody>${list.map(({ t, s }) => `<tr><td><a href="#/test/${encodeURIComponent(t.id)}">${esc(t.title)}</a>${t.severity ? ` <span class="pill">${esc(t.severity)}</span>` : ''}${t.confidence === 'heuristic' ? ' <span class="pill" data-tip="Read from the source code by pattern, not measured in a browser. Can be wrong.">heuristic</span>' : ''}</td><td class="muted">${esc(t.group)}</td><td class="num">${passRate(s) == null ? '–' : `${fmt(passRate(s))}%`}</td><td class="num">${s.pass}</td><td class="num">${s.fail}</td><td class="num">${s.na}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}`;
}

function viewTest(id) {
  const i = state.data.catalog.findIndex((t) => t.id === id);
  if (i < 0) return notFound();
  const t = state.data.catalog[i];
  const p = pillarDef(t.pillar);
  const res = cells().filter((c) => c.built).map((c) => ({ c, r: c.tests.find((x) => x[0] === i) })).filter((x) => x.r);
  const s = res.reduce((a, { r }) => { a[r[1] === 1 ? 'pass' : r[1] === 0 ? 'fail' : 'na']++; return a; }, { pass: 0, fail: 0, na: 0 });
  const prompts = [...new Map(res.map(({ c }) => [c.prompt, c.promptTitle])).entries()];
  const byLane = groupBy(res, ({ c }) => laneKey(c));
  const laneRows = [...byLane.values()].map((list) => ({ c: list[0].c, list, rate: passRate(list.reduce((a, { r }) => { a[r[1] === 1 ? 'pass' : r[1] === 0 ? 'fail' : 'na']++; return a; }, { pass: 0, fail: 0, na: 0 })) })).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const code = (r) => (r[1] === 1 ? 'pass' : r[1] === 0 ? 'fail' : 'na');
  return `<p class="crumbs"><a href="#/tests">Tests</a> / <a href="#/pillar/${t.pillar}">${esc(p?.label || t.pillar)}</a> / ${esc(t.group)}</p>
    <h1>${esc(t.title)}</h1>
    <p class="lede">${t.severity ? `Severity: ${esc(t.severity)}. ` : ''}${t.confidence === 'heuristic' ? 'This test reads the source code for known patterns rather than measuring behaviour, so it can be wrong in either direction. ' : ''}${t.ref ? `<a href="${esc(t.ref)}" rel="noopener">Background on this test</a>` : ''}</p>
    <div class="kpis"><div class="kpi"><b>${passRate(s) == null ? '–' : `${fmt(passRate(s))}%`}</b><span>of sites pass</span></div><div class="kpi"><b>${s.pass}</b><span>pass</span></div><div class="kpi"><b>${s.fail}</b><span>fail</span></div><div class="kpi"><b>${s.na}</b><span>not applicable</span></div></div>
    <section class="card"><h2>Result for every site</h2><p class="sub">Rows are a model run one way, columns are prompts. Select a result to open that site.</p>
      <div class="tablewrap"><table><thead><tr><th>Model and track</th><th class="num">Pass rate</th>${prompts.map(([, title]) => `<th>${esc(title)}</th>`).join('')}</tr></thead><tbody>${laneRows.map(({ c, list, rate }) => `<tr><td>${esc(c.modelLabel)}<br><span class="muted small">${esc(c.trackLabel)}</span></td><td class="num">${rate == null ? '–' : `${fmt(rate)}%`}</td>${prompts.map(([pid]) => { const hit = list.find((x) => x.c.prompt === pid); return `<td>${hit ? `<a href="#/cell/${encodeURIComponent(hit.c.id)}?test=${encodeURIComponent(t.id)}" aria-label="${esc(`${code(hit.r)}: open site`)}">${st(code(hit.r))}</a>` : '<span class="muted">not run</span>'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
    </section>
    <p class="sub small">Permanent link to this test: <code>${esc(location.href.split('#')[0])}#/test/${esc(encodeURIComponent(t.id))}</code></p>`;
}

function viewCells(params) {
  const f = state.filters;
  for (const k of ['model', 'track']) if (params.has(k)) f[k] = params.get(k);
  const list = cells().filter((c) => (f.model === 'all' || c.model === f.model) && (f.track === 'all' || c.track === f.track)).sort((a, b) => (b.scores?.composite ?? -1) - (a.scores?.composite ?? -1));
  const modelOpts = [...new Map(state.data.cells.map((c) => [c.model, c.modelLabel])).entries()];
  const trackOpts = [...new Map(state.data.cells.map((c) => [c.track, c.trackLabel])).entries()];
  const sel = (name, opts, cur) => `<select data-filter="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<h1>Every generated site</h1><p class="lede">One row per site: a model, a way of running it, and a prompt. Open a site to see every test result behind its score.</p>
    <div class="filters"><label>Model ${sel('model', [['all', 'All models'], ...modelOpts], f.model)}</label><label>Track ${sel('track', [['all', 'All tracks'], ...trackOpts], f.track)}</label>${categoryFilter()}</div>
    <div class="card"><div class="tablewrap"><table><thead><tr><th>Site</th><th>Model</th><th>Track</th><th class="num">Overall</th>${state.data.pillars.map((p) => `<th class="num">${esc(p.label)}</th>`).join('')}</tr></thead><tbody>${list.map((c) => `<tr><td><a href="#/cell/${encodeURIComponent(c.id)}">${esc(c.promptTitle)}</a>${!c.built ? ' <span class="pill">did not build</span>' : c.disqualified ? ' <span class="pill">off brief</span>' : ''}</td><td>${esc(c.modelLabel)}</td><td class="muted">${esc(c.trackLabel)}</td><td class="num"><b>${fmt(c.scores?.composite)}</b></td>${state.data.pillars.map((p) => `<td class="num">${fmt(c.scores?.[p.id])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
}

async function viewCell(id, params) {
  const c = state.data.cells.find((x) => x.id === id);
  if (!c) return notFound();
  const detail = await cellDetail(id);
  const rows = detail?.tests?.length ? detail.tests : cellTestRows(c, state.data.catalog);
  const focus = params.get('test');
  const byPillar = groupBy(rows, (r) => r.pillar);
  return `<p class="crumbs"><a href="#/cells">Sites</a> / ${esc(c.modelLabel)} / ${esc(c.trackLabel)}</p>
    <h1>${esc(c.promptTitle)}</h1>
    <p class="lede">Built by ${esc(c.modelLabel)}, run as “${esc(c.trackLabel)}”${c.harnessVersion ? ` (version ${esc(c.harnessVersion)})` : ''}. ${c.server === 'production-server' ? 'The model wrote its own server.' : c.built ? 'The model produced static files.' : ''} ${c.hasPreview ? `<a href="../preview/${encodeURIComponent(c.id)}/" rel="noopener">Open the generated site</a> · ` : ''}<a href="../#cell=${encodeURIComponent(c.id)}">Full technical record</a></p>
    ${!c.built ? `<div class="card"><h2>This site did not build</h2><p class="sub">${esc(c.error || 'The generated code could not be built or started, so no tests ran. It scores zero.')}</p></div>` : ''}
    ${c.disqualified ? '<div class="card"><h2>Scored zero: off brief</h2><p class="sub">The judge found this site off topic or a placeholder, so its overall score is zero. The test results below are still shown.</p></div>' : ''}
    <div class="kpis"><div class="kpi"><b>${fmt(c.scores?.composite)}</b><span>overall</span></div>${state.data.pillars.map((p) => `<div class="kpi"><b>${fmt(c.scores?.[p.id])}</b><span>${esc(p.label)}</span></div>`).join('')}</div>
    ${[...byPillar.entries()].map(([pid, list]) => { const s = list.reduce((a, r) => { a[r.status]++; return a; }, { pass: 0, fail: 0, na: 0 }); const open = list.some((r) => r.id === focus); return `<section class="card"><h2>${esc(pillarDef(pid)?.label || pid)} <span class="pill">${s.pass} pass · ${s.fail} fail${s.na ? ` · ${s.na} n/a` : ''}</span></h2>${[...groupBy(list, (r) => r.group).entries()].map(([g, gl]) => { const gf = gl.filter((r) => r.status === 'fail').length; return `<details class="grp"${gf > 0 || open ? ' open' : ''}><summary><b>${esc(g)}</b> <span class="muted small">${gl.filter((r) => r.status === 'pass').length} of ${gl.filter((r) => r.status !== 'na').length} pass</span></summary><div class="tablewrap"><table><tbody>${gl.sort((a, b) => 'fail,pass,na'.indexOf(a.status) - 'fail,pass,na'.indexOf(b.status)).map((r) => `<tr id="t-${esc(r.id)}"${r.id === focus ? ' data-focus' : ''}><td class="nowrap">${st(r.status)}</td><td><a href="#/test/${encodeURIComponent(r.id)}">${esc(r.title)}</a>${r.detail ? `<br><span class="muted small">${esc(r.detail)}</span>` : ''}${r.evidence?.length ? `<ul class="evidence">${r.evidence.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul>` : ''}</td><td class="num">${esc(r.value ?? '')}</td></tr>`).join('')}</tbody></table></div></details>`; }).join('')}</section>`; }).join('')}`;
}

function viewMethod() {
  const d = state.data;
  return `<h1>How this benchmark works</h1><p class="lede">The aim is to measure what you get by default. No model is told to be fast, accessible or secure. Whatever it chooses to do is what gets measured.</p>
    <section class="card"><h2>Three ways of running a model</h2><dl class="defs">
      <dt>Direct, one shot</dt><dd>One request to the model's API with a neutral system prompt. It answers with the whole site in one reply.</dd>
      <dt>Direct, agent</dt><dd>The model works in an empty folder with four tools (read, write, edit, shell) in a neutral agent loop${d.environment.piVersion ? ` (pi ${esc(d.environment.piVersion)})` : ''}. No skills, no project instructions.</dd>
      <dt>Vendor coding agent</dt><dd>The model runs inside its vendor's own agent, such as Claude Code, Codex, Gemini CLI, Qwen Code, Kimi CLI or Muse. That agent brings its own system prompt and tools, which is exactly what this track measures.</dd></dl></section>
    <section class="card"><h2>What is measured</h2><p class="sub">Each site gets a 0 to 100 score per pillar. The overall score is their weighted average.</p><div class="tablewrap"><table><thead><tr><th>Pillar</th><th class="num">Weight</th><th>What it covers</th></tr></thead><tbody>${d.pillars.map((p) => `<tr><td><a href="#/pillar/${p.id}">${esc(p.label)}</a></td><td class="num">${p.weight != null ? `${Math.round(p.weight * 100)}%` : '–'}</td><td>${esc(p.blurb)}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><h2>Things to keep in mind</h2><ul>
      <li><b>One generation per prompt.</b> Models are not deterministic, so a single site can be lucky or unlucky. Compare averages, and treat gaps of a few points as ties.</li>
      <li><b>Zero means unusable.</b> A site that does not build, or that the judge finds off brief, scores zero overall.</li>
      <li><b>“Not applicable” is not a pass.</b> A static site is not marked down for response headers only a server can send, and those tests are left out of its score.</li>
      <li><b>Heuristic tests are labelled.</b> Some security tests read the source code for known patterns. They can be wrong and say so.</li>
      <li><b>Everything runs locally.</b> Sites are served on a local machine, so measurements exclude real network distance.</li></ul>
      <p class="sub">Tooling in this run: ${[d.environment.mwgVersion && `Modern Web Guidance ${esc(d.environment.mwgVersion)}`, ...d.environment.harnesses.filter((h) => h.version).map((h) => `${esc(h.label)} ${esc(h.version)}`)].filter(Boolean).join(' · ') || 'not recorded'}. Results generated ${esc(new Date(d.generatedAt).toUTCString())}.</p></section>`;
}

const notFound = () => `<h1>Not found</h1><p class="lede">That page is not part of this run. <a href="#/">Back to the overview</a></p>`;

// ---------------------------------------------------------------- router
async function render() {
  if (!state.data) { main.innerHTML = '<h1>No results to show</h1><p class="lede">This report has no data yet.</p>'; return; }
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [head, ...rest] = path.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  const routes = { '': viewOverview, pillars: viewPillars, pillar: () => viewPillar(arg), harness: viewHarness, tests: () => viewTests(params), test: () => viewTest(arg), cells: () => viewCells(params), cell: () => viewCell(arg, params), method: viewMethod };
  main.innerHTML = await (routes[head] || notFound)();
  for (const el of main.querySelectorAll('[data-w]')) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`;
  for (const el of main.querySelectorAll('[data-bg]')) el.style.background = `var(--${el.dataset.bg})`;
  const navKey = { '': 'overview', pillar: 'pillars', test: 'tests', cell: 'cells' }[head] ?? head;
  for (const a of document.querySelectorAll('#nav a')) a.toggleAttribute('aria-current', a.dataset.nav === navKey), a.dataset.nav === navKey && a.setAttribute('aria-current', 'page');
  document.title = `${main.querySelector('h1')?.textContent || 'Report'} · Web Outcomes Benchmark`;
  const focusRow = main.querySelector('[data-focus]');
  if (focusRow) focusRow.scrollIntoView({ block: 'center' });
  const b = document.getElementById('banner');
  b.hidden = !(state.data.totals.demoCells > 0);
  if (!b.hidden) b.textContent = 'Demo data. These numbers are synthetic, generated to exercise the report. They say nothing about any real model.';
}

main.addEventListener('change', (e) => {
  const k = e.target.dataset?.filter;
  if (!k) return;
  state.filters[k] = e.target.value;
  if (location.hash.includes('?')) history.replaceState(null, '', location.hash.split('?')[0]);
  render();
});
let searchTimer = null;
main.addEventListener('input', (e) => {
  if (e.target.dataset?.filter !== 'q') return;
  state.filters.q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { await render(); const inp = main.querySelector('[data-filter="q"]'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }, 200);
});
window.addEventListener('hashchange', () => { render().then(() => { if (!main.querySelector('[data-focus]')) window.scrollTo(0, 0); }); });

(async function init() {
  const idx = await getJson('../runs/index.json');
  state.runs = idx?.runs || [];
  const sel = document.getElementById('run-select');
  sel.innerHTML = state.runs.length ? state.runs.map((r, i) => `<option value="${esc(r.runId)}">${esc(r.label)}${i === 0 ? ' (latest)' : ''}</option>`).join('') : '<option value="latest">Latest</option>';
  sel.closest('.run-pick').hidden = state.runs.length < 2;
  sel.addEventListener('change', async () => { await loadRun(sel.value); render(); });
  await loadRun(state.runs[0]?.runId || 'latest');
  render();
})();
