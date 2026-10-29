// Studio Frontend Application (Vanilla ES Module)
const VALID_VIEWS = new Set(['leaderboard', 'matrix', 'observatory', 'arena', 'methodology', 'run']);
const VIEW_ALIASES = {
  tech: 'observatory',
  runner: 'run',
  cleanroom: 'methodology',
};
const VALID_DIALOG_TABS = new Set(['overview', 'prompt', 'transcript', 'lighthouse', 'source']);

// Default sort directions when clicking a column for the first time
const DEFAULT_SORT_DIR = {
  label: 'asc',
  mode: 'asc',
  dominantStack: 'asc',
  cellsRun: 'desc',
  composite: 'desc',
  lighthouse: 'desc',
  uplift: 'desc',
  deepPerf: 'desc',
  memory: 'desc',
  functionalFlow: 'desc',
  mobileLcpMs: 'asc',
  inpMs: 'asc',
  burstP95TtfbMs: 'asc',
  baselineHeapMb: 'asc',
  generationMs: 'asc',
};

const state = {
  data: null,
  activeView: 'leaderboard',
  selectedMode: 'all',
  selectedCategory: 'all',
  leaderboardSortCol: 'composite',
  leaderboardSortDir: 'desc',
  lhCorpusFilter: 'all-failures',
  matrixCategory: 'all',
  matrixMetric: 'composite',
  selectedCohort: null,
  arenaPrompt: '',
  arenaModelA: '',
  arenaModelB: '',
  activeRunId: null,
  activeEventSource: null,
  inspectedCellId: null,
  inspectedCell: null,
  dialogTab: 'overview',
  lhCellFilter: 'all',
  transcriptFilter: 'all',
  transcriptQuery: '',
  suppressHashSync: false,
};

// Safe storage helpers (guards if Studio itself is ever embedded in a restricted context)
function safeGetStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key, val) {
  try {
    window.localStorage.setItem(key, val);
  } catch {
    // ignore storage errors
  }
}

// Modern Web Guidance mandatory fallback for <dialog closedby="any">
function installDialogLightDismissFallbacks() {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) dialog.close();
    });
  }
}

// Fallback for browsers where Invoker Commands (`commandfor`) isn't enabled yet
function installInvokerFallback() {
  if ('commandForElement' in HTMLButtonElement.prototype) return;
  const trigger = document.getElementById('weights-trigger-btn');
  const pop = document.getElementById('weights-popover');
  if (trigger && pop && typeof pop.togglePopover === 'function') {
    trigger.addEventListener('click', () => pop.togglePopover());
  }
}

function scoreClass(val) {
  if (val == null || Number.isNaN(val)) return 'score-na';
  if (val >= 85) return 'score-good';
  if (val >= 60) return 'score-warn';
  return 'score-bad';
}

function latencyClass(ms, goodMax, warnMax) {
  if (ms == null) return 'score-na';
  if (ms <= goodMax) return 'score-good';
  if (ms <= warnMax) return 'score-warn';
  return 'score-bad';
}

function fmtScore(val) {
  return val == null ? '—' : Number(val).toFixed(1).replace(/\.0$/, '');
}

function fmtMs(val) {
  if (val == null) return '—';
  return val >= 1000 ? `${(val / 1000).toFixed(2)}s` : `${Math.round(val)}ms`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function modeBadgeHtml(mode) {
  return mode === 'agent'
    ? `<span class="mode-badge mode-agent">Agent · pi</span>`
    : `<span class="mode-badge mode-oneshot">1-Shot</span>`;
}

async function copyCurrentUrlWithFeedback(btn) {
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const tmp = document.createElement('input');
    tmp.value = url;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    tmp.remove();
  }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = prev;
    }, 1400);
  }
}

// --- TWO-WAY LINKABLE HASH URL ROUTER ---------------------------------------

function buildHashString({
  view = state.activeView,
  mode = state.selectedMode,
  cat = state.selectedCategory,
  sortCol = state.leaderboardSortCol,
  sortDir = state.leaderboardSortDir,
  lhFilter = state.lhCorpusFilter,
  mcat = state.matrixCategory,
  metric = state.matrixMetric,
  cohort = state.selectedCohort,
  arenaPrompt = state.arenaPrompt,
  arenaA = state.arenaModelA,
  arenaB = state.arenaModelB,
  cellId = state.inspectedCellId,
  dtab = state.dialogTab,
} = {}) {
  const cleanView = VIEW_ALIASES[view] || (VALID_VIEWS.has(view) ? view : 'leaderboard');
  const params = new URLSearchParams();

  if (mode && mode !== 'all') params.set('mode', mode);

  if (cleanView === 'leaderboard') {
    if (cat && cat !== 'all') params.set('cat', cat);
    if (sortCol && (sortCol !== 'composite' || sortDir !== 'desc')) {
      params.set('sort', sortCol);
      params.set('dir', sortDir);
    }
    if (lhFilter && lhFilter !== 'all-failures') params.set('lh', lhFilter);
  } else if (cleanView === 'matrix') {
    if (mcat && mcat !== 'all') params.set('mcat', mcat);
    if (metric && metric !== 'composite') params.set('metric', metric);
  } else if (cleanView === 'observatory') {
    if (cohort) params.set('cohort', cohort);
  } else if (cleanView === 'arena') {
    if (arenaPrompt) params.set('prompt', arenaPrompt);
    if (arenaA) params.set('a', arenaA);
    if (arenaB) params.set('b', arenaB);
  }

  if (cellId) {
    params.set('cell', cellId);
    if (dtab && dtab !== 'overview') params.set('dtab', dtab);
  }

  const qs = params.toString();
  return `#/${cleanView}${qs ? `?${qs}` : ''}`;
}

function updateNavTabHrefs() {
  for (const link of document.querySelectorAll('.tab-btn[data-view]')) {
    const v = link.dataset.view;
    link.href = buildHashString({
      view: v,
      cellId: null,
    });
  }
}

function syncUrlFromState({ push = false } = {}) {
  if (state.suppressHashSync) return;
  updateNavTabHrefs();
  const nextHash = buildHashString();
  if (window.location.hash === nextHash) return;
  if (push) {
    window.history.pushState(null, '', nextHash);
  } else {
    window.history.replaceState(null, '', nextHash);
  }
}

function parseHashIntoState() {
  const raw = window.location.hash || '#/leaderboard';
  const stripped = raw.replace(/^#\/?/, '');
  const qIdx = stripped.indexOf('?');
  const rawView = (qIdx >= 0 ? stripped.slice(0, qIdx) : stripped).trim().toLowerCase() || 'leaderboard';
  const queryStr = qIdx >= 0 ? stripped.slice(qIdx + 1) : '';
  const params = new URLSearchParams(queryStr);

  const mappedView = VIEW_ALIASES[rawView] || (VALID_VIEWS.has(rawView) ? rawView : 'leaderboard');
  state.activeView = mappedView;

  const modeParam = params.get('mode');
  state.selectedMode = modeParam === 'agent' || modeParam === 'oneshot' ? modeParam : 'all';

  if (mappedView === 'leaderboard') {
    state.selectedCategory = params.get('cat') || 'all';
    const sortCol = params.get('sort');
    if (sortCol && sortCol in DEFAULT_SORT_DIR) {
      state.leaderboardSortCol = sortCol;
      const dir = params.get('dir');
      state.leaderboardSortDir = dir === 'asc' || dir === 'desc' ? dir : DEFAULT_SORT_DIR[sortCol];
    } else {
      state.leaderboardSortCol = 'composite';
      state.leaderboardSortDir = 'desc';
    }
    state.lhCorpusFilter = params.get('lh') || 'all-failures';
  } else if (mappedView === 'matrix') {
    state.matrixCategory = params.get('mcat') || 'all';
    state.matrixMetric = params.get('metric') || 'composite';
  } else if (mappedView === 'observatory') {
    state.selectedCohort = params.get('cohort') || null;
  } else if (mappedView === 'arena') {
    state.arenaPrompt = params.get('prompt') || state.arenaPrompt || '';
    state.arenaModelA = params.get('a') || state.arenaModelA || '';
    state.arenaModelB = params.get('b') || state.arenaModelB || '';
  }

  const cellParam = params.get('cell');
  const dtabParam = params.get('dtab');
  return {
    cellId: cellParam || null,
    dtab: VALID_DIALOG_TABS.has(dtabParam) ? dtabParam : 'overview',
  };
}

async function applyUrlStateToUi() {
  state.suppressHashSync = true;
  try {
    const { cellId, dtab } = parseHashIntoState();

    const modeSelect = document.getElementById('global-mode-select');
    if (modeSelect) modeSelect.value = state.selectedMode;

    const matCatSelect = document.getElementById('matrix-category-select');
    if (matCatSelect && Array.from(matCatSelect.options).some((o) => o.value === state.matrixCategory)) {
      matCatSelect.value = state.matrixCategory;
    }

    const matMetricSelect = document.getElementById('matrix-metric-select');
    if (matMetricSelect && Array.from(matMetricSelect.options).some((o) => o.value === state.matrixMetric)) {
      matMetricSelect.value = state.matrixMetric;
    }

    switchViewDom(state.activeView);
    renderLeaderboard();
    renderMatrix();
    renderTechObservatory();
    renderArenaSelectors();
    renderMethodology();

    const dialog = document.getElementById('cell-detail-dialog');
    if (cellId) {
      if (state.inspectedCellId !== cellId || !dialog.open) {
        await openCellInspectionDialog(cellId, dtab, { fromRouter: true });
      } else if (state.dialogTab !== dtab) {
        state.dialogTab = dtab;
        renderInspectedCellDialogTab();
      }
    } else if (dialog?.open) {
      state.inspectedCellId = null;
      dialog.close();
    }
  } finally {
    state.suppressHashSync = false;
    updateNavTabHrefs();
  }
}

function switchViewDom(viewName) {
  const cleanView = VIEW_ALIASES[viewName] || (VALID_VIEWS.has(viewName) ? viewName : 'leaderboard');
  state.activeView = cleanView;
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.view === cleanView);
  }
  for (const sec of document.querySelectorAll('.studio-view')) {
    sec.classList.toggle('hidden', sec.id !== `view-${cleanView}`);
    sec.classList.toggle('active', sec.id === `view-${cleanView}`);
  }
}

function switchView(viewName, { push = true } = {}) {
  const cleanView = VIEW_ALIASES[viewName] || (VALID_VIEWS.has(viewName) ? viewName : 'leaderboard');
  const apply = () => {
    switchViewDom(cleanView);
    syncUrlFromState({ push });
  };
  if (document.startViewTransition) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

async function fetchStudioState() {
  try {
    const res = await fetch('./api/state');
    if (res.ok) {
      state.data = await res.json();
      return;
    }
  } catch {
    // Fallback to static export JSON
  }
  const staticRes = await fetch('./api-static/state.json');
  state.data = await staticRes.json();
}

function renderHeaderKpis() {
  const el = document.getElementById('header-kpis');
  const d = state.data;
  if (!d) return;
  const readyCount = (d.models || []).filter((m) => m.ready).length;
  const totals = d.summary?.totals || {};
  const cellCount = totals.cells || 0;
  const agentCount = totals.agentCells || 0;
  const oneshotCount = totals.oneshotCells || 0;
  const canary = d.summary?.canary;
  const canaryBadge = canary
    ? `<span>Canary: <strong>${escapeHtml(String(canary.status || 'stable').toUpperCase())}</strong> (${canary.browserMainThreadComputeMs ?? canary.nodeCpuComputeMs ?? '—'}ms)</span>`
    : '';
  el.innerHTML = `
    <span>Prompts: <strong>${d.prompts.length}</strong> (${d.categories.length} cats)</span>
    <span>Models: <strong>${d.models.length}</strong> (${readyCount} live)</span>
    <span>Cells: <strong>${cellCount}</strong> (${agentCount} agent · ${oneshotCount} 1-shot)</span>
    ${canaryBadge}
  `;
}

// --- VIEW 1: LEADERBOARD & CORPUS LIGHTHOUSE PASSES/FAILURES ----------------

function getRowSortValue(row, col) {
  switch (col) {
    case 'label':
      return (row.label || row.modelKey || '').toLowerCase();
    case 'mode':
      return row.mode || '';
    case 'dominantStack':
      return (row.dominantStack || '').toLowerCase();
    case 'cellsRun':
      return row.cellsRun ?? null;
    case 'composite':
      return row.scores?.composite ?? null;
    case 'lighthouse':
      return row.scores?.lighthouse ?? null;
    case 'uplift':
      return row.scores?.uplift ?? null;
    case 'deepPerf':
      return row.scores?.deepPerf ?? null;
    case 'memory':
      return row.scores?.memory ?? null;
    case 'functionalFlow':
      return row.scores?.functionalFlow ?? null;
    case 'mobileLcpMs':
      return row.averages?.mobileLcpMs ?? null;
    case 'inpMs':
      return row.averages?.inpMs ?? null;
    case 'burstP95TtfbMs':
      return row.averages?.burstP95TtfbMs ?? null;
    case 'baselineHeapMb':
      return row.averages?.baselineHeapMb ?? null;
    case 'generationMs':
      return row.averages?.generationMs ?? null;
    default:
      return row.scores?.composite ?? null;
  }
}

function computeFilteredLeaderboard() {
  const summary = state.data?.summary;
  if (!summary) return [];

  const cat = state.selectedCategory;
  const modeFilter = state.selectedMode;
  let rows = summary.leaderboard
    .filter((r) => modeFilter === 'all' || r.mode === modeFilter)
    .map((r) => ({ ...r }));

  if (cat !== 'all') {
    const cells = (summary.cells || []).filter(
      (c) => c.category === cat && (modeFilter === 'all' || c.mode === modeFilter)
    );
    const byGroup = new Map();
    for (const c of cells) {
      const gk = `${c.modelKey}__${c.mode || 'oneshot'}`;
      if (!byGroup.has(gk)) byGroup.set(gk, []);
      byGroup.get(gk).push(c);
    }
    const avg = (arr) => {
      const v = arr.filter((x) => typeof x === 'number' && !Number.isNaN(x));
      return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
    };
    rows = [];
    for (const [gk, list] of byGroup.entries()) {
      const sample = list[0];
      const base =
        summary.leaderboard.find((x) => x.rowId === gk || (x.modelKey === sample.modelKey && x.mode === sample.mode)) || {
          rowId: gk,
          modelKey: sample.modelKey,
          mode: sample.mode || 'oneshot',
          label: sample.modelLabel || sample.modelKey,
          family: sample.family || '',
        };
      const built = list.filter((c) => c.buildSucceeded);
      const fwCounts = {};
      const beCounts = {};
      for (const c of list) {
        const fw = c.techStack?.primaryFramework || 'vanilla';
        const be = c.techStack?.primaryBackend || 'static-only';
        fwCounts[fw] = (fwCounts[fw] || 0) + 1;
        beCounts[be] = (beCounts[be] || 0) + 1;
      }
      const domFw = Object.entries(fwCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'vanilla';
      const domBe = Object.entries(beCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'static-only';
      const dominantStack = domBe !== 'static-only' ? `${domFw} + ${domBe}` : domFw;
      const reactCount = fwCounts.react || 0;
      const vanillaCount = fwCounts.vanilla || 0;

      rows.push({
        ...base,
        cellsRun: list.length,
        dominantStack,
        scores: {
          composite: avg(list.map((c) => c.scores.composite)) ?? 0,
          lighthouse: avg(built.map((c) => c.scores.lighthouse)),
          uplift: avg(built.map((c) => c.scores.uplift)),
          deepPerf: avg(built.map((c) => c.scores.deepPerf)),
          memory: avg(built.map((c) => c.scores.memory)),
          functionalFlow: avg(list.map((c) => c.scores.functionalFlow)),
        },
        averages: {
          ...base.averages,
          mobileLcpMs: avg(built.map((c) => c.keyMetrics.mobileLcpMs)),
          inpMs: avg(built.map((c) => c.keyMetrics.inpMs)),
          burstP95TtfbMs: avg(built.map((c) => c.keyMetrics.burstP95TtfbMs)),
          baselineHeapMb: avg(built.map((c) => c.keyMetrics.baselineHeapMb)),
          generationMs: avg(list.map((c) => c.generationMs)),
        },
        techDefaults: {
          ...base.techDefaults,
          reactSharePct: Math.round((reactCount / list.length) * 100),
          vanillaSharePct: Math.round((vanillaCount / list.length) * 100),
        },
      });
    }
  }

  const col = state.leaderboardSortCol;
  const dirMul = state.leaderboardSortDir === 'asc' ? 1 : -1;

  rows.sort((a, b) => {
    const va = getRowSortValue(a, col);
    const vb = getRowSortValue(b, col);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // Always push missing/null metrics to bottom
    if (vb == null) return -1;
    if (typeof va === 'string' && typeof vb === 'string') {
      const cmp = va.localeCompare(vb);
      if (cmp !== 0) return cmp * dirMul;
    } else if (va !== vb) {
      return (va < vb ? -1 : 1) * dirMul;
    }
    return (b.scores?.composite ?? 0) - (a.scores?.composite ?? 0);
  });

  return rows;
}

function updateLeaderboardSortHeaders() {
  const table = document.getElementById('leaderboard-table');
  if (!table) return;
  for (const th of table.querySelectorAll('th[data-th-col]')) {
    const col = th.dataset.thCol;
    const btn = th.querySelector('.th-sort-btn');
    const glyph = th.querySelector('.sort-glyph');
    const isSorted = col === state.leaderboardSortCol;
    th.setAttribute(
      'aria-sort',
      isSorted ? (state.leaderboardSortDir === 'asc' ? 'ascending' : 'descending') : 'none'
    );
    if (btn) btn.classList.toggle('sorted', isSorted);
    if (glyph) glyph.textContent = isSorted ? (state.leaderboardSortDir === 'asc' ? '↑' : '↓') : '↕';
  }
}

function renderCorpusLighthouseBreakdown() {
  const panel = document.getElementById('lighthouse-corpus-panel');
  const pillsEl = document.getElementById('lh-corpus-filter-pills');
  const bodyEl = document.getElementById('lighthouse-corpus-body');
  const lh = state.data?.summary?.lighthouseAuditBreakdown;

  if (!panel || !lh || !lh.cellsAudited) {
    panel?.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const failing = (lh.topFailingAudits || []).map((f) => {
    const cats = getAuditCategories(f);
    return { ...f, category: cats[0], categories: cats };
  });
  const passing = (lh.universalPassingAudits || []).map((p) => {
    const cats = getAuditCategories(p);
    return { ...p, category: cats[0], categories: cats };
  });
  const matchesCat = (item, cat) => (item.categories || [item.category]).includes(cat);

  const filters = [
    { id: 'all-failures', label: `All Failing Checks (${failing.length})` },
    { id: 'performance', label: `Perf Failures (${failing.filter((f) => matchesCat(f, 'performance')).length})` },
    { id: 'accessibility', label: `A11y Failures (${failing.filter((f) => matchesCat(f, 'accessibility')).length})` },
    { id: 'best-practices', label: `Best-Practice Failures (${failing.filter((f) => matchesCat(f, 'best-practices')).length})` },
    { id: 'seo', label: `SEO Failures (${failing.filter((f) => matchesCat(f, 'seo')).length})` },
    { id: 'universal-passes', label: `100% Universal Passes (${passing.length})` },
  ];

  pillsEl.innerHTML = filters
    .map(
      (f) =>
        `<button type="button" class="cat-pill ${state.lhCorpusFilter === f.id ? 'active' : ''}" data-lh-filter="${escapeHtml(f.id)}">${escapeHtml(f.label)}</button>`
    )
    .join('');

  for (const btn of pillsEl.querySelectorAll('[data-lh-filter]')) {
    btn.addEventListener('click', () => {
      state.lhCorpusFilter = btn.dataset.lhFilter;
      syncUrlFromState({ push: false });
      renderCorpusLighthouseBreakdown();
    });
  }

  if (state.lhCorpusFilter === 'universal-passes') {
    if (passing.length === 0) {
      bodyEl.innerHTML = `<p class="panel-sub">Re-run Lighthouse audits with <code>--benchmarks=lighthouse-uplift</code> to populate full pass telemetry.</p>`;
      return;
    }
    bodyEl.innerHTML = `
      <div class="table-surface">
        <table class="data-table lh-wrap-table">
          <thead>
            <tr>
              <th>Audit ID</th>
              <th class="col-wrap">Lighthouse Check Title</th>
              <th>Category</th>
              <th class="num">Passed Sites</th>
              <th class="num">Pass Rate</th>
            </tr>
          </thead>
          <tbody>
            ${passing
              .map(
                (p) => `
                <tr>
                  <td class="mono">${escapeHtml(p.id)}</td>
                  <td class="col-wrap"><strong>${escapeHtml(p.title)}</strong></td>
                  <td><span class="lh-audit-cat">${escapeHtml(p.category)}</span></td>
                  <td class="num mono">${p.passCount} / ${lh.cellsAudited}</td>
                  <td class="num"><span class="score-badge score-good">${p.passRatePct}% PASS</span></td>
                </tr>
              `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    return;
  }

  const filteredFails =
    state.lhCorpusFilter === 'all-failures'
      ? failing
      : failing.filter((f) => matchesCat(f, state.lhCorpusFilter));

  if (filteredFails.length === 0) {
    bodyEl.innerHTML = `<p class="panel-sub">Zero Lighthouse audit failures recorded in this category across ${lh.cellsAudited} audited sites.</p>`;
    return;
  }

  bodyEl.innerHTML = `
    <div class="table-surface">
      <table class="data-table lh-wrap-table">
        <thead>
          <tr>
            <th>Audit ID</th>
            <th class="col-wrap">Failing Lighthouse Check</th>
            <th>Category</th>
            <th class="num">Failed / Audited</th>
            <th class="num">Avg Score</th>
            <th class="col-wrap">Affected Sites (click to inspect)</th>
          </tr>
        </thead>
        <tbody>
          ${filteredFails
            .slice(0, 25)
            .map((f) => {
              const rateCls = f.failRatePct >= 40 ? 'score-bad' : f.failRatePct >= 15 ? 'score-warn' : 'score-na';
              return `
                <tr>
                  <td class="mono">${escapeHtml(f.id)}</td>
                  <td class="col-wrap"><strong>${escapeHtml(f.title)}</strong></td>
                  <td><span class="lh-audit-cat">${escapeHtml(f.category)}</span></td>
                  <td class="num"><span class="score-badge ${rateCls}">${f.failCount} / ${lh.cellsAudited} (${f.failRatePct}%)</span></td>
                  <td class="num mono">${f.avgFailScore != null ? f.avgFailScore : '0'}</td>
                  <td class="col-sites">
                    <div class="lh-chips-wrap">
                      ${(f.failingCells || [])
                        .slice(0, 8)
                        .map(
                          (fc) =>
                            `<button type="button" class="lh-site-chip score-warn" data-lh-cell="${escapeHtml(fc.cellId)}" title="${escapeHtml(`${fc.modelLabel} (${fc.mode}) — ${fc.promptTitle}${fc.displayValue ? ` · ${fc.displayValue}` : ''}`)}">${escapeHtml(fc.modelLabel)} · ${escapeHtml(fc.promptTitle.split(' ')[0])} [${fc.mode === 'agent' ? 'pi' : '1s'}]</button>`
                        )
                        .join('')}
                    </div>
                  </td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  for (const btn of bodyEl.querySelectorAll('[data-lh-cell]')) {
    btn.addEventListener('click', () => openCellInspectionDialog(btn.dataset.lhCell, 'lighthouse'));
  }
}

function renderLeaderboard() {
  const pillBar = document.getElementById('category-filter-bar');
  const cats = state.data?.categories || [];
  const modeCells = (state.data?.summary?.cells || []).filter(
    (c) => state.selectedMode === 'all' || c.mode === state.selectedMode
  );
  pillBar.innerHTML = [
    `<button type="button" class="cat-pill ${state.selectedCategory === 'all' ? 'active' : ''}" data-cat="all">All Categories (${modeCells.length})</button>`,
    ...cats.map((c) => {
      const count = modeCells.filter((x) => x.category === c.id).length;
      return `<button type="button" class="cat-pill ${state.selectedCategory === c.id ? 'active' : ''}" data-cat="${escapeHtml(c.id)}">${escapeHtml(c.label)} (${count})</button>`;
    }),
  ].join('');

  for (const btn of pillBar.querySelectorAll('.cat-pill')) {
    btn.addEventListener('click', () => {
      state.selectedCategory = btn.dataset.cat;
      syncUrlFromState({ push: false });
      renderLeaderboard();
    });
  }

  updateLeaderboardSortHeaders();

  const rows = computeFilteredLeaderboard();
  const emptyEl = document.getElementById('leaderboard-empty');
  const tableWrap = document.getElementById('leaderboard-table-wrap');
  const tbody = document.getElementById('leaderboard-tbody');

  if (rows.length === 0) {
    emptyEl.classList.remove('hidden');
    tableWrap.classList.add('hidden');
  } else {
    emptyEl.classList.add('hidden');
    tableWrap.classList.remove('hidden');

    tbody.innerHTML = rows
      .map((r, idx) => {
        const stackLabel =
          r.dominantStack ||
          (r.techDefaults?.reactSharePct >= r.techDefaults?.vanillaSharePct && r.techDefaults?.reactSharePct > 0
            ? `React ${r.techDefaults.reactSharePct}%`
            : `Vanilla ${r.techDefaults?.vanillaSharePct ?? 0}%`);
        const turnsMeta =
          r.mode === 'agent' && r.averages?.avgTurns != null
            ? ` · ${r.averages.avgTurns} turns`
            : '';
        const costMeta =
          r.averages?.avgCostUsd != null && r.averages.avgCostUsd > 0
            ? ` · ~$${r.averages.avgCostUsd.toFixed(3)}/site`
            : '';
        const genSecStr =
          r.averages?.generationMs != null
            ? `${(r.averages.generationMs / 1000).toFixed(1)}s`
            : '—';
        // Find top cell for this model+mode so clicking a row can inspect or jump to matrix
        const sampleCell = (state.data?.summary?.cells || []).find(
          (c) =>
            c.modelKey === r.modelKey &&
            c.mode === r.mode &&
            (state.selectedCategory === 'all' || c.category === state.selectedCategory)
        );
        const modelLinkHref = sampleCell
          ? buildHashString({ cellId: sampleCell.cellId, dtab: 'overview' })
          : buildHashString({ view: 'matrix', mode: r.mode, cellId: null });

        return `
          <tr>
            <td class="num"><strong>#${idx + 1}</strong></td>
            <td>
              <a href="${escapeHtml(modelLinkHref)}" class="cohort-link" data-open-cell="${escapeHtml(sampleCell?.cellId || '')}">
                <span>
                  <span class="model-cell-title">${escapeHtml(r.label)}</span>
                  <span class="model-cell-sub">${escapeHtml(r.family)}${escapeHtml(turnsMeta)}${escapeHtml(costMeta)}</span>
                </span>
              </a>
            </td>
            <td>${modeBadgeHtml(r.mode)}</td>
            <td class="num">${r.cellsRun}</td>
            <td class="num"><span class="score-badge ${scoreClass(r.scores.composite)}">${fmtScore(r.scores.composite)}</span></td>
            <td class="num"><span class="score-badge ${scoreClass(r.scores.lighthouse)}">${fmtScore(r.scores.lighthouse)}</span></td>
            <td class="num"><span class="score-badge ${scoreClass(r.scores.uplift)}">${fmtScore(r.scores.uplift)}</span></td>
            <td class="num"><span class="score-badge ${scoreClass(r.scores.deepPerf)}">${fmtScore(r.scores.deepPerf)}</span></td>
            <td class="num"><span class="score-badge ${scoreClass(r.scores.memory)}">${fmtScore(r.scores.memory)}</span></td>
            <td class="num">${r.scores.functionalFlow != null ? `${Math.round(r.scores.functionalFlow)}%` : '—'}</td>
            <td class="num"><span class="score-badge ${latencyClass(r.averages.mobileLcpMs, 2500, 4000)}">${fmtMs(r.averages.mobileLcpMs)}</span></td>
            <td class="num"><span class="score-badge ${latencyClass(r.averages.inpMs, 200, 500)}">${fmtMs(r.averages.inpMs)}</span></td>
            <td class="num"><span class="score-badge ${latencyClass(r.averages.burstP95TtfbMs, 120, 350)}">${fmtMs(r.averages.burstP95TtfbMs)}</span></td>
            <td class="num">${r.averages.baselineHeapMb != null ? `${r.averages.baselineHeapMb.toFixed(1)} MB` : '—'}</td>
            <td class="num mono">${genSecStr}</td>
            <td><span class="fw-tag">${escapeHtml(stackLabel)}</span></td>
          </tr>
        `;
      })
      .join('');

    for (const a of tbody.querySelectorAll('[data-open-cell]')) {
      a.addEventListener('click', (e) => {
        const cid = a.dataset.openCell;
        if (cid) {
          e.preventDefault();
          openCellInspectionDialog(cid, 'overview');
        }
      });
    }
  }

  // Paired Agent vs 1-Shot Head-to-Head panel
  const h2hPanel = document.getElementById('mode-head-to-head-panel');
  const h2hTbody = document.getElementById('mode-h2h-tbody');
  const pairs = state.data?.summary?.modeComparison?.pairedHeadToHead || [];
  if (pairs.length === 0) {
    h2hPanel.classList.add('hidden');
  } else {
    h2hPanel.classList.remove('hidden');
    h2hTbody.innerHTML = pairs
      .map((p) => {
        const deltaSign = p.deltaComposite > 0 ? `+${p.deltaComposite}` : `${p.deltaComposite}`;
        const deltaCls = p.deltaComposite >= 2 ? 'score-good' : p.deltaComposite <= -2 ? 'score-bad' : 'score-warn';
        const agentCellId = `${p.modelKey}__${p.promptId}__agent`;
        const oneshotCellId = `${p.modelKey}__${p.promptId}__oneshot`;
        return `
          <tr>
            <td><strong>${escapeHtml(p.modelLabel)}</strong></td>
            <td>${escapeHtml(p.promptTitle)}</td>
            <td class="num"><button type="button" class="matrix-cell-btn ${scoreClass(p.agentComposite)}" data-h2h-cell="${escapeHtml(agentCellId)}">${fmtScore(p.agentComposite)}</button></td>
            <td class="num"><button type="button" class="matrix-cell-btn ${scoreClass(p.oneshotComposite)}" data-h2h-cell="${escapeHtml(oneshotCellId)}">${fmtScore(p.oneshotComposite)}</button></td>
            <td class="num"><span class="score-badge ${deltaCls}">${deltaSign}</span></td>
            <td><span class="fw-tag">${escapeHtml(p.agentStack)}</span></td>
            <td><span class="fw-tag">${escapeHtml(p.oneshotStack)}</span></td>
            <td class="num mono">${fmtMs(p.agentLcpMs)} / ${fmtMs(p.agentInpMs)}</td>
            <td class="num mono">${fmtMs(p.oneshotLcpMs)} / ${fmtMs(p.oneshotInpMs)}</td>
            <td class="num mono">${p.agentTurns ?? '—'}</td>
          </tr>
        `;
      })
      .join('');
    for (const btn of h2hTbody.querySelectorAll('[data-h2h-cell]')) {
      btn.addEventListener('click', () => openCellInspectionDialog(btn.dataset.h2hCell, 'overview'));
    }
  }

  renderCorpusLighthouseBreakdown();
}

// --- VIEW 2: MATRIX ---------------------------------------------------------

function renderMatrix() {
  const wrap = document.getElementById('matrix-scroll-wrap');
  const summary = state.data?.summary;
  if (!summary || summary.cells.length === 0) {
    wrap.innerHTML = `<div class="panel-card"><p>No evaluated cells yet. Run a benchmark slice to populate the matrix.</p></div>`;
    return;
  }

  const catFilter = state.matrixCategory;
  const metric = state.matrixMetric;
  const modeFilter = state.selectedMode;
  const filteredCells = summary.cells.filter((c) => modeFilter === 'all' || c.mode === modeFilter);

  const prompts = state.data.prompts.filter(
    (p) =>
      (catFilter === 'all' || p.category === catFilter) &&
      filteredCells.some((c) => c.promptId === p.id)
  );
  const models = summary.leaderboard.filter((m) => modeFilter === 'all' || m.mode === modeFilter);

  const cellLookup = new Map();
  for (const c of filteredCells) {
    cellLookup.set(`${c.modelKey}__${c.promptId}__${c.mode || 'oneshot'}`, c);
  }

  let html = `<table class="matrix-table"><thead><tr><th>Model &amp; Track \\ Prompt</th>`;
  for (const p of prompts) {
    html += `<th title="${escapeHtml(p.prompt)}">${escapeHtml(p.title)}<span class="model-cell-sub">${escapeHtml(p.categoryLabel)}</span></th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const m of models) {
    html += `<tr><td><span class="model-cell-title">${escapeHtml(m.label)}</span> <span class="model-cell-sub">${m.mode === 'agent' ? 'Agent · pi' : '1-Shot'}</span></td>`;
    for (const p of prompts) {
      const lookupKey = `${m.modelKey}__${p.id}__${m.mode}`;
      const cell = cellLookup.get(lookupKey);
      if (!cell) {
        html += `<td><span class="score-badge score-na">—</span></td>`;
        continue;
      }
      if (!cell.buildSucceeded) {
        html += `<td><button type="button" class="matrix-cell-btn score-bad" data-cell="${escapeHtml(cell.cellId)}">FAIL</button></td>`;
        continue;
      }

      let label = '';
      let cls = 'score-na';
      let targetTab = 'overview';
      if (metric === 'framework') {
        const fw = cell.techStack?.primaryFramework || 'vanilla';
        const be = cell.techStack?.primaryBackend;
        label = be && be !== 'static-only' ? `${fw}+${be}` : fw;
        cls = be && be !== 'static-only' ? 'score-good' : fw === 'react' ? 'score-warn' : 'score-good';
      } else if (metric === 'lhFailures') {
        const fails = cell.keyMetrics?.lhFailedCount ?? cell.lighthouseAudits?.failedCount;
        const passes = cell.keyMetrics?.lhPassedCount ?? cell.lighthouseAudits?.passedCount;
        label = fails != null ? `${fails} fail / ${passes ?? 0} pass` : '—';
        cls = fails == null ? 'score-na' : fails === 0 ? 'score-good' : fails <= 2 ? 'score-warn' : 'score-bad';
        targetTab = 'lighthouse';
      } else if (metric === 'inpMs') {
        label = fmtMs(cell.keyMetrics.inpMs);
        cls = latencyClass(cell.keyMetrics.inpMs, 200, 500);
      } else if (metric === 'mobileLcpMs') {
        label = fmtMs(cell.keyMetrics.mobileLcpMs);
        cls = latencyClass(cell.keyMetrics.mobileLcpMs, 2500, 4000);
      } else if (metric === 'burstP95TtfbMs') {
        label = fmtMs(cell.keyMetrics.burstP95TtfbMs);
        cls = latencyClass(cell.keyMetrics.burstP95TtfbMs, 120, 350);
      } else if (metric === 'agentTurns') {
        label = cell.trajectory ? `${cell.trajectory.turnCount}t / ${cell.trajectory.totalToolCalls}c` : '1-shot';
        cls = cell.trajectory ? 'score-good' : 'score-na';
        targetTab = cell.trajectory ? 'transcript' : 'prompt';
      } else {
        const val = cell.scores[metric];
        label = metric === 'functionalFlow' && val != null ? `${Math.round(val)}%` : fmtScore(val);
        cls = scoreClass(val);
        if (metric === 'lighthouse') targetTab = 'lighthouse';
      }

      html += `<td><button type="button" class="matrix-cell-btn ${cls}" data-cell="${escapeHtml(cell.cellId)}" data-dtab="${targetTab}">${escapeHtml(label)}</button></td>`;
    }
    html += `</tr>`;
  }

  html += `</tbody></table>`;
  wrap.innerHTML = html;

  for (const btn of wrap.querySelectorAll('.matrix-cell-btn')) {
    btn.addEventListener('click', () =>
      openCellInspectionDialog(btn.dataset.cell, btn.dataset.dtab || 'overview')
    );
  }
}

// --- VIEW 3: DEFAULT TECH-STACK OBSERVATORY & COHORT DRILL-DOWN -------------

function filterCellsMatchingCohort(cells, cohortKey) {
  if (!cohortKey) return [];
  const idx = cohortKey.indexOf(':');
  if (idx < 0) return [];
  const kind = cohortKey.slice(0, idx);
  const val = cohortKey.slice(idx + 1);

  return cells.filter((c) => {
    if (!c.buildSucceeded) return false;
    if (state.selectedMode !== 'all' && c.mode !== state.selectedMode) return false;
    if (kind === 'mode') return c.mode === val;
    if (kind === 'framework') return (c.techStack?.primaryFramework || 'vanilla') === val;
    if (kind === 'backend') return (c.techStack?.primaryBackend || 'static-only') === val;
    if (kind === 'delivery') return (c.techStack?.deliveryPattern || '') === val;
    return false;
  });
}

function describeCohortKey(cohortKey) {
  if (!cohortKey) return '';
  const idx = cohortKey.indexOf(':');
  const kind = cohortKey.slice(0, idx);
  const val = cohortKey.slice(idx + 1);
  if (kind === 'mode') {
    return val === 'agent'
      ? 'Mode Cohort: Autonomous pi Agent Loop + Real $PORT Server'
      : 'Mode Cohort: Self-Contained 1-Shot Stream';
  }
  if (kind === 'framework') return `Frontend Framework Cohort: ${val}`;
  if (kind === 'backend') return `Backend Server Cohort: ${val}`;
  if (kind === 'delivery') return `Delivery Pattern Cohort: ${val}`;
  return cohortKey;
}

function renderCohortDrilldownPanel(cohorts) {
  const panel = document.getElementById('cohort-drilldown-panel');
  if (!panel) return;

  if (!state.selectedCohort) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const allCells = state.data?.summary?.cells || [];
  const matching = filterCellsMatchingCohort(allCells, state.selectedCohort).sort(
    (a, b) => (b.scores?.composite ?? 0) - (a.scores?.composite ?? 0)
  );
  const cohortMeta = cohorts.find((c) => c.cohortKey === state.selectedCohort);
  const title = cohortMeta?.label || describeCohortKey(state.selectedCohort);

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="cohort-header-row">
      <div>
        <h3 style="margin:0">${escapeHtml(title)} — ${matching.length} Matching Website${matching.length === 1 ? '' : 's'}</h3>
        <p class="panel-sub" style="margin:4px 0 0">
          Direct drill-down into every generated site in this cohort. Open any site's live preview, exact prompt, <code>pi</code> session transcript, or Lighthouse audit pass/fail list.
        </p>
      </div>
      <div class="mini-actions">
        <button type="button" id="close-cohort-drilldown-btn" class="btn btn-ghost">Clear Cohort Filter ✕</button>
      </div>
    </div>
    ${
      matching.length === 0
        ? `<p class="panel-sub">No built sites match <code>${escapeHtml(state.selectedCohort)}</code> under the current Track filter (${escapeHtml(state.selectedMode)}).</p>`
        : `<div class="cohort-sites-grid">
            ${matching
              .map((c) => {
                const stackStr =
                  c.techStack?.primaryBackend && c.techStack.primaryBackend !== 'static-only'
                    ? `${c.techStack.primaryFramework} + ${c.techStack.primaryBackend}`
                    : c.techStack?.primaryFramework || 'vanilla';
                const lhPass = c.keyMetrics?.lhPassedCount ?? c.lighthouseAudits?.passedCount ?? '—';
                const lhFail = c.keyMetrics?.lhFailedCount ?? c.lighthouseAudits?.failedCount ?? '—';
                const thumbHtml = c.hasDesktopScreenshot
                  ? `<img class="cohort-site-thumb" loading="lazy" src="./artifacts/${encodeURIComponent(c.cellId)}/screenshots/desktop.png" alt="${escapeHtml(`${c.modelLabel} ${c.promptTitle} screenshot`)}" />`
                  : '';
                return `
                  <div class="cohort-site-card">
                    ${thumbHtml}
                    <div class="cohort-site-body">
                      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
                        <h4 class="cohort-site-title">${escapeHtml(c.modelLabel)} — ${escapeHtml(c.promptTitle)}</h4>
                        <span class="score-badge ${scoreClass(c.scores.composite)}">${fmtScore(c.scores.composite)}</span>
                      </div>
                      <div class="cohort-site-meta">
                        ${modeBadgeHtml(c.mode)}
                        <span class="fw-tag">${escapeHtml(stackStr)}</span>
                        <span class="fw-tag">${escapeHtml(c.techStack?.primaryCss || 'css')}</span>
                        <span>${escapeHtml(c.categoryLabel)}</span>
                      </div>
                      <div class="cohort-site-kpis mono">
                        <div>LH: <strong>${fmtScore(c.scores.lighthouse)}</strong> (${lhFail}F/${lhPass}P)</div>
                        <div>LCP: <strong>${fmtMs(c.keyMetrics.mobileLcpMs)}</strong></div>
                        <div>INP: <strong>${fmtMs(c.keyMetrics.inpMs)}</strong></div>
                        <div>TTFB: <strong>${fmtMs(c.keyMetrics.burstP95TtfbMs)}</strong></div>
                        <div>Heap: <strong>${c.keyMetrics.baselineHeapMb ?? '—'} MB</strong></div>
                        <div>Flow: <strong>${Math.round(c.scores.functionalFlow ?? 0)}%</strong></div>
                      </div>
                      <div class="cohort-site-actions">
                        <button type="button" class="btn btn-primary" data-cohort-cell="${escapeHtml(c.cellId)}" data-dtab="overview">Inspect Site</button>
                        <button type="button" class="btn btn-secondary" data-cohort-cell="${escapeHtml(c.cellId)}" data-dtab="prompt">Prompt</button>
                        ${
                          c.mode === 'agent' || c.hasPiSession
                            ? `<button type="button" class="btn btn-secondary" data-cohort-cell="${escapeHtml(c.cellId)}" data-dtab="transcript">Transcript</button>`
                            : ''
                        }
                        <button type="button" class="btn btn-ghost" data-cohort-cell="${escapeHtml(c.cellId)}" data-dtab="lighthouse">LH Audits</button>
                      </div>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>`
    }
  `;

  document.getElementById('close-cohort-drilldown-btn')?.addEventListener('click', () => {
    state.selectedCohort = null;
    syncUrlFromState({ push: true });
    renderTechObservatory();
  });

  for (const btn of panel.querySelectorAll('[data-cohort-cell]')) {
    btn.addEventListener('click', () =>
      openCellInspectionDialog(btn.dataset.cohortCell, btn.dataset.dtab || 'overview')
    );
  }
}

function selectCohortAndDrillDown(cohortKey) {
  state.selectedCohort = state.selectedCohort === cohortKey ? null : cohortKey;
  syncUrlFromState({ push: true });
  renderTechObservatory();
  if (state.selectedCohort) {
    document.getElementById('cohort-drilldown-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderTechObservatory() {
  const summary = state.data?.summary;
  const modelBarsEl = document.getElementById('tech-model-bars');
  const backendBarsEl = document.getElementById('tech-backend-bars');
  const deliveryBarsEl = document.getElementById('tech-delivery-bars');
  const cohortTbody = document.getElementById('tech-cohort-tbody');

  if (!summary || summary.cells.length === 0) {
    modelBarsEl.innerHTML = `<p class="panel-sub">Run at least one benchmark cell to view default framework telemetry.</p>`;
    if (backendBarsEl) backendBarsEl.innerHTML = '';
    deliveryBarsEl.innerHTML = '';
    cohortTbody.innerHTML = '';
    return;
  }

  const lbRows = summary.leaderboard.filter(
    (m) => state.selectedMode === 'all' || m.mode === state.selectedMode
  );

  modelBarsEl.innerHTML = lbRows
    .map((m) => {
      const counts = m.techDefaults.frameworkCounts || {};
      const total = m.cellsRun || 1;
      const pct = (k) => Math.round(((counts[k] || 0) / total) * 100);
      const pVanilla = pct('vanilla');
      const pReact = pct('react') + pct('nextjs');
      const pVue = pct('vue');
      const pSvelte = pct('svelte');
      const pOther = Math.max(0, 100 - pVanilla - pReact - pVue - pSvelte);
      const tag = m.mode === 'agent' ? ' [pi]' : ' [1s]';

      return `
        <div class="stack-row">
          <strong title="${escapeHtml(m.label + tag)}">${escapeHtml(m.label)}${escapeHtml(tag)}</strong>
          <div class="stack-track" title="Vanilla: ${pVanilla}%, React: ${pReact}%, Vue: ${pVue}%, Svelte: ${pSvelte}%">
            <div class="stack-seg seg-vanilla" style="width:${pVanilla}%"></div>
            <div class="stack-seg seg-react" style="width:${pReact}%"></div>
            <div class="stack-seg seg-vue" style="width:${pVue}%"></div>
            <div class="stack-seg seg-svelte" style="width:${pSvelte}%"></div>
            <div class="stack-seg seg-other" style="width:${pOther}%"></div>
          </div>
          <span class="mono">${pReact > 0 ? `React ${pReact}%` : `Vanilla ${pVanilla}%`}</span>
        </div>
      `;
    })
    .join('');

  if (backendBarsEl) {
    const byBackend = summary.techObservatory?.byBackend || [];
    backendBarsEl.innerHTML = byBackend
      .map(
        (b) => `
        <div class="stack-row" style="cursor:pointer" data-bar-cohort="backend:${escapeHtml(b.backend)}" title="Click to drill down into Backend: ${escapeHtml(b.backend)}">
          <strong>${escapeHtml(b.backend)}</strong>
          <div class="stack-track">
            <div class="stack-seg ${b.backend === 'static-only' ? 'seg-other' : 'seg-vanilla'}" style="width:${b.sharePct}%"></div>
          </div>
          <span class="mono">${b.count} (${b.sharePct}%)</span>
        </div>
      `
      )
      .join('');
    for (const el of backendBarsEl.querySelectorAll('[data-bar-cohort]')) {
      el.addEventListener('click', () => selectCohortAndDrillDown(el.dataset.barCohort));
    }
  }

  const byDelivery = summary.techObservatory?.byDeliveryPattern || [];
  deliveryBarsEl.innerHTML = byDelivery
    .map(
      (d) => `
      <div class="stack-row" style="cursor:pointer" data-bar-cohort="delivery:${escapeHtml(d.deliveryPattern)}" title="Click to drill down into Delivery: ${escapeHtml(d.deliveryPattern)}">
        <strong>${escapeHtml(d.deliveryPattern)}</strong>
        <div class="stack-track">
          <div class="stack-seg ${d.deliveryPattern.includes('zero-dep') || d.deliveryPattern.includes('server') ? 'seg-vanilla' : 'seg-react'}" style="width:${d.sharePct}%"></div>
        </div>
        <span class="mono">${d.count} (${d.sharePct}%)</span>
      </div>
    `
    )
    .join('');
  for (const el of deliveryBarsEl.querySelectorAll('[data-bar-cohort]')) {
    el.addEventListener('click', () => selectCohortAndDrillDown(el.dataset.barCohort));
  }

  const cohorts = [
    ...(summary.modeComparison?.byMode || []).map((r) => ({
      cohortKey: `mode:${r.mode}`,
      label: `Mode: ${r.mode === 'agent' ? 'Agent Loop (pi + $PORT Server)' : '1-Shot Stream'}`,
      ...r,
    })),
    ...(summary.techObservatory?.byFramework || []).map((r) => ({
      cohortKey: `framework:${r.framework}`,
      label: `Frontend: ${r.framework}`,
      ...r,
    })),
    ...(summary.techObservatory?.byBackend || []).map((r) => ({
      cohortKey: `backend:${r.backend}`,
      label: `Backend: ${r.backend}`,
      ...r,
    })),
    ...(summary.techObservatory?.byDeliveryPattern || []).map((r) => ({
      cohortKey: `delivery:${r.deliveryPattern}`,
      label: `Delivery: ${r.deliveryPattern}`,
      ...r,
    })),
  ];

  cohortTbody.innerHTML = cohorts
    .map((c) => {
      const isSelected = state.selectedCohort === c.cohortKey;
      const href = buildHashString({
        view: 'observatory',
        cohort: isSelected ? null : c.cohortKey,
        cellId: null,
      });
      return `
        <tr class="cohort-row ${isSelected ? 'selected-cohort' : ''}" data-cohort-key="${escapeHtml(c.cohortKey)}">
          <td>
            <a class="cohort-link" href="${escapeHtml(href)}" data-cohort-link="${escapeHtml(c.cohortKey)}">
              <strong>${escapeHtml(c.label)}</strong>
            </a>
          </td>
          <td class="num"><strong>${c.count}</strong></td>
          <td class="num">${c.sharePct}%</td>
          <td class="num"><span class="score-badge ${scoreClass(c.avgComposite)}">${fmtScore(c.avgComposite)}</span></td>
          <td class="num">${fmtScore(c.avgLighthouse)}</td>
          <td class="num">${fmtScore(c.avgUplift)}</td>
          <td class="num">${fmtMs(c.avgMobileLcpMs)}</td>
          <td class="num">${fmtMs(c.avgInpMs)}</td>
          <td class="num">${fmtMs(c.avgBurstTtfbMs)}</td>
          <td class="num">${c.avgUnusedJsPct != null ? `${c.avgUnusedJsPct}%` : '—'}</td>
          <td class="num">${c.avgHeapMb != null ? `${c.avgHeapMb} MB` : '—'}</td>
          <td class="num">${c.avgDetachedDomLeaks ?? '—'}</td>
          <td>
            <a class="btn btn-ghost" href="${escapeHtml(href)}" data-cohort-link="${escapeHtml(c.cohortKey)}" style="padding:3px 9px;font-size:0.78rem">
              ${isSelected ? 'Hide Sites ▲' : `View ${c.count} site${c.count === 1 ? '' : 's'} →`}
            </a>
          </td>
        </tr>
      `;
    })
    .join('');

  for (const row of cohortTbody.querySelectorAll('.cohort-row')) {
    row.addEventListener('click', (e) => {
      e.preventDefault();
      selectCohortAndDrillDown(row.dataset.cohortKey);
    });
  }

  renderCohortDrilldownPanel(cohorts);
}

// --- VIEW 4: ARENA ----------------------------------------------------------

function renderArenaSelectors() {
  const promptSel = document.getElementById('arena-prompt-select');
  const modASel = document.getElementById('arena-model-a');
  const modBSel = document.getElementById('arena-model-b');
  const cells = state.data?.summary?.cells || [];

  const promptsWithCells = (state.data?.prompts || []).filter((p) => cells.some((c) => c.promptId === p.id));
  const listPrompts = promptsWithCells.length > 0 ? promptsWithCells : state.data?.prompts || [];

  promptSel.innerHTML = listPrompts
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title)} (${escapeHtml(p.categoryLabel)})</option>`)
    .join('');

  if (state.arenaPrompt && listPrompts.some((p) => p.id === state.arenaPrompt)) {
    promptSel.value = state.arenaPrompt;
  } else if (listPrompts.length > 0) {
    state.arenaPrompt = promptSel.value;
  }

  const models = state.data?.summary?.leaderboard || [];
  const modOptions = models
    .map((m) => {
      const val = `${m.modelKey}__${m.mode}`;
      const tag = m.mode === 'agent' ? 'Agent · pi' : '1-Shot';
      return `<option value="${escapeHtml(val)}">${escapeHtml(m.label)} [${tag}]</option>`;
    })
    .join('');
  modASel.innerHTML = modOptions;
  modBSel.innerHTML = modOptions;

  if (state.arenaModelA && Array.from(modASel.options).some((o) => o.value === state.arenaModelA)) {
    modASel.value = state.arenaModelA;
  }
  if (state.arenaModelB && Array.from(modBSel.options).some((o) => o.value === state.arenaModelB)) {
    modBSel.value = state.arenaModelB;
  } else if (models.length > 1) {
    modBSel.selectedIndex = 1;
  }

  state.arenaModelA = modASel.value;
  state.arenaModelB = modBSel.value;

  renderArenaComparison();
}

function renderArenaComparison() {
  const promptId = document.getElementById('arena-prompt-select').value;
  const modA = document.getElementById('arena-model-a').value;
  const modB = document.getElementById('arena-model-b').value;
  state.arenaPrompt = promptId;
  state.arenaModelA = modA;
  state.arenaModelB = modB;

  const promptObj = (state.data?.prompts || []).find((p) => p.id === promptId);
  const banner = document.getElementById('arena-prompt-banner');
  banner.innerHTML = promptObj
    ? `<strong>${escapeHtml(promptObj.categoryLabel)} — ${escapeHtml(promptObj.title)}:</strong> “${escapeHtml(promptObj.prompt)}”`
    : '';

  const grid = document.getElementById('arena-split-grid');
  const cells = state.data?.summary?.cells || [];

  const renderPane = (rowSelector) => {
    if (!rowSelector) return '';
    const [modelKey, mode] = rowSelector.split('__');
    const cell = cells.find(
      (c) => c.modelKey === modelKey && c.promptId === promptId && (c.mode || 'oneshot') === (mode || 'oneshot')
    );
    if (!cell) {
      return `<div class="arena-pane"><div class="panel-card"><p>No generated build yet for <code>${escapeHtml(rowSelector)}</code> on this prompt.</p></div></div>`;
    }
    const isLiveStudio = !state.data?.staticMode;
    const iframeSrc = isLiveStudio
      ? `./preview/${encodeURIComponent(cell.cellId)}/`
      : `./preview/${encodeURIComponent(cell.cellId)}/index.html`;
    const sandboxAttr = isLiveStudio
      ? 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'
      : 'allow-scripts allow-forms allow-modals allow-popups';
    const stackBadge =
      cell.techStack?.primaryBackend && cell.techStack.primaryBackend !== 'static-only'
        ? `${cell.techStack.primaryFramework} + ${cell.techStack.primaryBackend}`
        : cell.techStack?.primaryFramework || 'vanilla';

    return `
      <div class="arena-pane">
        <div class="arena-pane-header">
          <div>
            <strong>${escapeHtml(cell.modelLabel)}</strong>
            ${modeBadgeHtml(cell.mode)}
            <span class="fw-tag">${escapeHtml(stackBadge)}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="score-badge ${scoreClass(cell.scores.composite)}">Score ${fmtScore(cell.scores.composite)}</span>
            <button type="button" class="btn btn-ghost arena-inspect-btn" data-cell="${escapeHtml(cell.cellId)}" data-dtab="overview">Inspect</button>
            <button type="button" class="btn btn-ghost arena-inspect-btn" data-cell="${escapeHtml(cell.cellId)}" data-dtab="prompt">Prompt</button>
          </div>
        </div>
        <div class="arena-metrics-strip mono">
          <span>LCP: <strong>${fmtMs(cell.keyMetrics.mobileLcpMs)}</strong></span>
          <span>INP: <strong>${fmtMs(cell.keyMetrics.inpMs)}</strong></span>
          <span>TTFB: <strong>${fmtMs(cell.keyMetrics.burstP95TtfbMs)}</strong></span>
          <span>Flow: <strong>${Math.round(cell.scores.functionalFlow || 0)}%</strong></span>
          <span>Heap: <strong>${cell.keyMetrics.baselineHeapMb ?? '—'} MB</strong></span>
          <span>Leaks: <strong>${cell.keyMetrics.detachedDomDelta ?? 0} DOM</strong></span>
        </div>
        ${
          cell.buildSucceeded
            ? `<iframe class="arena-iframe" sandbox="${sandboxAttr}" src="${iframeSrc}" title="${escapeHtml(cell.modelLabel)} preview"></iframe>`
            : `<div class="panel-card"><p>Build failed: ${escapeHtml(cell.generationError || 'Unrunnable output')}</p></div>`
        }
      </div>
    `;
  };

  grid.innerHTML = renderPane(modA) + (modB && modB !== modA ? renderPane(modB) : '');
  for (const btn of grid.querySelectorAll('.arena-inspect-btn')) {
    btn.addEventListener('click', () =>
      openCellInspectionDialog(btn.dataset.cell, btn.dataset.dtab || 'overview')
    );
  }
}

// --- VIEW 5: METHODOLOGY, CLEAN-ROOM ENVIRONMENT & VISUAL CONSISTENCY -------

function renderMethodology() {
  const el = document.getElementById('methodology-content');
  if (!el) return;
  const cfg = state.data?.config || {};
  const cr = cfg.cleanRoomEnvironment || {};
  const gen = cfg.generation || {};
  const browser = cfg.browser || {};
  const piVersion = state.data?.piVersion || '0.85.1';
  const piRuntime = state.data?.piRuntime || state.data?.summary?.environment || {};
  const bridges = state.data?.providerBridges || state.data?.summary?.environment?.providerBridges || [];
  const canary = state.data?.summary?.canary || null;
  const nodeVersion = state.data?.nodeVersion || 'v22+';
  const piSourceLabel = piRuntime.source || piRuntime.piSource || 'local-npm-runtime';

  el.innerHTML = `
    <div class="methodology-grid">
      <article class="panel-card">
        <h3>1. Strict Clean-Room <code>pi</code> Harness Isolation</h3>
        <p class="panel-sub">Every model is evaluated inside an empty temporary workspace with <strong>zero skills, zero extensions, zero prompt templates, zero themes, and zero project/global context files</strong> so results reflect raw model priors rather than agent plugins.</p>
        <div class="table-surface">
          <table class="data-table">
            <tbody>
              <tr><td><strong>Harness Runtime</strong></td><td class="mono">pi CLI ${escapeHtml(piVersion)} (${escapeHtml(piSourceLabel)}) · Node ${escapeHtml(nodeVersion)}</td></tr>
              <tr><td><strong>Skills Loaded</strong></td><td><span class="score-badge score-good">0 (<code>--no-skills</code>)</span></td></tr>
              <tr><td><strong>Ambient Extensions / Plugins</strong></td><td><span class="score-badge score-good">0 (<code>--no-extensions</code>)</span></td></tr>
              <tr><td><strong>Subprocess Secret Scrubbing</strong></td><td><span class="score-badge score-good">Active (0 LLM keys in <code>$PORT</code> servers)</span></td></tr>
              <tr><td><strong>Prompt Templates &amp; Themes</strong></td><td><span class="score-badge score-good">0 (<code>--no-prompt-templates --no-themes</code>)</span></td></tr>
              <tr><td><strong>Context Files (AGENTS.md / CLAUDE.md)</strong></td><td><span class="score-badge score-good">0 (<code>--no-context-files</code>)</span></td></tr>
              <tr><td><strong>MCP Servers</strong></td><td><span class="score-badge score-good">0</span></td></tr>
              <tr><td><strong>Agent Loop Allowed Tools</strong></td><td class="mono">${escapeHtml((cr.agentAllowedTools || ['read', 'bash', 'edit', 'write']).join(', '))}</td></tr>
              <tr><td><strong>1-Shot Allowed Tools</strong></td><td class="mono">None (<code>--no-tools</code> / pure <code>pi-ai</code> stream)</td></tr>
            </tbody>
          </table>
        </div>
        <p class="panel-sub" style="margin-top:12px;margin-bottom:4px"><strong>Exact CLI Invocation Flags (Agent Mode):</strong></p>
        <pre class="code-viewer" style="max-height:110px">pi -p -a ${(cr.piIsolationFlags || ['--no-skills', '--no-extensions', '--no-prompt-templates', '--no-themes', '--no-context-files', '--tools read,bash,edit,write']).join(' ')} --thinking ${escapeHtml(gen.thinkingLevel || 'low')} --session &lt;cell&gt;/pi-session.jsonl &lt;prompt&gt;</pre>
      </article>

      <article class="panel-card">
        <h3>2. Two-Track Architecture: Why 1-Shot Uses One Self-Contained Document</h3>
        <p class="panel-sub">Comparing goal-oriented autonomous software engineering against single-pass code completion without artificial multi-file truncation failures.</p>
        <div class="form-stack">
          <div class="turn-card">
            <div class="turn-card-header">
              <strong>Track A — Autonomous <code>pi</code> Agent Loop + Real <code>$PORT</code> Server</strong>
              ${modeBadgeHtml('agent')}
            </div>
            <p style="margin:0;font-size:0.85rem;color:var(--ink-secondary)">
              ${escapeHtml(cr.modeDesignRationale?.agent || 'Runs multi-turn inside a fresh directory with read/bash/edit/write tools, scaffolds any frontend/backend architecture it chooses, builds a real HTTP server bound to $PORT, and self-verifies HTTP 200 responses before finishing.')}
            </p>
          </div>
          <div class="turn-card">
            <div class="turn-card-header">
              <strong>Track B — Self-Contained 1-Shot HTML Stream</strong>
              ${modeBadgeHtml('oneshot')}
            </div>
            <p style="margin:0;font-size:0.85rem;color:var(--ink-secondary)">
              ${escapeHtml(cr.modeDesignRationale?.oneshot || 'Single-pass completion with zero tools. Asking a 1-shot completion for multiple separate files frequently causes models to truncate mid-fence or emit root-relative /styles.css and /app.js links that 404 without a bundler. Requesting one self-contained HTML document with inline styles and scripts eliminates multi-file framing artifacts while leaving framework/CDN choices 100% unsteered.')}
            </p>
          </div>
        </div>
      </article>

      <article class="panel-card">
        <h3>3. Multimodal Reference Style Images for Cross-Model Visual Consistency</h3>
        <p class="panel-sub">Controlling for visual complexity when comparing Core Web Vitals, bundle weight, and memory usage across models.</p>
        <p style="font-size:0.86rem;line-height:1.6;margin-top:0">
          Without a visual anchor, one model may emit a sparse wireframe (artificially lowering LCP and DOM size) while another builds a rich editorial layout. Every prompt in the registry supports optional <code>referenceImages: [{ path, label }]</code>:
        </p>
        <ul style="font-size:0.84rem;line-height:1.6;color:var(--ink-secondary);padding-left:18px;margin-top:6px">
          <li><strong>Agent Mode (<code>pi</code> CLI):</strong> Reference images are copied into <code>.bench-reference/</code> and passed natively as multimodal <code>@file</code> attachments alongside the prompt.</li>
          <li><strong>1-Shot Mode (<code>pi-ai</code>):</strong> Reference images are base64-encoded into multimodal <code>{ type: "image", mimeType, data }</code> content blocks in the user message.</li>
          <li><strong>Zero Tech/Perf Steering:</strong> Reference image labels and instructions are validated against the exact same banned-keyword rules (no mentions of frameworks, Lighthouse, CWV, or speed).</li>
        </ul>
        <p class="panel-sub" style="margin-bottom:4px"><strong>Verbatim Visual Reference Instruction (appended only when reference images are attached):</strong></p>
        <div class="prompt-verbatim-box">${escapeHtml(gen.visualReferenceInstruction || '')}</div>
      </article>

      <article class="panel-card">
        <h3>4. Verbatim System Contracts &amp; Audit Conditions</h3>
        <p class="panel-sub">Every word sent to every model is audited by <code>npm run validate</code> to guarantee zero mentions of React, Vanilla, Tailwind, speed, Lighthouse, or memory.</p>
        <p class="panel-sub" style="margin-bottom:4px"><strong>1-Shot System Prompt:</strong></p>
        <div class="prompt-verbatim-box">${escapeHtml(gen.neutralSystemPrompt || '')}</div>
        <p class="panel-sub" style="margin-bottom:4px"><strong>Agent Mode Workspace Deployment Contract:</strong></p>
        <pre class="code-viewer" style="max-height:165px">${escapeHtml(gen.agentWorkspaceContract || '')}</pre>
        <p class="mono" style="font-size:0.78rem;color:var(--ink-secondary);margin-top:10px;margin-bottom:0">
          Mobile CWV/INP Emulation: ${browser.viewportMobile?.width || 390}×${browser.viewportMobile?.height || 844} · ${browser.mobileThrottle?.cpuSlowdownMultiplier || 4}× CPU slowdown · ${browser.mobileThrottle?.latencyMs || 150}ms RTT · ${browser.mobileThrottle?.downloadThroughputKbps || 1638.4} Kbps down · Isolated ephemeral preview origin per cell · ${cfg.memory?.leakLoopIterations || 10}× do/undo MemLab heap cycles.
        </p>
      </article>

      <article class="panel-card">
        <h3>5. Portable npm <code>pi</code> Bootstrap &amp; Clean-Room Provider Bridges</h3>
        <p class="panel-sub">Run identically on fresh cloud VMs, containers, or CI runners without pre-installing global <code>pi</code> — while bridging transport to Claude, Codex, Antigravity, or Muse without leaking capability skills.</p>
        <div class="table-surface">
          <table class="data-table lh-wrap-table">
            <thead>
              <tr>
                <th>Bridge ID</th>
                <th>Providers</th>
                <th>Status &amp; Source</th>
              </tr>
            </thead>
            <tbody>
              ${
                bridges.length > 0
                  ? bridges
                      .map((b) => {
                        const pill = b.installed
                          ? `<span class="score-badge score-good">INSTALLED (${escapeHtml(b.version || 'local')})</span>`
                          : b.builtInAuthSupported
                            ? `<span class="score-badge score-mid">BUILT-IN AUTH</span>`
                            : `<span class="fw-tag">OPTIONAL</span>`;
                        return `
                          <tr>
                            <td class="mono"><strong>${escapeHtml(b.id)}</strong></td>
                            <td class="mono">${escapeHtml((b.providers || []).join(', '))}</td>
                            <td class="col-wrap">${pill} <span class="model-cell-sub">${escapeHtml(b.source || '')}</span></td>
                          </tr>
                        `;
                      })
                      .join('')
                  : `<tr><td colspan="3" class="col-wrap">Run <code>npm run bridges:list</code> to inspect configured provider bridges.</td></tr>`
              }
            </tbody>
          </table>
        </div>
        <p class="panel-sub" style="margin-top:12px;margin-bottom:4px"><strong>Portable VM &amp; Bridge Commands:</strong></p>
        <pre class="code-viewer" style="max-height:115px"># Bootstrap portable .pi-runtime + pinned Chrome for Testing on any VM:
npm run setup:vm -- --with-chrome

# Install clean-room provider transport bridges (-e entrypoint + --no-extensions):
npm run bridges:install -- antigravity
npm run bridges:install -- claude-bridge ./path/to/claude-ext
npm run bridges:install -- muse git+https://github.com/org/pi-muse.git</pre>
      </article>

      <article class="panel-card">
        <h3>6. Split CI / GitHub Actions Architecture &amp; Host Canary Calibration</h3>
        <p class="panel-sub">Separating CPU-light parallel LLM generation from airgapped, single-concurrency Chrome CWV/INP/MemLab auditing with median-of-N variance control.</p>
        ${
          canary
            ? `<div class="table-surface" style="margin-bottom:12px">
                <table class="data-table">
                  <tbody>
                    <tr><td><strong>Host Canary Status</strong></td><td><span class="score-badge ${canary.noisyEnvironment ? 'score-poor' : 'score-good'}">${escapeHtml(String(canary.status || 'stable').toUpperCase())}</span></td></tr>
                    <tr><td><strong>CPU &amp; Memory</strong></td><td class="mono">${escapeHtml(canary.host?.cpuModel || 'unknown')} (${canary.host?.cpuCores ?? '?'} cores · ${canary.host?.totalMemGb ?? '?'} GB RAM)</td></tr>
                    <tr><td><strong>Node / Chrome Baselines</strong></td><td class="mono">Node CPU: ${canary.nodeCpuComputeMs ?? '—'}ms · Chrome Layout+JS: ${canary.browserMainThreadComputeMs ?? '—'}ms · Ref FCP: ${canary.referenceFcpMs != null ? `${canary.referenceFcpMs}ms` : '—'}</td></tr>
                    <tr><td><strong>Calibrated Chrome</strong></td><td class="mono">${escapeHtml(canary.host?.chromeVersion || 'Headless Chrome')}</td></tr>
                  </tbody>
                </table>
              </div>`
            : `<p class="panel-sub">Run <code>npm run canary</code> or an audit pass to record host hardware calibration.</p>`
        }
        <pre class="code-viewer" style="max-height:115px"># Stage 1 (Cheap parallel cloud workers, secrets scoped per provider, zero Chrome):
npm run bench:generate -- --pilot --mode=agent

# Stage 2 (Dedicated runner, ZERO LLM secrets, Canary + Median-of-3 browser audits):
npm run bench:audit -- --pilot --audit-runs=3 --markdown-summary=summary.md</pre>
      </article>
    </div>
  `;
}

// --- VIEW 6: SELECTIVE RUNNER -----------------------------------------------

function renderRunnerControls() {
  const isStatic = Boolean(state.data?.staticMode);
  document.getElementById('static-mode-notice').classList.toggle('hidden', !isStatic);
  document.getElementById('launch-run-btn').disabled = isStatic;

  const modelsList = document.getElementById('runner-models-list');
  modelsList.innerHTML = (state.data?.models || [])
    .map(
      (m) => `
      <label class="model-check-card ${m.ready ? '' : 'unready'}" for="chk-model-${escapeHtml(m.key)}">
        <input type="checkbox" id="chk-model-${escapeHtml(m.key)}" name="modelKey" value="${escapeHtml(m.key)}" ${m.pilot && m.ready ? 'checked' : ''} />
        <div>
          <strong>${escapeHtml(m.label)}</strong>
          <span class="model-cell-sub">${escapeHtml(m.family)} · ${m.ready ? `✓ ${escapeHtml(m.activeProvider)}` : 'Missing API key'}</span>
        </div>
      </label>
    `
    )
    .join('');

  const promptsAcc = document.getElementById('runner-prompts-list');
  const byCat = new Map();
  for (const p of state.data?.prompts || []) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }

  promptsAcc.innerHTML = (state.data?.categories || [])
    .map((cat, idx) => {
      const items = byCat.get(cat.id) || [];
      return `
        <details class="prompts-Accordion-group" ${idx < 2 ? 'open' : ''}>
          <summary>${escapeHtml(cat.label)} (${items.length})</summary>
          <div class="prompt-group-items">
            ${items
              .map(
                (p) => `
                <label class="check-item" for="chk-prompt-${escapeHtml(p.id)}" title="${escapeHtml(p.prompt)}">
                  <input type="checkbox" id="chk-prompt-${escapeHtml(p.id)}" name="promptId" value="${escapeHtml(p.id)}" ${p.pilot ? 'checked' : ''} />
                  <span>${escapeHtml(p.title)}${p.requiresAuth ? ' 🔒' : ''}${(p.referenceImages || []).length ? ' 🖼' : ''}</span>
                </label>
              `
              )
              .join('')}
          </div>
        </details>
      `;
    })
    .join('');

  const benchList = document.getElementById('runner-benchmarks-list');
  benchList.innerHTML = (state.data?.benchmarks || [])
    .map(
      (b) => `
      <label class="model-check-card" for="chk-bench-${escapeHtml(b.id)}">
        <input type="checkbox" id="chk-bench-${escapeHtml(b.id)}" name="benchmarkId" value="${escapeHtml(b.id)}" checked />
        <div><strong>${escapeHtml(b.label)}</strong><span class="model-cell-sub">${escapeHtml(b.id)}</span></div>
      </label>
    `
    )
    .join('');

  const updateEstimate = () => {
    const mCount = document.querySelectorAll('input[name="modelKey"]:checked').length;
    const pCount = document.querySelectorAll('input[name="promptId"]:checked').length;
    const bCount = document.querySelectorAll('input[name="benchmarkId"]:checked').length;
    const modeVal = document.getElementById('opt-gen-mode')?.value || 'agent';
    const mult = modeVal === 'both' ? 2 : 1;
    const modeDesc = modeVal === 'both' ? ' × 2 tracks (agent + oneshot)' : ` (${modeVal})`;
    document.getElementById('run-scope-estimate').textContent = `${mCount} models × ${pCount} prompts${modeDesc} = ${mCount * pCount * mult} cells (${bCount} pillars)`;
  };

  const form = document.getElementById('runner-form');
  if (!form.dataset.boundEstimate) {
    form.addEventListener('change', updateEstimate);
    form.dataset.boundEstimate = '1';
  }
  updateEstimate();
}

async function launchSelectiveRun(payload) {
  const logEl = document.getElementById('sse-log-output');
  const statusBadge = document.getElementById('run-status-badge');
  const dot = document.getElementById('live-run-indicator');
  const cancelBtn = document.getElementById('cancel-run-btn');

  logEl.textContent = `[${new Date().toLocaleTimeString()}] Submitting benchmark job...\n`;
  statusBadge.textContent = 'Running';
  dot.classList.remove('hidden');
  cancelBtn.classList.remove('hidden');

  const res = await fetch('./api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const { runId, error } = await res.json();
  if (!res.ok) {
    logEl.textContent += `Error starting job: ${error}\n`;
    statusBadge.textContent = 'Error';
    dot.classList.add('hidden');
    return;
  }

  state.activeRunId = runId;
  if (state.activeEventSource) state.activeEventSource.close();
  const es = new EventSource(`./api/runs/${encodeURIComponent(runId)}/events`);
  state.activeEventSource = es;

  es.onmessage = async (evt) => {
    const item = JSON.parse(evt.data);
    if (item.type === 'job:start') {
      logEl.textContent += `Started ${item.jobId} (stage=${item.stage || 'all'}, auditRuns=${item.auditRuns || 1}): ${item.totalCells} cells (${item.models.join(', ')})\n`;
    } else if (item.type === 'job:canary-done') {
      logEl.textContent += `  [canary] ${String(item.canary?.status || '').toUpperCase()} — Node ${item.canary?.nodeCpuComputeMs}ms · Chrome ${item.canary?.browserMainThreadComputeMs ?? '—'}ms\n`;
    } else if (item.type === 'cell:stage') {
      logEl.textContent += `  [${item.cellId}] (${item.stage}) ${item.detail}\n`;
    } else if (item.type === 'cell:done') {
      logEl.textContent += item.ok
        ? `  ✓ [${item.cellId}] Completed\n`
        : `  ✗ [${item.cellId}] Failed: ${item.error}\n`;
    } else if (item.type === 'job:done') {
      logEl.textContent += `\nJob finished: ${item.completedCells} succeeded, ${item.failedCells} failed.\n`;
      statusBadge.textContent = 'Completed';
      dot.classList.add('hidden');
      cancelBtn.classList.add('hidden');
      es.close();
      await fetchStudioState();
      renderAll();
    } else if (item.type === 'job:error') {
      logEl.textContent += `\nJob error: ${item.error}\n`;
      statusBadge.textContent = 'Failed';
      dot.classList.add('hidden');
      cancelBtn.classList.add('hidden');
      es.close();
    }
    logEl.scrollTop = logEl.scrollHeight;
  };
}

// --- CELL DEEP-DIVE DIALOG (5 SUB-TABS) -------------------------------------

function renderDialogSubtabs(detail, summaryCell) {
  const tabsNav = document.getElementById('cell-dialog-tabs');
  if (!tabsNav) return;

  const cellId = detail.cellId;
  const cellMode = detail.generation?.mode === 'agent' || cellId.endsWith('__agent') ? 'agent' : 'oneshot';
  const lhu = detail.benchmarks?.['lighthouse-uplift']?.lighthouse?.mobile;
  const failCount = lhu?.auditCounts?.failed ?? (lhu?.failingAudits || []).length;
  const passCount = lhu?.auditCounts?.passed ?? (lhu?.passedAudits || []).length;
  const turnCount = detail.transcriptTimeline?.turnCount ?? detail.trajectory?.turnCount ?? null;
  const fileCount = (detail.extractedFiles || []).length;

  const tabs = [
    { id: 'overview', label: '1. Live Preview & Telemetry' },
    { id: 'prompt', label: '2. Exact Prompt & Clean-Room Env' },
    {
      id: 'transcript',
      label:
        cellMode === 'agent'
          ? `3. Agent Transcript (${turnCount != null ? `${turnCount} turns` : 'pi'})`
          : '3. Raw 1-Shot Output',
    },
    {
      id: 'lighthouse',
      label: lhu ? `4. Lighthouse Audits (${failCount} fail · ${passCount} pass)` : '4. Lighthouse Audits',
    },
    { id: 'source', label: `5. Source Files (${fileCount})` },
  ];

  tabsNav.innerHTML = tabs
    .map((t) => {
      const href = buildHashString({ cellId, dtab: t.id });
      return `<a href="${escapeHtml(href)}" class="dialog-subtab ${state.dialogTab === t.id ? 'active' : ''}" data-dtab="${t.id}">${escapeHtml(t.label)}</a>`;
    })
    .join('');

  for (const link of tabsNav.querySelectorAll('[data-dtab]')) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      state.dialogTab = link.dataset.dtab;
      syncUrlFromState({ push: false });
      renderInspectedCellDialogTab();
    });
  }
}

function renderCellOverviewTab(detail, summaryCell) {
  const body = document.getElementById('cell-dialog-body');
  const cellId = detail.cellId;
  const isLiveStudio = !state.data?.staticMode;
  const isProdServer = !state.data?.staticMode && detail.materialization?.serverArchitecture === 'production-server';
  const previewHref = isLiveStudio
    ? detail.livePreviewUrl || `./preview/${encodeURIComponent(cellId)}/`
    : `./preview/${encodeURIComponent(cellId)}/index.html`;
  const sandboxAttr = isLiveStudio
    ? 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'
    : 'allow-scripts allow-forms allow-modals allow-popups';

  const dp = detail.benchmarks?.['deep-perf'];
  const srv = dp?.serverTelemetry;
  const mem = detail.benchmarks?.memory;
  const lhu = detail.benchmarks?.['lighthouse-uplift'];
  const tech = detail.benchmarks?.['tech-stack'];
  const traj = detail.trajectory;

  const inpB = dp?.journey?.inpBreakdown;
  const inpTotal = Math.max(1, inpB?.duration || 1);
  const pDelay = inpB ? Math.round((inpB.inputDelayMs / inpTotal) * 100) : 0;
  const pProc = inpB ? Math.round((inpB.processingDurationMs / inpTotal) * 100) : 0;
  const pPres = Math.max(0, 100 - pDelay - pProc);

  const outcomes = lhu?.uplift?.outcomes || {};
  const habits = traj?.engineeringHabits || {};
  const habitBadges = traj
    ? [
        `<span class="habit-pill ${habits.selfVerifiedServer ? 'score-good' : 'score-warn'}">${habits.selfVerifiedServer ? '✓ Self-Tested HTTP Server' : '○ Did Not Self-Curl Server'}</span>`,
        `<span class="habit-pill ${habits.spontaneousPerfAttention ? 'score-good' : 'score-na'}">${habits.spontaneousPerfAttention ? '✓ Spontaneous Perf Hygiene' : '○ Zero Unprompted Perf Checks'}</span>`,
        `<span class="habit-pill ${detail.materialization?.contractCompliance ? 'score-good' : 'score-warn'}">${detail.materialization?.contractCompliance ? '✓ .bench-runtime.json Contract' : 'Inferred Entrypoint'}</span>`,
      ].join('')
    : '';

  const lhMobile = lhu?.lighthouse?.mobile;
  const lhFails = lhMobile?.auditCounts?.failed ?? (lhMobile?.failingAudits || []).length;
  const lhPasses = lhMobile?.auditCounts?.passed ?? (lhMobile?.passedAudits || []).length;

  body.innerHTML = `
    <div class="gauge-row">
      <div class="mini-gauge"><div class="val">${fmtScore(summaryCell?.scores?.composite)}</div><div class="lbl">Composite</div></div>
      <div class="mini-gauge" style="cursor:pointer" data-jump-dtab="lighthouse" title="View Lighthouse Pass/Fail Audits">
        <div class="val">${fmtScore(summaryCell?.scores?.lighthouse)}</div>
        <div class="lbl">Lighthouse (${lhFails}F/${lhPasses}P)</div>
      </div>
      <div class="mini-gauge"><div class="val">${fmtScore(summaryCell?.scores?.uplift)}</div><div class="lbl">web-uplift</div></div>
      <div class="mini-gauge"><div class="val">${fmtMs(dp?.mobileLoad?.vitals?.lcpMs)}</div><div class="lbl">Mobile LCP (Slow-4G)</div></div>
      <div class="mini-gauge"><div class="val">${fmtMs(dp?.journey?.inpMs)}</div><div class="lbl">W3C INP (4× CPU)</div></div>
      <div class="mini-gauge"><div class="val">${fmtMs(srv?.burstP95TtfbMs ?? srv?.singleTtfbMs)}</div><div class="lbl">Burst P95 TTFB</div></div>
      <div class="mini-gauge"><div class="val">${summaryCell?.keyMetrics?.baselineHeapMb ?? '—'} MB</div><div class="lbl">Client Heap</div></div>
      <div class="mini-gauge"><div class="val">${mem?.interactionLeakTest?.snapshotDiff?.detachedDomDelta ?? 0}</div><div class="lbl">Detached DOM Δ</div></div>
    </div>

    <div class="detail-grid-2">
      <div>
        <h3>Interactive Live Preview ${isProdServer ? '<span class="mode-badge mode-agent">Live $PORT Production Server</span>' : '<span class="mode-badge mode-oneshot">Isolated Ephemeral Origin</span>'}</h3>
        <div class="preview-frame-box">
          ${
            detail.materialization?.ok
              ? state.data?.staticMode && detail.materialization?.serverArchitecture === 'production-server' && summaryCell?.hasDesktopScreenshot
                ? `<img src="./artifacts/${encodeURIComponent(cellId)}/screenshots/desktop.png" alt="Captured desktop preview" style="width:100%;display:block" />`
                : `<iframe sandbox="${sandboxAttr}" src="${escapeHtml(previewHref)}" title="Live generated webpage"></iframe>`
              : `<div class="panel-card"><p>Materialization failed: ${escapeHtml(detail.materialization?.error || 'Unknown error')}</p></div>`
          }
        </div>

        <h3 class="mt-lg">Default Full-Stack &amp; Server Telemetry</h3>
        <div class="panel-card">
          <p class="mono" style="margin:0;font-size:0.81rem">
            Frontend: <strong>${escapeHtml(tech?.primaryFramework || 'n/a')}</strong> ·
            Backend: <strong>${escapeHtml(tech?.primaryBackend || 'static-only')}</strong> ·
            CSS: <strong>${escapeHtml(tech?.primaryCss || 'n/a')}</strong><br/>
            Persistence: <strong>${escapeHtml((tech?.staticAnalysis?.persistenceApis || []).join(', ') || 'none')}</strong> ·
            Delivery: <strong>${escapeHtml(tech?.deliveryPattern || 'n/a')}</strong> ·
            Unused JS: <strong>${dp?.mobileLoad?.coverage?.unusedJsPct ?? '—'}%</strong>
            ${
              (dp?.mobileLoad?.network?.brokenCriticalSubresourceCount || 0) > 0
                ? `<br/><span class="score-bad" style="display:inline-block;padding:2px 6px;border-radius:4px;margin-top:4px">⚠ Missing Critical Subresources (${dp.mobileLoad.network.brokenCriticalSubresourceCount}): ${escapeHtml(
                    (dp.mobileLoad.network.brokenCriticalSubresources || [])
                      .map((b) => `${b.type} ${b.path} (${b.status})`)
                      .join(', ')
                  )}</span>`
                : ''
            }
            ${
              srv
                ? `<br/>Cold Boot: <strong>${fmtMs(srv.coldBootMs)}</strong> ·
                   Single / 10× P95 TTFB: <strong>${fmtMs(srv.singleTtfbMs)} / ${fmtMs(srv.burstP95TtfbMs)}</strong> ·
                   Server RSS: <strong>${srv.loadServerRssMb ? `${srv.loadServerRssMb} MB` : 'static'}</strong><br/>
                   Compression: <strong>${escapeHtml(srv.contentEncoding || 'none')}</strong> ·
                   SSR Words: <strong>${srv.ssrWordCount ?? 0}</strong> ·
                   /api Waterfalls: <strong>${dp?.mobileLoad?.network?.apiWaterfallCount ?? 0} load / ${dp?.journey?.journeyApiRequestCount ?? 0} journey</strong>`
                : ''
            }
          </p>
        </div>

        <div class="panel-card mt-lg">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <strong>Exact Prompt Summary</strong>
            <button type="button" class="btn btn-secondary" data-jump-dtab="prompt" style="padding:4px 10px;font-size:0.78rem">View Full Prompt &amp; Clean-Room Spec →</button>
          </div>
          <p style="margin:8px 0 0;font-size:0.86rem;color:var(--ink-secondary)">“${escapeHtml(detail.exactPrompt?.userPrompt || detail.promptEntry?.prompt || '')}”</p>
        </div>
      </div>

      <div>
        ${
          traj
            ? `<h3>Autonomous <code>pi</code> Agent Trajectory</h3>
               <div class="panel-card" style="margin-bottom:18px">
                 <p class="mono" style="margin:0;font-size:0.81rem">
                   Turns: <strong>${traj.turnCount}</strong> ·
                   Tool Calls: <strong>${traj.totalToolCalls}</strong> (${escapeHtml(
                     Object.entries(traj.toolCallCounts || {})
                       .map(([k, v]) => `${k}:${v}`)
                       .join(', ')
                   )}) ·
                   Errors: <strong>${traj.toolErrorCount ?? 0}</strong><br/>
                   Thinking: <strong>${traj.thinkingBlockCount ?? 0} blocks</strong> (${(traj.thinkingChars || 0).toLocaleString()} chars) ·
                   Files Touched: <strong>${traj.filesTouchedCount ?? 0}</strong> ·
                   Cost: <strong>${traj.usage?.costUsd != null ? `$${traj.usage.costUsd.toFixed(4)}` : '—'}</strong>
                 </p>
                 <div class="habit-row">${habitBadges}</div>
                 <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
                   <button type="button" class="btn btn-primary" data-jump-dtab="transcript">Open Turn-by-Turn Transcript Viewer →</button>
                   <button type="button" class="btn btn-secondary" data-jump-dtab="lighthouse">Lighthouse Audits (${lhFails} fail / ${lhPasses} pass)</button>
                 </div>
               </div>`
            : `<div class="panel-card" style="margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
                 <span style="font-size:0.85rem"><strong>1-Shot Stream Run</strong> · Clean-Room (0 tools, 0 skills)</span>
                 <div style="display:flex;gap:6px">
                   <button type="button" class="btn btn-secondary" data-jump-dtab="lighthouse">Lighthouse (${lhFails}F/${lhPasses}P)</button>
                   <button type="button" class="btn btn-secondary" data-jump-dtab="source">View Source</button>
                 </div>
               </div>`
        }

        <h3>Canonical Multi-Step Journey &amp; W3C INP Breakdown</h3>
        ${
          inpB
            ? `
          <p class="panel-sub">Worst Interaction (${escapeHtml(inpB.name)} on <code>${escapeHtml(inpB.target)}</code>): <strong>${inpB.duration}ms</strong></p>
          <div class="inp-bar-track" title="Input Delay: ${inpB.inputDelayMs}ms | Processing: ${inpB.processingDurationMs}ms | Presentation: ${inpB.presentationDelayMs}ms">
            <div class="inp-seg-delay" style="width:${pDelay}%"></div>
            <div class="inp-seg-proc" style="width:${pProc}%"></div>
            <div class="inp-seg-pres" style="width:${pPres}%"></div>
          </div>
          <p class="mono" style="font-size:0.78rem">
            Input Delay: ${inpB.inputDelayMs}ms · Processing: ${inpB.processingDurationMs}ms · Presentation: ${inpB.presentationDelayMs}ms
          </p>`
            : `<p class="panel-sub">No discrete EventTiming interactionId recorded.</p>`
        }

        <div class="journey-step-list">
          ${(summaryCell?.journeySteps || [])
            .map(
              (s) => `
              <div class="journey-step-item">
                <span>${s.succeeded ? '✓' : '○'} <strong>${escapeHtml(s.label)}</strong> ${s.mutated ? '(state updated)' : ''}</span>
                <span class="mono">${fmtMs(s.durationMs)}</span>
              </div>
            `
            )
            .join('')}
        </div>

        <h3 class="mt-lg">web-uplift 6 Owner Outcomes</h3>
        <div class="gauge-row">
          ${Object.entries(outcomes)
            .map(
              ([k, v]) => `
              <div class="mini-gauge">
                <div class="val">${v ?? '—'}</div>
                <div class="lbl">${escapeHtml(k)}</div>
              </div>
            `
            )
            .join('')}
        </div>
        ${
          summaryCell?.hasUpliftScorecard
            ? `<p><a class="btn btn-secondary" href="./artifacts/${encodeURIComponent(cellId)}/uplift/scorecard.html" target="_blank" rel="noopener">Open Full web-uplift Scorecard ↗</a></p>`
            : ''
        }

        <h3 class="mt-lg">Memory Drift &amp; 10× Cycle Leak Report</h3>
        <div class="panel-card">
          <p class="mono" style="margin:0;font-size:0.81rem">
            Idle Growth (10s): <strong>${Math.round((mem?.idleDrift?.idleHeapGrowthBytes || 0) / 1024)} KB</strong> ·
            Runaway Loop: <strong>${mem?.idleDrift?.suspectedRunawayLoop ? 'YES' : 'No'}</strong><br/>
            10× Cycle Retained: <strong>${Math.round((mem?.interactionLeakTest?.heapGrowthAfterCyclesBytes || 0) / 1024)} KB</strong> ·
            Listener Δ: <strong>${mem?.interactionLeakTest?.listenerDelta ?? 0}</strong> ·
            MemLab Clusters: <strong>${mem?.interactionLeakTest?.memlab?.leakClusterCount ?? 0}</strong>
          </p>
        </div>
      </div>
    </div>
  `;

  for (const jump of body.querySelectorAll('[data-jump-dtab]')) {
    jump.addEventListener('click', () => {
      state.dialogTab = jump.dataset.jumpDtab;
      syncUrlFromState({ push: false });
      renderInspectedCellDialogTab();
    });
  }
}

function renderCellPromptTab(detail) {
  const body = document.getElementById('cell-dialog-body');
  const ep = detail.exactPrompt || {};
  const env = detail.harnessEnvironment || {};
  const gen = detail.generation || {};
  const refImages = ep.referenceImages || [];

  body.innerHTML = `
    <div class="detail-grid-2">
      <div>
        <h3>Exact Natural User Prompt</h3>
        <p class="panel-sub">Zero speed, framework, Lighthouse, or quality keywords allowed.</p>
        <div class="prompt-verbatim-box">${escapeHtml(ep.userPrompt || detail.promptEntry?.prompt || '')}</div>

        ${
          refImages.length > 0
            ? `<h3>Attached Multimodal Style Reference Image(s)</h3>
               <div class="ref-images-grid">
                 ${refImages
                   .map(
                     (img) => `
                     <div class="ref-image-card">
                       <img src="./${escapeHtml(String(img.path || '').replace(/^\/+/, ''))}" alt="${escapeHtml(img.label || 'Style reference')}" />
                       <p class="panel-sub" style="margin:6px 0 0">${escapeHtml(img.label || img.path)}</p>
                     </div>
                   `
                   )
                   .join('')}
               </div>`
            : `<p class="panel-sub"><em>Reference Style Images:</em> None attached to this prompt (unconstrained visual design).</p>`
        }

        <h3 class="mt-lg">${ep.mode === 'agent' ? 'Workspace Deployment Contract' : '1-Shot Neutral System Prompt'}</h3>
        <pre class="code-viewer" style="max-height:260px;white-space:pre-wrap">${escapeHtml(
          ep.mode === 'agent' ? ep.workspaceContract || '' : ep.systemPrompt || ''
        )}</pre>

        <details style="margin-top:14px">
          <summary style="cursor:pointer;font-weight:600;font-size:0.88rem">View Complete Dispatched Prompt Payload</summary>
          <pre class="code-viewer" style="max-height:280px;margin-top:8px;white-space:pre-wrap">${escapeHtml(ep.fullDispatchedPrompt || '')}</pre>
        </details>
      </div>

      <div>
        <h3>Clean-Room Harness &amp; Execution Environment</h3>
        <div class="panel-card">
          <div class="table-surface">
            <table class="data-table">
              <tbody>
                <tr><td><strong>Execution Track</strong></td><td>${modeBadgeHtml(ep.mode === 'agent' ? 'agent' : 'oneshot')}</td></tr>
                <tr><td><strong>Provider / Model ID</strong></td><td class="mono">${escapeHtml(gen.provider || '—')} / ${escapeHtml(gen.modelId || '—')}</td></tr>
                <tr><td><strong>pi Harness Version</strong></td><td class="mono">${escapeHtml(env.piVersion || state.data?.piVersion || '—')}</td></tr>
                <tr><td><strong>Skills Loaded</strong></td><td><span class="score-badge score-good">${env.skillsLoaded ?? 0}</span></td></tr>
                <tr><td><strong>Extensions Loaded</strong></td><td><span class="score-badge score-good">${env.extensionsLoaded ?? 0}</span></td></tr>
                <tr><td><strong>Prompt Templates / Themes</strong></td><td><span class="score-badge score-good">${env.promptTemplatesLoaded ?? 0} / ${env.themesLoaded ?? 0}</span></td></tr>
                <tr><td><strong>AGENTS.md / CLAUDE.md Context</strong></td><td><span class="score-badge score-good">${env.contextFilesLoaded ?? 0}</span></td></tr>
                <tr><td><strong>MCP Servers</strong></td><td><span class="score-badge score-good">${env.mcpServersLoaded ?? 0}</span></td></tr>
                <tr><td><strong>Allowed Tools</strong></td><td class="mono">${escapeHtml((env.enabledTools || []).join(', ') || 'none (--no-tools)')}</td></tr>
                <tr><td><strong>Isolation CLI Flags</strong></td><td class="mono" style="word-break:break-word">${escapeHtml((env.isolationFlags || []).join(' '))}</td></tr>
                <tr><td><strong>Generation Wall Time</strong></td><td class="mono">${fmtMs(gen.durationMs)}</td></tr>
                <tr><td><strong>Token Usage</strong></td><td class="mono">${gen.usage?.totalTokens != null ? gen.usage.totalTokens.toLocaleString() : '—'} tokens</td></tr>
                <tr><td><strong>API Cost</strong></td><td class="mono">${gen.costUsd != null ? `$${Number(gen.costUsd).toFixed(4)}` : '—'}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderCellTranscriptTab(detail) {
  const body = document.getElementById('cell-dialog-body');
  const tl = detail.transcriptTimeline;
  const traj = detail.trajectory;
  const cellId = detail.cellId;
  const transcriptUrl = `./artifacts/${encodeURIComponent(cellId)}/pi-transcript.html`;

  if (!tl || !Array.isArray(tl.turns) || tl.turns.length === 0) {
    body.innerHTML = `
      <div>
        <div class="cohort-header-row">
          <div>
            <h3 style="margin:0">1-Shot Stream Completion Output</h3>
            <p class="panel-sub" style="margin:4px 0 0">This cell ran in zero-tool 1-Shot mode (no multi-turn agent loop). Below is the raw streamed completion.</p>
          </div>
        </div>
        <pre class="code-viewer" style="max-height:540px;white-space:pre-wrap">${escapeHtml(detail.rawOutputPreview || '(No raw-output.md recorded)')}</pre>
      </div>
    `;
    return;
  }

  const renderTimelineTurns = () => {
    const q = state.transcriptQuery.trim().toLowerCase();
    const filt = state.transcriptFilter;

    const matchingTurns = tl.turns.filter((t) => {
      if (filt === 'thinking' && (!t.thinking || t.thinking.length === 0)) return false;
      if (filt === 'bash' && !(t.toolCalls || []).some((c) => c.name === 'bash')) return false;
      if (filt === 'writes' && !(t.toolCalls || []).some((c) => c.name === 'write' || c.name === 'edit')) return false;
      if (filt === 'errors' && !(t.toolCalls || []).some((c) => c.isError)) return false;

      if (!q) return true;
      const hay = [
        ...(t.thinking || []),
        ...(t.text || []),
        ...(t.toolCalls || []).map((c) => `${c.name} ${c.summary} ${c.resultPreview || ''}`),
      ]
        .join('\n')
        .toLowerCase();
      return hay.includes(q);
    });

    const listEl = document.getElementById('turn-timeline-list');
    if (!listEl) return;

    if (matchingTurns.length === 0) {
      listEl.innerHTML = `<div class="panel-card"><p class="panel-sub" style="margin:0">No turns match the current filter.</p></div>`;
      return;
    }

    listEl.innerHTML = matchingTurns
      .map((t) => {
        const usageMeta = t.usage
          ? `${(t.usage.input + t.usage.output).toLocaleString()} tok${t.usage.costUsd != null ? ` · $${t.usage.costUsd.toFixed(4)}` : ''}`
          : '';
        return `
          <article class="turn-card">
            <div class="turn-card-header">
              <div>
                <strong>Turn #${t.turn}</strong>
                <span class="mono" style="color:var(--ink-muted);margin-left:8px">${escapeHtml(t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '')}</span>
              </div>
              <div class="mono" style="color:var(--ink-secondary);font-size:0.76rem">
                ${(t.thinking || []).length ? `${t.thinking.length} thinking · ` : ''}${(t.toolCalls || []).length} tool call${(t.toolCalls || []).length === 1 ? '' : 's'}${usageMeta ? ` · ${escapeHtml(usageMeta)}` : ''}
              </div>
            </div>

            ${(t.thinking || [])
              .map(
                (th, idx) => `
                <details class="thinking-box" ${t.turn <= 2 && idx === 0 ? 'open' : ''}>
                  <summary>Model Thinking (${th.length.toLocaleString()} chars)</summary>
                  <pre class="thinking-pre">${escapeHtml(th)}</pre>
                </details>
              `
              )
              .join('')}

            ${(t.text || [])
              .map(
                (txt) => `<div style="margin:8px 0;font-size:0.86rem;line-height:1.55;white-space:pre-wrap">${escapeHtml(txt)}</div>`
              )
              .join('')}

            ${
              (t.toolCalls || []).length > 0
                ? `<div class="tool-call-list">
                    ${t.toolCalls
                      .map(
                        (c) => `
                        <div class="tool-call-item ${c.isError ? 'tool-error' : ''}">
                          <div class="tool-call-head">
                            <div>
                              <span class="tool-name-badge">${escapeHtml(c.name)}</span>
                              <code style="margin-left:6px;word-break:break-all">${escapeHtml(c.summary)}</code>
                            </div>
                            <div>
                              ${c.contentPreview ? `<span class="mono" style="color:var(--ink-muted);font-size:0.74rem">${escapeHtml(c.contentPreview)}</span>` : ''}
                              ${c.isError ? `<span class="score-badge score-bad">ERROR</span>` : ''}
                            </div>
                          </div>
                          ${
                            c.resultPreview
                              ? `<details style="margin-top:6px" ${c.isError ? 'open' : ''}>
                                   <summary style="cursor:pointer;font-size:0.75rem;color:var(--ink-secondary)">Tool Output (${c.resultPreview.length} chars)</summary>
                                   <pre class="code-viewer" style="max-height:180px;margin-top:6px;white-space:pre-wrap">${escapeHtml(c.resultPreview)}</pre>
                                 </details>`
                              : ''
                          }
                        </div>
                      `
                      )
                      .join('')}
                  </div>`
                : ''
            }
          </article>
        `;
      })
      .join('');
  };

  const errCount = traj?.toolErrorCount ?? 0;
  const filters = [
    { id: 'all', label: `All Turns (${tl.turns.length})` },
    { id: 'thinking', label: 'Thinking' },
    { id: 'bash', label: 'Bash Commands' },
    { id: 'writes', label: 'File Writes/Edits' },
    { id: 'errors', label: `Tool Errors (${errCount})` },
  ];

  body.innerHTML = `
    <div class="transcript-toolbar">
      <div class="category-pills" style="margin:0" id="transcript-filter-pills">
        ${filters
          .map(
            (f) =>
              `<button type="button" class="cat-pill ${state.transcriptFilter === f.id ? 'active' : ''}" data-tf="${f.id}">${escapeHtml(f.label)}</button>`
          )
          .join('')}
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="transcript-search-input" class="transcript-search" type="search" placeholder="Search thinking, commands, files..." value="${escapeHtml(state.transcriptQuery)}" />
        <button type="button" id="expand-all-turns-btn" class="btn btn-ghost">Expand All</button>
        <button type="button" id="collapse-all-turns-btn" class="btn btn-ghost">Collapse All</button>
        ${
          detail.hasPiTranscript
            ? `<a class="btn btn-secondary" href="${transcriptUrl}" target="_blank" rel="noopener">Raw pi HTML ↗</a>`
            : ''
        }
      </div>
    </div>

    <details style="margin-bottom:14px">
      <summary style="cursor:pointer;font-weight:600;font-size:0.84rem;color:var(--ink-secondary)">Initial User Prompt Dispatched to Session</summary>
      <div class="prompt-verbatim-box">${escapeHtml(tl.initialUserPrompt || detail.exactPrompt?.fullDispatchedPrompt || '')}</div>
    </details>

    <div id="turn-timeline-list" class="turn-timeline"></div>
  `;

  renderTimelineTurns();

  for (const btn of body.querySelectorAll('[data-tf]')) {
    btn.addEventListener('click', () => {
      state.transcriptFilter = btn.dataset.tf;
      for (const b of body.querySelectorAll('[data-tf]')) {
        b.classList.toggle('active', b.dataset.tf === state.transcriptFilter);
      }
      renderTimelineTurns();
    });
  }

  document.getElementById('transcript-search-input')?.addEventListener('input', (e) => {
    state.transcriptQuery = e.target.value;
    renderTimelineTurns();
  });

  document.getElementById('expand-all-turns-btn')?.addEventListener('click', () => {
    for (const d of body.querySelectorAll('#turn-timeline-list details')) d.open = true;
  });
  document.getElementById('collapse-all-turns-btn')?.addEventListener('click', () => {
    for (const d of body.querySelectorAll('#turn-timeline-list details')) d.open = false;
  });
}

const KNOWN_LH_CATEGORIES = {
  'errors-in-console': ['best-practices'],
  'inspector-issues': ['best-practices'],
  'deprecations': ['best-practices'],
  'doctype': ['best-practices'],
  'charset': ['best-practices'],
  'is-on-https': ['best-practices'],
  'third-party-cookies': ['best-practices'],
  'valid-source-maps': ['best-practices'],
  'paste-preventing-inputs': ['best-practices'],
  'image-aspect-ratio': ['best-practices'],
  'image-size-responsive': ['best-practices'],
  'font-size': ['seo'],
  'meta-description': ['seo'],
  'document-title': ['accessibility', 'seo'],
  'robots-txt': ['seo'],
  'crawlable-anchors': ['seo'],
  'link-text': ['seo'],
  'http-status-code': ['seo'],
  'is-crawlable': ['seo'],
  'label': ['accessibility'],
  'color-contrast': ['accessibility'],
  'heading-order': ['accessibility'],
  'button-name': ['accessibility'],
  'link-name': ['accessibility'],
  'html-has-lang': ['accessibility'],
  'html-lang-valid': ['accessibility'],
  'image-alt': ['accessibility', 'seo'],
  'target-size': ['accessibility'],
  'meta-viewport': ['accessibility', 'best-practices'],
  'uses-text-compression': ['performance'],
  'unminified-javascript': ['performance'],
  'unminified-css': ['performance'],
  'unused-javascript': ['performance'],
  'unused-css-rules': ['performance'],
  'render-blocking-resources': ['performance'],
  'largest-contentful-paint': ['performance'],
  'first-contentful-paint': ['performance'],
  'total-blocking-time': ['performance'],
  'cumulative-layout-shift': ['performance'],
  'speed-index': ['performance'],
  'interactive': ['performance'],
  'bf-cache': ['performance'],
};

function getAuditCategories(a) {
  if (Array.isArray(a.categories) && a.categories.length > 0 && a.categories[0] !== 'other') {
    return a.categories;
  }
  if (a.category && a.category !== 'other' && a.category !== 'general') {
    return [a.category];
  }
  return KNOWN_LH_CATEGORIES[a.id] || ['performance'];
}

function renderCellLighthouseTab(detail) {
  const body = document.getElementById('cell-dialog-body');
  const lhu = detail.benchmarks?.['lighthouse-uplift']?.lighthouse;
  const mob = lhu?.mobile;
  const desk = lhu?.desktop;

  if (!mob) {
    body.innerHTML = `<div class="panel-card"><p>No Lighthouse audit JSON recorded for this cell yet.</p></div>`;
    return;
  }

  const failing = (mob.failingAudits || []).map((a) => {
    const cats = getAuditCategories(a);
    return { ...a, category: cats[0], categories: cats, status: 'FAIL' };
  });
  const passing = (mob.passedAudits || []).map((a) => {
    const cats = getAuditCategories(a);
    return { ...a, category: cats[0], categories: cats, status: 'PASS' };
  });
  const mobScores = mob.scores || {};
  const deskScores = desk?.scores || {};

  const matchesCat = (a, cat) => (a.categories || [a.category]).includes(cat);
  const countCat = (cat) => ({
    f: failing.filter((a) => matchesCat(a, cat)).length,
    p: passing.filter((a) => matchesCat(a, cat)).length,
  });

  const renderAuditTable = () => {
    const f = state.lhCellFilter;
    let items = [];
    if (f === 'failed') items = failing;
    else if (f === 'passed') items = passing;
    else if (f === 'all') items = [...failing, ...passing];
    else {
      items = [
        ...failing.filter((a) => matchesCat(a, f)),
        ...passing.filter((a) => matchesCat(a, f)),
      ];
    }

    const slot = document.getElementById('cell-lh-table-slot');
    if (!slot) return;
    if (items.length === 0) {
      slot.innerHTML = `<div class="panel-card"><p class="panel-sub" style="margin:0">No audits match this filter.</p></div>`;
      return;
    }

    slot.innerHTML = `
      <div class="table-surface">
        <table class="data-table lh-wrap-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Category</th>
              <th>Audit ID</th>
              <th class="col-wrap">Lighthouse Audit Title</th>
              <th class="num">Score</th>
              <th class="col-wrap">Measured Value</th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map((a) => {
                const badgeCls =
                  a.status === 'PASS' ? 'score-good' : (a.score ?? 0) >= 50 ? 'score-warn' : 'score-bad';
                const catBadges = (a.categories || [a.category])
                  .map((c) => `<span class="lh-audit-cat">${escapeHtml(c)}</span>`)
                  .join(' ');
                return `
                  <tr>
                    <td><span class="score-badge ${badgeCls}">${a.status}</span></td>
                    <td>${catBadges}</td>
                    <td class="mono">${escapeHtml(a.id)}</td>
                    <td class="col-wrap"><strong>${escapeHtml(a.title)}</strong></td>
                    <td class="num mono">${a.score ?? (a.status === 'PASS' ? 100 : 0)}</td>
                    <td class="mono col-wrap">${escapeHtml(a.displayValue || '—')}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  };

  const cPerf = countCat('performance');
  const cA11y = countCat('accessibility');
  const cBp = countCat('best-practices');
  const cSeo = countCat('seo');

  const filterButtons = [
    { id: 'all', label: `All (${failing.length + passing.length}: ${failing.length}F · ${passing.length}P)` },
    { id: 'failed', label: `Failed (${failing.length})` },
    { id: 'passed', label: `Passed (${passing.length})` },
    { id: 'performance', label: `Performance (${cPerf.f}F · ${cPerf.p}P)` },
    { id: 'accessibility', label: `Accessibility (${cA11y.f}F · ${cA11y.p}P)` },
    { id: 'best-practices', label: `Best Practices (${cBp.f}F · ${cBp.p}P)` },
    { id: 'seo', label: `SEO (${cSeo.f}F · ${cSeo.p}P)` },
  ];

  body.innerHTML = `
    <div class="gauge-row">
      <div class="mini-gauge"><div class="val">${fmtScore(mobScores.performance)}</div><div class="lbl">Mobile Perf</div></div>
      <div class="mini-gauge"><div class="val">${fmtScore(mobScores.accessibility)}</div><div class="lbl">Mobile A11y</div></div>
      <div class="mini-gauge"><div class="val">${fmtScore(mobScores.bestPractices)}</div><div class="lbl">Mobile Best-Prac</div></div>
      <div class="mini-gauge"><div class="val">${fmtScore(mobScores.seo)}</div><div class="lbl">Mobile SEO</div></div>
      <div class="mini-gauge"><div class="val">${fmtScore(deskScores.performance)}</div><div class="lbl">Desktop Perf</div></div>
      <div class="mini-gauge"><div class="val">${failing.length}</div><div class="lbl">Failed Checks</div></div>
      <div class="mini-gauge"><div class="val">${passing.length}</div><div class="lbl">Passed Checks</div></div>
    </div>

    <div class="category-pills" id="cell-lh-filter-bar">
      ${filterButtons
        .map(
          (b) =>
            `<button type="button" class="cat-pill ${state.lhCellFilter === b.id ? 'active' : ''}" data-cell-lhf="${b.id}">${escapeHtml(b.label)}</button>`
        )
        .join('')}
    </div>

    <div id="cell-lh-table-slot"></div>
  `;

  renderAuditTable();

  for (const btn of body.querySelectorAll('[data-cell-lhf]')) {
    btn.addEventListener('click', () => {
      state.lhCellFilter = btn.dataset.cellLhf;
      for (const b of body.querySelectorAll('[data-cell-lhf]')) {
        b.classList.toggle('active', b.dataset.cellLhf === state.lhCellFilter);
      }
      renderAuditTable();
    });
  }
}

function renderCellSourceTab(detail) {
  const body = document.getElementById('cell-dialog-body');
  const files = detail.extractedFiles || [];

  if (files.length === 0) {
    body.innerHTML = `<div class="panel-card"><p>No extracted workspace files available for this cell.</p></div>`;
    return;
  }

  body.innerHTML = `
    <div class="file-explorer-bar">
      <h3 style="margin:0">Workspace Source Files (${files.length})</h3>
      <label class="inline-select" for="cell-file-select">
        <span>File</span>
        <select id="cell-file-select">
          ${files.map((f, idx) => `<option value="${idx}">${escapeHtml(f.path)} (${f.content.length.toLocaleString()} chars)</option>`).join('')}
        </select>
      </label>
    </div>
    <pre id="cell-source-viewer" class="code-viewer" style="max-height:560px">${escapeHtml(files[0].content.slice(0, 48000))}</pre>
  `;

  const fileSel = document.getElementById('cell-file-select');
  const codeViewer = document.getElementById('cell-source-viewer');
  if (fileSel && codeViewer) {
    fileSel.addEventListener('change', () => {
      const f = files[Number(fileSel.value)];
      if (f) codeViewer.textContent = f.content.slice(0, 48000);
    });
  }
}

function renderInspectedCellDialogTab() {
  const detail = state.inspectedCell;
  if (!detail) return;
  const summaryCell = (state.data?.summary?.cells || []).find((c) => c.cellId === detail.cellId);
  renderDialogSubtabs(detail, summaryCell);

  if (state.dialogTab === 'prompt') renderCellPromptTab(detail);
  else if (state.dialogTab === 'transcript') renderCellTranscriptTab(detail);
  else if (state.dialogTab === 'lighthouse') renderCellLighthouseTab(detail);
  else if (state.dialogTab === 'source') renderCellSourceTab(detail);
  else renderCellOverviewTab(detail, summaryCell);
}

async function openCellInspectionDialog(cellId, initialTab = 'overview', { fromRouter = false } = {}) {
  if (!cellId) return;
  const dialog = document.getElementById('cell-detail-dialog');
  const body = document.getElementById('cell-dialog-body');
  const tabsNav = document.getElementById('cell-dialog-tabs');
  const titleEl = document.getElementById('cell-dialog-title');
  const eyebrowEl = document.getElementById('cell-dialog-eyebrow');
  const openTabLink = document.getElementById('open-preview-newtab');
  const openTranscriptLink = document.getElementById('open-transcript-newtab');
  const rerunBtn = document.getElementById('rerun-single-cell-btn');

  state.inspectedCellId = cellId;
  state.dialogTab = VALID_DIALOG_TABS.has(initialTab) ? initialTab : 'overview';
  if (!fromRouter) syncUrlFromState({ push: true });

  if (tabsNav) tabsNav.innerHTML = '';
  body.innerHTML = `<p>Loading cell telemetry for <code>${escapeHtml(cellId)}</code>...</p>`;
  if (!dialog.open) dialog.showModal();

  const endpoint = state.data?.staticMode
    ? `./api-static/cells/${encodeURIComponent(cellId)}.json`
    : `./api/cells/${encodeURIComponent(cellId)}`;
  const res = await fetch(endpoint);
  if (!res.ok) {
    body.innerHTML = `<p>Could not load cell details for <code>${escapeHtml(cellId)}</code>.</p>`;
    return;
  }
  const detail = await res.json();
  state.inspectedCell = detail;

  const summaryCell = (state.data?.summary?.cells || []).find((c) => c.cellId === cellId);
  const cellMode = detail.generation?.mode === 'agent' || cellId.endsWith('__agent') ? 'agent' : 'oneshot';
  const modeLabel = cellMode === 'agent' ? 'Agent Loop (pi + $PORT Server)' : '1-Shot Stream';
  eyebrowEl.textContent = `${modeLabel} · ${detail.promptEntry?.categoryLabel || ''} · ${detail.generation?.provider}/${detail.generation?.modelId}`;
  titleEl.textContent = `${summaryCell?.modelLabel || detail.generation?.modelKey} — ${detail.promptEntry?.title || detail.generation?.promptId}`;

  const isLiveStudio = !state.data?.staticMode;
  const previewHref = isLiveStudio
    ? detail.livePreviewUrl || `./preview/${encodeURIComponent(cellId)}/`
    : `./preview/${encodeURIComponent(cellId)}/index.html`;

  openTabLink.href = previewHref;
  rerunBtn.classList.toggle('hidden', Boolean(state.data?.staticMode));

  const transcriptUrl = `./artifacts/${encodeURIComponent(cellId)}/pi-transcript.html`;
  if (openTranscriptLink) {
    const hasTr = Boolean(detail.hasPiTranscript || summaryCell?.hasPiTranscript);
    openTranscriptLink.href = transcriptUrl;
    openTranscriptLink.classList.toggle('hidden', !hasTr);
  }

  renderInspectedCellDialogTab();
}

// --- HELPERS & INITIALIZATION -----------------------------------------------

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

function populateStaticDropdowns() {
  const matCat = document.getElementById('matrix-category-select');
  const promptCat = document.getElementById('new-prompt-category');
  const cats = state.data?.categories || [];

  matCat.innerHTML =
    `<option value="all">All 10 Categories</option>` +
    cats.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join('');
  matCat.value = state.matrixCategory;

  promptCat.innerHTML = cats
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`)
    .join('');
}

function renderAll() {
  renderHeaderKpis();
  populateStaticDropdowns();
  renderLeaderboard();
  renderMatrix();
  renderTechObservatory();
  renderArenaSelectors();
  renderMethodology();
  renderRunnerControls();
  updateNavTabHrefs();
}

async function init() {
  installDialogLightDismissFallbacks();
  installInvokerFallback();

  // Theme toggle
  const savedTheme = safeGetStorage('bench-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    safeSetStorage('bench-theme', next);
  });

  // Copy sharable URL buttons
  document.getElementById('copy-view-link-btn')?.addEventListener('click', (e) => {
    copyCurrentUrlWithFeedback(e.currentTarget);
  });
  document.getElementById('copy-cell-link-btn')?.addEventListener('click', (e) => {
    copyCurrentUrlWithFeedback(e.currentTarget);
  });

  // Primary navigation <a class="tab-btn" href="#/..."> links (preserve modifier-clicks for open-in-new-tab!)
  for (const link of document.querySelectorAll('.tab-btn[data-view]')) {
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      state.inspectedCellId = null;
      switchView(link.dataset.view, { push: true });
    });
  }

  // Sortable Leaderboard column headers
  for (const btn of document.querySelectorAll('.th-sort-btn[data-sort-col]')) {
    btn.addEventListener('click', () => {
      const col = btn.dataset.sortCol;
      if (state.leaderboardSortCol === col) {
        state.leaderboardSortDir = state.leaderboardSortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.leaderboardSortCol = col;
        state.leaderboardSortDir = DEFAULT_SORT_DIR[col] || 'desc';
      }
      syncUrlFromState({ push: false });
      renderLeaderboard();
    });
  }

  // Clear cell URL param when dialog closes
  document.getElementById('cell-detail-dialog')?.addEventListener('close', () => {
    if (state.inspectedCellId) {
      state.inspectedCellId = null;
      syncUrlFromState({ push: false });
    }
  });

  // Global Mode + Matrix controls
  document.getElementById('global-mode-select').addEventListener('change', (e) => {
    state.selectedMode = e.target.value;
    syncUrlFromState({ push: false });
    renderLeaderboard();
    renderMatrix();
    renderTechObservatory();
  });

  document.getElementById('matrix-category-select').addEventListener('change', (e) => {
    state.matrixCategory = e.target.value;
    syncUrlFromState({ push: false });
    renderMatrix();
  });

  document.getElementById('matrix-metric-select').addEventListener('change', (e) => {
    state.matrixMetric = e.target.value;
    syncUrlFromState({ push: false });
    renderMatrix();
  });

  // Arena controls
  for (const id of ['arena-prompt-select', 'arena-model-a', 'arena-model-b']) {
    document.getElementById(id).addEventListener('change', () => {
      renderArenaComparison();
      syncUrlFromState({ push: false });
    });
  }

  // Weight sliders
  const weightInputs = ['lighthouse', 'uplift', 'deepPerf', 'memory', 'functionalFlow'];
  for (const key of weightInputs) {
    const inp = document.getElementById(`weight-${key}`);
    const out = document.getElementById(`out-weight-${key}`);
    inp.addEventListener('input', () => {
      out.textContent = `${inp.value}%`;
    });
  }

  document.getElementById('reset-weights-btn').addEventListener('click', () => {
    const defaults = { lighthouse: 25, uplift: 25, deepPerf: 25, memory: 15, functionalFlow: 10 };
    for (const [k, v] of Object.entries(defaults)) {
      document.getElementById(`weight-${k}`).value = v;
      document.getElementById(`out-weight-${k}`).textContent = `${v}%`;
    }
  });

  document.getElementById('weights-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = {};
    let sum = 0;
    for (const k of weightInputs) {
      raw[k] = Number(document.getElementById(`weight-${k}`).value);
      sum += raw[k];
    }
    const normalized = {};
    for (const k of weightInputs) normalized[k] = sum > 0 ? raw[k] / sum : 0.2;

    if (!state.data?.staticMode) {
      const res = await fetch('./api/reweight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weights: normalized }),
      });
      if (res.ok) {
        const { summary } = await res.json();
        state.data.summary = summary;
        renderLeaderboard();
        renderMatrix();
        renderTechObservatory();
      }
    }
    document.getElementById('weights-popover').hidePopover?.();
  });

  // Runner quick-selection buttons
  document.getElementById('select-pilot-models-btn').addEventListener('click', () => {
    for (const m of state.data?.models || []) {
      const el = document.getElementById(`chk-model-${m.key}`);
      if (el) el.checked = Boolean(m.pilot && m.ready);
    }
    document.getElementById('runner-form').dispatchEvent(new Event('change'));
  });
  document.getElementById('select-all-ready-models-btn').addEventListener('click', () => {
    for (const m of state.data?.models || []) {
      const el = document.getElementById(`chk-model-${m.key}`);
      if (el) el.checked = Boolean(m.ready);
    }
    document.getElementById('runner-form').dispatchEvent(new Event('change'));
  });
  document.getElementById('clear-models-btn').addEventListener('click', () => {
    for (const el of document.querySelectorAll('input[name="modelKey"]')) el.checked = false;
    document.getElementById('runner-form').dispatchEvent(new Event('change'));
  });
  document.getElementById('select-pilot-prompts-btn').addEventListener('click', () => {
    for (const p of state.data?.prompts || []) {
      const el = document.getElementById(`chk-prompt-${p.id}`);
      if (el) el.checked = Boolean(p.pilot);
    }
    document.getElementById('runner-form').dispatchEvent(new Event('change'));
  });
  document.getElementById('select-all-prompts-btn').addEventListener('click', () => {
    for (const el of document.querySelectorAll('input[name="promptId"]')) el.checked = true;
    document.getElementById('runner-form').dispatchEvent(new Event('change'));
  });
  document.getElementById('clear-prompts-btn').addEventListener('click', () => {
    for (const el of document.querySelectorAll('input[name="promptId"]')) el.checked = false;
    document.getElementById('runner-form').dispatchEvent(new Event('change'));
  });

  // Launch Selective Run
  document.getElementById('runner-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const modelKeys = Array.from(document.querySelectorAll('input[name="modelKey"]:checked')).map((i) => i.value);
    const promptIds = Array.from(document.querySelectorAll('input[name="promptId"]:checked')).map((i) => i.value);
    const benchmarkIds = Array.from(document.querySelectorAll('input[name="benchmarkId"]:checked')).map((i) => i.value);
    await launchSelectiveRun({
      modelKeys,
      promptIds,
      benchmarkIds,
      reuseGeneration: document.getElementById('opt-reuse-gen').checked,
      force: document.getElementById('opt-force-rerun').checked,
      skipJudge: document.getElementById('opt-skip-judge').checked,
      mode: document.getElementById('opt-gen-mode').value,
      stage: document.getElementById('opt-run-stage')?.value || 'all',
      auditRuns: Number(document.getElementById('opt-audit-runs')?.value || 1),
    });
  });

  document.getElementById('cancel-run-btn').addEventListener('click', async () => {
    if (!state.activeRunId) return;
    await fetch(`./api/runs/${encodeURIComponent(state.activeRunId)}/cancel`, { method: 'POST' });
  });

  document.getElementById('rerun-single-cell-btn').addEventListener('click', async () => {
    if (!state.inspectedCell?.generation) return;
    document.getElementById('cell-detail-dialog').close();
    switchView('run');
    await launchSelectiveRun({
      modelKeys: [state.inspectedCell.generation.modelKey],
      promptIds: [state.inspectedCell.generation.promptId],
      mode: state.inspectedCell.generation.mode || 'agent',
      force: true,
    });
  });

  // Sync Models & Add Prompt/Model dialogs
  document.getElementById('sync-models-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sync-models-btn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';
    try {
      await fetch('./api/models/sync', { method: 'POST' });
      await fetchStudioState();
      renderAll();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sync Latest Models';
    }
  });

  document.getElementById('open-add-prompt-btn').addEventListener('click', () => {
    document.getElementById('add-prompt-dialog').showModal();
  });
  document.getElementById('open-add-model-btn').addEventListener('click', () => {
    document.getElementById('add-model-dialog').showModal();
  });
  for (const closeBtn of document.querySelectorAll('[data-close-dialog]')) {
    closeBtn.addEventListener('click', () => {
      document.getElementById(closeBtn.dataset.closeDialog).close();
    });
  }

  document.getElementById('add-prompt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('add-prompt-error');
    errBox.classList.add('hidden');
    const fd = new FormData(e.target);

    const referenceImages = [];
    const fileInput = document.getElementById('new-prompt-ref-image');
    const imageFile = fileInput?.files?.[0];
    if (imageFile && imageFile.size > 0) {
      try {
        const dataUrl = await readFileAsDataUrl(imageFile);
        const upRes = await fetch('./api/prompts/reference-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: fd.get('id'), dataUrl }),
        });
        const upOut = await upRes.json();
        if (!upRes.ok) {
          errBox.textContent = upOut.error || 'Failed to upload reference image';
          errBox.classList.remove('hidden');
          return;
        }
        const label = String(fd.get('refImageLabel') || '').trim();
        referenceImages.push({
          path: upOut.path,
          ...(label ? { label } : {}),
        });
      } catch (err) {
        errBox.textContent = err.message || 'Reference image upload error';
        errBox.classList.remove('hidden');
        return;
      }
    }

    const payload = {
      id: fd.get('id'),
      category: fd.get('category'),
      title: fd.get('title'),
      pilot: false,
      requiresAuth: false,
      prompt: fd.get('prompt'),
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
      expectedFlows: ['browse', 'interact', 'submit'],
      canonicalJourney: [
        { id: 'step-1', label: 'Primary filter or navigation', action: 'click', patterns: ['filter', 'browse', 'view', 'explore'] },
        { id: 'step-2', label: 'Open detail or action view', action: 'click', patterns: ['open', 'select', 'book', 'read', 'details'] },
        { id: 'step-3', label: 'Complete primary form', action: 'form-submit', fields: { name: 'Test User', email: 'test@example.com' }, submitPatterns: ['submit', 'confirm', 'send', 'save'] },
      ],
      leakLoop: {
        description: 'Open and close primary detail view',
        doPatterns: ['view', 'open', 'details'],
        undoPatterns: ['close', 'back', 'cancel', '×'],
      },
    };
    const res = await fetch('./api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok) {
      errBox.textContent = out.error || 'Failed to add prompt';
      errBox.classList.remove('hidden');
      return;
    }
    e.target.reset();
    document.getElementById('add-prompt-dialog').close();
    await fetchStudioState();
    renderAll();
  });

  document.getElementById('add-model-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('add-model-error');
    errBox.classList.add('hidden');
    const fd = new FormData(e.target);
    const payload = {
      key: fd.get('key'),
      label: fd.get('label'),
      family: fd.get('family'),
      routes: [{ provider: fd.get('provider'), modelId: fd.get('modelId') }],
    };
    const res = await fetch('./api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok) {
      errBox.textContent = out.error || 'Failed to save model';
      errBox.classList.remove('hidden');
      return;
    }
    e.target.reset();
    document.getElementById('add-model-dialog').close();
    await fetchStudioState();
    renderAll();
  });

  await fetchStudioState();
  renderAll();
  await applyUrlStateToUi();
  if (!window.location.hash) {
    syncUrlFromState({ push: false });
  }

  window.addEventListener('hashchange', () => {
    applyUrlStateToUi();
  });
}

init();
