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
  selectedSpec: 'all',
  selectedCategory: 'all',
  leaderboardSortCol: 'composite',
  leaderboardSortDir: 'desc',
  lhCorpusFilter: 'all-failures',
  lhSplitBy: 'none',
  lhFamilyFilter: 'all',
  lhLeadFilter: 'all',
  lhSpecFilter: 'all',
  lhSearchQuery: '',
  inspectedLhAuditId: null,
  lhModalStatusFilter: 'all',
  lhModalFamilyFilter: 'all',
  lhModalLeadFilter: 'all',
  lhModalSpecFilter: 'all',
  lhModalSearch: '',
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
  previewViewMode: 'live',
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

function specBadgeHtml(spec) {
  return spec === 'guided'
    ? `<span class="spec-badge spec-guided" title="Guided spec: gemini-nano-banana-2.1 layout image + design.md + canonical seed data">Guided · Ref+Design+Data</span>`
    : `<span class="spec-badge spec-freeform" title="Free-form spec: pure open 1-sentence prompt">Free-form</span>`;
}

function canEmbedCellLivePreview(summaryCell, detail) {
  if (!state.data?.staticMode) {
    return Boolean(detail ? detail.materialization?.ok : summaryCell?.buildSucceeded);
  }
  return Boolean(detail?.hasStaticPreview ?? summaryCell?.hasStaticPreview);
}

const PREVIEW_IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock';

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
  spec = state.selectedSpec,
  cat = state.selectedCategory,
  sortCol = state.leaderboardSortCol,
  sortDir = state.leaderboardSortDir,
  lhFilter = state.lhCorpusFilter,
  lhSplit = state.lhSplitBy,
  lhFamily = state.lhFamilyFilter,
  lhLead = state.lhLeadFilter,
  lhSpec = state.lhSpecFilter,
  lhAudit = state.inspectedLhAuditId,
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
  if (spec && spec !== 'all') params.set('spec', spec);

  if (cleanView === 'leaderboard') {
    if (cat && cat !== 'all') params.set('cat', cat);
    if (sortCol && (sortCol !== 'composite' || sortDir !== 'desc')) {
      params.set('sort', sortCol);
      params.set('dir', sortDir);
    }
    if (lhFilter && lhFilter !== 'all-failures') params.set('lh', lhFilter);
    if (lhSplit && lhSplit !== 'none') params.set('lhsplit', lhSplit);
    if (lhFamily && lhFamily !== 'all') params.set('lhfamily', lhFamily);
    if (lhLead && lhLead !== 'all') params.set('lhlead', lhLead);
    if (lhSpec && lhSpec !== 'all') params.set('lhspec', lhSpec);
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

  if (lhAudit) {
    params.set('lhaudit', lhAudit);
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
      lhAudit: null,
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

  const specParam = params.get('spec');
  state.selectedSpec = specParam === 'freeform' || specParam === 'guided' ? specParam : 'all';

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
    const lhSplitParam = params.get('lhsplit');
    state.lhSplitBy = ['none', 'mode', 'family', 'spec', 'model'].includes(lhSplitParam) ? lhSplitParam : 'none';
    state.lhFamilyFilter = params.get('lhfamily') || 'all';
    const lhLeadParam = params.get('lhlead');
    state.lhLeadFilter = lhLeadParam === 'agent' || lhLeadParam === 'oneshot' ? lhLeadParam : 'all';
    const lhSpecParam = params.get('lhspec');
    state.lhSpecFilter = lhSpecParam === 'freeform' || lhSpecParam === 'guided' ? lhSpecParam : 'all';
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
  const lhAuditParam = params.get('lhaudit');
  return {
    cellId: cellParam || null,
    dtab: VALID_DIALOG_TABS.has(dtabParam) ? dtabParam : 'overview',
    lhAuditId: lhAuditParam || null,
  };
}

async function applyUrlStateToUi() {
  state.suppressHashSync = true;
  try {
    const { cellId, dtab, lhAuditId } = parseHashIntoState();

    const modeSelect = document.getElementById('global-mode-select');
    if (modeSelect) modeSelect.value = state.selectedMode;

    const specSelect = document.getElementById('global-spec-select');
    if (specSelect) specSelect.value = state.selectedSpec;

    const lhSplitSelect = document.getElementById('lh-split-select');
    if (lhSplitSelect) lhSplitSelect.value = state.lhSplitBy;
    const lhFamilySelect = document.getElementById('lh-family-select');
    if (lhFamilySelect && Array.from(lhFamilySelect.options).some((o) => o.value === state.lhFamilyFilter)) {
      lhFamilySelect.value = state.lhFamilyFilter;
    }
    const lhLeadSelect = document.getElementById('lh-lead-select');
    if (lhLeadSelect) lhLeadSelect.value = state.lhLeadFilter;
    const lhSpecSelect = document.getElementById('lh-spec-select');
    if (lhSpecSelect) lhSpecSelect.value = state.lhSpecFilter;

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

    const lhDialog = document.getElementById('lh-audit-detail-dialog');
    if (lhAuditId && !cellId) {
      if (state.inspectedLhAuditId !== lhAuditId || !lhDialog?.open) {
        openLighthouseAuditDialog(lhAuditId, { fromRouter: true });
      }
    } else if (lhDialog?.open && !lhAuditId) {
      state.inspectedLhAuditId = null;
      lhDialog.close();
    }

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
  const isStaticExport =
    document.documentElement.dataset.staticReport === 'true' ||
    window.location.hostname.endsWith('.github.io');
  if (!isStaticExport) {
    try {
      const res = await fetch('./api/state');
      if (res.ok) {
        state.data = await res.json();
        return;
      }
    } catch {
      // Fallback to static export JSON
    }
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
  const guidedCount = totals.guidedCells || 0;
  const specSuffix = guidedCount > 0 ? ` · ${guidedCount} guided` : '';
  const canary = d.summary?.canary;
  const canaryBadge = canary
    ? `<span>Canary: <strong>${escapeHtml(String(canary.status || 'stable').toUpperCase())}</strong> (${canary.browserMainThreadComputeMs ?? canary.nodeCpuComputeMs ?? '—'}ms)</span>`
    : '';
  el.innerHTML = `
    <span>Prompts: <strong>${d.prompts.length}</strong> (${d.categories.length} cats)</span>
    <span>Models: <strong>${d.models.length}</strong> (${readyCount} live)</span>
    <span>Cells: <strong>${cellCount}</strong> (${agentCount} agent · ${oneshotCount} 1-shot${escapeHtml(specSuffix)})</span>
    ${canaryBadge}
  `;
}

// --- VIEW 1: LEADERBOARD & CORPUS LIGHTHOUSE PASSES/FAILURES ----------------

function getRowSortValue(row, col) {
  switch (col) {
    case 'label':
      return (row.label || row.modelKey || '').toLowerCase();
    case 'mode':
      return `${row.mode || ''}_${row.spec || 'freeform'}`;
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
  const specFilter = state.selectedSpec;
  let rows = summary.leaderboard
    .filter(
      (r) =>
        (modeFilter === 'all' || r.mode === modeFilter) &&
        (specFilter === 'all' || (r.spec || 'freeform') === specFilter)
    )
    .map((r) => ({ ...r }));

  if (cat !== 'all') {
    const cells = (summary.cells || []).filter(
      (c) =>
        c.category === cat &&
        (modeFilter === 'all' || c.mode === modeFilter) &&
        (specFilter === 'all' || (c.spec || 'freeform') === specFilter)
    );
    const byGroup = new Map();
    for (const c of cells) {
      const sp = c.spec || 'freeform';
      const gk = sp === 'guided' ? `${c.modelKey}__${c.mode || 'oneshot'}__guided` : `${c.modelKey}__${c.mode || 'oneshot'}`;
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
      const sp = sample.spec || 'freeform';
      const base =
        summary.leaderboard.find(
          (x) =>
            x.rowId === gk ||
            (x.modelKey === sample.modelKey && x.mode === sample.mode && (x.spec || 'freeform') === sp)
        ) || {
          rowId: gk,
          modelKey: sample.modelKey,
          mode: sample.mode || 'oneshot',
          spec: sp,
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
        spec: sp,
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

function cellMatchesCorpusLhSlice(cell) {
  if (!cell?.lighthouseAudits) return false;
  if (state.selectedCategory !== 'all' && cell.category !== state.selectedCategory) return false;
  const famFilter = state.lhFamilyFilter;
  if (famFilter && famFilter !== 'all') {
    if (famFilter.startsWith('model:')) {
      if (cell.modelKey !== famFilter.slice(6)) return false;
    } else if ((cell.family || 'Other') !== famFilter) {
      return false;
    }
  }
  if (state.lhLeadFilter !== 'all' && cell.mode !== state.lhLeadFilter) return false;
  if (state.lhSpecFilter !== 'all' && (cell.spec || 'freeform') !== state.lhSpecFilter) return false;
  return true;
}

function getLhSplitBucket(cell, splitBy) {
  if (splitBy === 'mode') {
    return cell.mode === 'agent'
      ? { key: 'agent', label: 'Agent · pi' }
      : { key: 'oneshot', label: '1-Shot' };
  }
  if (splitBy === 'family') {
    const fam = cell.family || 'Other';
    return { key: fam, label: fam };
  }
  if (splitBy === 'spec') {
    return cell.spec === 'guided'
      ? { key: 'guided', label: 'Guided (Ref+Data)' }
      : { key: 'freeform', label: 'Free-form' };
  }
  if (splitBy === 'model') {
    return { key: cell.modelKey, label: cell.modelLabel || cell.modelKey };
  }
  return null;
}

function computeCorpusLighthouseAnalytics({ ignoreSliceFilters = false } = {}) {
  const allCells = state.data?.summary?.cells || [];
  const auditedCells = allCells.filter((c) =>
    ignoreSliceFilters ? Boolean(c?.lighthouseAudits) : cellMatchesCorpusLhSlice(c)
  );
  const splitBy = state.lhSplitBy;
  const bucketTotals = new Map();
  const auditMap = new Map();

  for (const c of auditedCells) {
    const b = splitBy !== 'none' ? getLhSplitBucket(c, splitBy) : null;
    if (b) {
      const prevB = bucketTotals.get(b.key) || { key: b.key, label: b.label, total: 0 };
      prevB.total++;
      bucketTotals.set(b.key, prevB);
    }

    const recordCellAudit = (a, isFail) => {
      const cats = getAuditCategories(a);
      let entry = auditMap.get(a.id);
      if (!entry) {
        entry = {
          id: a.id,
          title: a.title || a.id,
          description: a.description || '',
          helpUrl: a.helpUrl || '',
          category: cats[0],
          categories: cats,
          failCount: 0,
          passCount: 0,
          applicableCount: 0,
          scores: [],
          failScores: [],
          failingCells: [],
          passingCells: [],
          allCellRecords: [],
          bySplit: new Map(),
        };
        auditMap.set(a.id, entry);
      } else {
        if (!entry.description && a.description) entry.description = a.description;
        if (!entry.helpUrl && a.helpUrl) entry.helpUrl = a.helpUrl;
      }

      const numericScore = a.score != null ? Number(a.score) : isFail ? 0 : 100;
      entry.applicableCount++;
      entry.scores.push(numericScore);

      const cellRecord = {
        cellId: c.cellId,
        modelKey: c.modelKey,
        modelLabel: c.modelLabel || c.modelKey,
        family: c.family || 'Other',
        mode: c.mode || 'oneshot',
        spec: c.spec || 'freeform',
        promptId: c.promptId,
        promptTitle: c.promptTitle || c.promptId,
        category: c.category,
        categoryLabel: c.categoryLabel || c.category,
        stack:
          c.techStack?.primaryBackend && c.techStack.primaryBackend !== 'static-only'
            ? `${c.techStack.primaryFramework} + ${c.techStack.primaryBackend}`
            : c.techStack?.primaryFramework || 'vanilla',
        status: isFail ? 'FAIL' : 'PASS',
        score: numericScore,
        displayValue: a.displayValue || null,
        numericValue: a.numericValue ?? null,
        items: Array.isArray(a.items) ? a.items : [],
        cellLhScore: c.scores?.lighthouse ?? null,
        cellComposite: c.scores?.composite ?? null,
        mobileLcpMs: c.keyMetrics?.mobileLcpMs ?? null,
        inpMs: c.keyMetrics?.inpMs ?? null,
        hasStaticPreview: Boolean(c.hasStaticPreview),
        hasDesktopScreenshot: Boolean(c.hasDesktopScreenshot),
        buildSucceeded: Boolean(c.buildSucceeded),
      };

      entry.allCellRecords.push(cellRecord);
      if (isFail) {
        entry.failCount++;
        entry.failScores.push(numericScore);
        entry.failingCells.push(cellRecord);
      } else {
        entry.passCount++;
        entry.passingCells.push(cellRecord);
      }

      if (b) {
        const sb = entry.bySplit.get(b.key) || {
          key: b.key,
          label: b.label,
          failCount: 0,
          passCount: 0,
          applicableCount: 0,
        };
        sb.applicableCount++;
        if (isFail) sb.failCount++;
        else sb.passCount++;
        entry.bySplit.set(b.key, sb);
      }
    };

    for (const f of c.lighthouseAudits.failingAudits || []) recordCellAudit(f, true);
    for (const p of c.lighthouseAudits.passedAudits || []) recordCellAudit(p, false);
  }

  const avgNum = (arr) =>
    arr.length > 0 ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10 : null;

  const audits = Array.from(auditMap.values()).map((e) => {
    const denom = Math.max(1, e.applicableCount);
    return {
      ...e,
      failRatePct: Math.round((e.failCount / denom) * 1000) / 10,
      passRatePct: Math.round((e.passCount / denom) * 1000) / 10,
      avgScore: avgNum(e.scores),
      avgFailScore: avgNum(e.failScores),
    };
  });

  const splitColumns = Array.from(bucketTotals.values()).sort((a, b) => {
    if (splitBy === 'mode') return a.key === 'agent' ? -1 : 1;
    if (splitBy === 'spec') return a.key === 'freeform' ? -1 : 1;
    return b.total - a.total || a.label.localeCompare(b.label);
  });

  return {
    cellsAudited: auditedCells.length,
    splitColumns,
    auditMap,
    failingAudits: audits
      .filter((a) => a.failCount > 0)
      .sort((a, b) => b.failCount - a.failCount || (a.avgFailScore ?? 0) - (b.avgFailScore ?? 0)),
    universalPassingAudits: audits
      .filter((a) => a.failCount === 0 && a.passCount > 0)
      .sort((a, b) => b.passCount - a.passCount || a.id.localeCompare(b.id)),
    allAudits: audits.sort((a, b) => b.failCount - a.failCount || a.id.localeCompare(b.id)),
  };
}

function renderCorpusLighthouseBreakdown() {
  const panel = document.getElementById('lighthouse-corpus-panel');
  const pillsEl = document.getElementById('lh-corpus-filter-pills');
  const bodyEl = document.getElementById('lighthouse-corpus-body');
  const anyAudited = (state.data?.summary?.cells || []).some((c) => c.lighthouseAudits);

  if (!panel || !anyAudited) {
    panel?.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const analytics = computeCorpusLighthouseAnalytics();
  const failing = analytics.failingAudits;
  const passing = analytics.universalPassingAudits;
  const allChecks = analytics.allAudits;
  const splitCols = analytics.splitColumns;
  const matchesCat = (item, cat) => (item.categories || [item.category]).includes(cat);

  const filters = [
    { id: 'all-failures', label: `All Failing (${failing.length})` },
    { id: 'performance', label: `Perf Failures (${failing.filter((f) => matchesCat(f, 'performance')).length})` },
    { id: 'accessibility', label: `A11y Failures (${failing.filter((f) => matchesCat(f, 'accessibility')).length})` },
    { id: 'best-practices', label: `Best-Practice Failures (${failing.filter((f) => matchesCat(f, 'best-practices')).length})` },
    { id: 'seo', label: `SEO Failures (${failing.filter((f) => matchesCat(f, 'seo')).length})` },
    { id: 'universal-passes', label: `100% Universal Passes (${passing.length})` },
    { id: 'all-checks', label: `All Checks (${allChecks.length})` },
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

  if (analytics.cellsAudited === 0) {
    bodyEl.innerHTML = `<p class="panel-sub">No audited cells match the active Family / Lead / Spec slice filters.</p>`;
    return;
  }

  const q = state.lhSearchQuery.trim().toLowerCase();
  const filterBySearch = (list) =>
    !q
      ? list
      : list.filter(
          (item) =>
            item.id.toLowerCase().includes(q) ||
            item.title.toLowerCase().includes(q) ||
            (item.category || '').toLowerCase().includes(q)
        );

  const renderSplitBucketCell = (auditItem, sc, mode = 'fail') => {
    const sb = auditItem.bySplit.get(sc.key);
    if (!sb || sb.applicableCount === 0) {
      return `<td class="num mono"><span class="score-badge score-na">—</span></td>`;
    }
    if (mode === 'pass') {
      const pPct = Math.round((sb.passCount / sb.applicableCount) * 100);
      const cls = pPct === 100 ? 'score-good' : pPct >= 75 ? 'score-warn' : 'score-bad';
      return `<td class="num mono"><span class="score-badge ${cls}">${sb.passCount}/${sb.applicableCount} (${pPct}%)</span></td>`;
    }
    const fPct = Math.round((sb.failCount / sb.applicableCount) * 100);
    const cls = sb.failCount === 0 ? 'score-good' : fPct >= 40 ? 'score-bad' : 'score-warn';
    return `<td class="num mono"><span class="score-badge ${cls}">${sb.failCount}/${sb.applicableCount} fail (${fPct}%)</span></td>`;
  };

  if (state.lhCorpusFilter === 'universal-passes') {
    const shownPasses = filterBySearch(passing);
    if (shownPasses.length === 0) {
      bodyEl.innerHTML = `<p class="panel-sub">No universal 100%-passing checks match this filter across ${analytics.cellsAudited} audited sites.</p>`;
      return;
    }
    bodyEl.innerHTML = `
      <div class="table-surface">
        <table class="data-table lh-wrap-table">
          <thead>
            <tr>
              <th>Audit ID</th>
              <th class="col-wrap">Lighthouse Check Title (click to verify all sites)</th>
              <th>Category</th>
              <th class="num">Passed / Applicable</th>
              <th class="num">Pass Rate</th>
              ${splitCols.map((sc) => `<th class="num">${escapeHtml(sc.label)} (${sc.total})</th>`).join('')}
              <th>Verify</th>
            </tr>
          </thead>
          <tbody>
            ${shownPasses
              .map(
                (p) => `
                <tr class="lh-audit-row" data-open-lhaudit="${escapeHtml(p.id)}">
                  <td class="mono">${escapeHtml(p.id)}</td>
                  <td class="col-wrap">
                    <button type="button" class="lh-audit-title-btn" data-open-lhaudit="${escapeHtml(p.id)}">
                      <strong>${escapeHtml(p.title)}</strong>
                    </button>
                  </td>
                  <td><span class="lh-audit-cat">${escapeHtml(p.category)}</span></td>
                  <td class="num mono">${p.passCount} / ${p.applicableCount}</td>
                  <td class="num"><span class="score-badge score-good">${p.passRatePct}% PASS</span></td>
                  ${splitCols.map((sc) => renderSplitBucketCell(p, sc, 'pass')).join('')}
                  <td><button type="button" class="btn btn-ghost" style="padding:3px 9px;font-size:0.76rem" data-open-lhaudit="${escapeHtml(p.id)}">Inspect ${p.applicableCount} →</button></td>
                </tr>
              `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  } else {
    let baseList = failing;
    if (state.lhCorpusFilter === 'all-checks') baseList = allChecks;
    else if (state.lhCorpusFilter !== 'all-failures') {
      baseList = failing.filter((f) => matchesCat(f, state.lhCorpusFilter));
    }
    const filteredList = filterBySearch(baseList);

    if (filteredList.length === 0) {
      bodyEl.innerHTML = `<p class="panel-sub">Zero matching Lighthouse checks across ${analytics.cellsAudited} audited sites in this slice.</p>`;
      return;
    }

    bodyEl.innerHTML = `
      <div class="table-surface">
        <table class="data-table lh-wrap-table">
          <thead>
            <tr>
              <th>Audit ID</th>
              <th class="col-wrap">Lighthouse Check (click row to cross-check all ${analytics.cellsAudited} sites)</th>
              <th>Category</th>
              <th class="num">Failed / Applicable</th>
              <th class="num">Mean Score</th>
              ${splitCols.map((sc) => `<th class="num">${escapeHtml(sc.label)} (${sc.total})</th>`).join('')}
              <th class="col-wrap">Sample Failing Sites &amp; Cross-Check</th>
            </tr>
          </thead>
          <tbody>
            ${filteredList
              .slice(0, 60)
              .map((f) => {
                const rateCls =
                  f.failCount === 0
                    ? 'score-good'
                    : f.failRatePct >= 40
                      ? 'score-bad'
                      : f.failRatePct >= 15
                        ? 'score-warn'
                        : 'score-na';
                return `
                  <tr class="lh-audit-row" data-open-lhaudit="${escapeHtml(f.id)}">
                    <td class="mono">${escapeHtml(f.id)}</td>
                    <td class="col-wrap">
                      <button type="button" class="lh-audit-title-btn" data-open-lhaudit="${escapeHtml(f.id)}">
                        <strong>${escapeHtml(f.title)}</strong>
                      </button>
                    </td>
                    <td><span class="lh-audit-cat">${escapeHtml(f.category)}</span></td>
                    <td class="num"><span class="score-badge ${rateCls}">${f.failCount} / ${f.applicableCount} (${f.failRatePct}%)</span></td>
                    <td class="num mono">${f.avgScore != null ? f.avgScore : '—'}</td>
                    ${splitCols.map((sc) => renderSplitBucketCell(f, sc, 'fail')).join('')}
                    <td class="col-sites">
                      <div class="lh-chips-wrap">
                        ${(f.failingCells || [])
                          .slice(0, 5)
                          .map(
                            (fc) =>
                              `<button type="button" class="lh-site-chip score-warn" data-lh-cell="${escapeHtml(fc.cellId)}" title="${escapeHtml(`${fc.modelLabel} (${fc.mode}, ${fc.spec}) — ${fc.promptTitle}${fc.displayValue ? ` · ${fc.displayValue}` : ''}`)}">${escapeHtml(fc.modelLabel)} · ${escapeHtml(fc.promptTitle.split(' ')[0])} [${fc.mode === 'agent' ? 'pi' : '1s'}${fc.spec === 'guided' ? '·G' : ''}]</button>`
                          )
                          .join('')}
                        <button type="button" class="btn btn-secondary" style="padding:2px 8px;font-size:0.74rem" data-open-lhaudit="${escapeHtml(f.id)}">
                          All ${f.applicableCount} results →
                        </button>
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
  }

  for (const btn of bodyEl.querySelectorAll('[data-lh-cell]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCellInspectionDialog(btn.dataset.lhCell, 'lighthouse');
    });
  }

  for (const el of bodyEl.querySelectorAll('[data-open-lhaudit]')) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-lh-cell]')) return;
      e.stopPropagation();
      openLighthouseAuditDialog(el.dataset.openLhaudit);
    });
  }
}

function stripMarkdownLinksToPlainText(desc) {
  if (!desc) return '';
  return String(desc).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)');
}

function openLighthouseAuditDialog(auditId, { fromRouter = false } = {}) {
  if (!auditId) return;
  const dialog = document.getElementById('lh-audit-detail-dialog');
  const body = document.getElementById('lh-audit-dialog-body');
  const titleEl = document.getElementById('lh-audit-dialog-title');
  const eyebrowEl = document.getElementById('lh-audit-dialog-eyebrow');
  if (!dialog || !body) return;

  state.inspectedLhAuditId = auditId;
  state.lhModalStatusFilter = 'all';
  state.lhModalFamilyFilter = state.lhFamilyFilter.startsWith('model:') ? 'all' : state.lhFamilyFilter;
  state.lhModalLeadFilter = state.lhLeadFilter;
  state.lhModalSpecFilter = state.lhSpecFilter;
  state.lhModalSearch = '';
  if (!fromRouter) syncUrlFromState({ push: true });

  const fullCorpus = computeCorpusLighthouseAnalytics({ ignoreSliceFilters: true });
  const audit = fullCorpus.auditMap.get(auditId);

  if (!dialog.open) dialog.showModal();

  if (!audit) {
    eyebrowEl.textContent = 'Corpus Lighthouse Audit Verification';
    titleEl.textContent = auditId;
    body.innerHTML = `<div class="panel-card"><p>No cells in the current dataset recorded Lighthouse check <code>${escapeHtml(auditId)}</code>.</p></div>`;
    return;
  }

  eyebrowEl.textContent = `Lighthouse Check · ${(audit.categories || [audit.category]).join(' / ')} · ${audit.id}`;
  titleEl.textContent = audit.title;

  const records = audit.allCellRecords.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'FAIL' ? -1 : 1;
    if (a.score !== b.score) return a.score - b.score;
    return a.modelLabel.localeCompare(b.modelLabel) || a.promptTitle.localeCompare(b.promptTitle);
  });

  const buildBreakdownItems = (groupFn) => {
    const map = new Map();
    for (const r of records) {
      const { key, label } = groupFn(r);
      const cur = map.get(key) || { key, label, fail: 0, pass: 0, total: 0 };
      cur.total++;
      if (r.status === 'FAIL') cur.fail++;
      else cur.pass++;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.fail - a.fail || b.total - a.total);
  };

  const byFamily = buildBreakdownItems((r) => ({ key: r.family, label: r.family }));
  const byLead = buildBreakdownItems((r) => ({
    key: r.mode,
    label: r.mode === 'agent' ? 'Agent-Led (pi + Server)' : '1-Shot Stream',
  }));
  const bySpec = buildBreakdownItems((r) => ({
    key: r.spec,
    label: r.spec === 'guided' ? 'Guided (Ref + Design + Data)' : 'Free-form (Open Prompt)',
  }));

  const families = Array.from(new Set(records.map((r) => r.family))).sort();

  const renderSplitCardHtml = (heading, items) => `
    <div class="lh-split-card">
      <h4>${escapeHtml(heading)}</h4>
      ${items
        .map((it) => {
          const failPct = Math.round((it.fail / Math.max(1, it.total)) * 100);
          const badgeCls = it.fail === 0 ? 'score-good' : failPct >= 40 ? 'score-bad' : 'score-warn';
          return `
            <div class="lh-split-item">
              <span><strong>${escapeHtml(it.label)}</strong></span>
              <span class="score-badge ${badgeCls}">${it.fail} fail · ${it.pass} pass (${100 - failPct}% pass)</span>
            </div>
          `;
        })
        .join('')}
    </div>
  `;

  const descPlain = stripMarkdownLinksToPlainText(audit.description);

  body.innerHTML = `
    <div class="gauge-row">
      <div class="mini-gauge"><div class="val">${audit.failCount} / ${audit.applicableCount}</div><div class="lbl">Failed / Applicable</div></div>
      <div class="mini-gauge"><div class="val">${audit.passRatePct}%</div><div class="lbl">Corpus Pass Rate</div></div>
      <div class="mini-gauge"><div class="val">${audit.avgScore ?? '—'}</div><div class="lbl">Mean Audit Score</div></div>
      <div class="mini-gauge"><div class="val">${audit.avgFailScore ?? '—'}</div><div class="lbl">Mean Failing Score</div></div>
    </div>

    ${
      descPlain || audit.helpUrl
        ? `<div class="panel-card" style="margin-bottom:14px;padding:12px 15px">
             <p style="margin:0;font-size:0.85rem;color:var(--ink-secondary)">
               ${escapeHtml(descPlain)}
               ${audit.helpUrl ? ` <a href="${escapeHtml(audit.helpUrl)}" target="_blank" rel="noopener">Lighthouse Docs ↗</a>` : ''}
             </p>
           </div>`
        : ''
    }

    <div class="lh-split-grid">
      ${renderSplitCardHtml('By Model Family', byFamily)}
      ${renderSplitCardHtml('By Agent vs 1-Shot Lead', byLead)}
      ${renderSplitCardHtml('By Prompt Spec Mode', bySpec)}
    </div>

    <div class="transcript-toolbar">
      <div class="category-pills" style="margin:0" id="lh-modal-status-pills">
        <button type="button" class="cat-pill active" data-lhm-status="all">All (${records.length})</button>
        <button type="button" class="cat-pill" data-lhm-status="FAIL">Failing Only (${audit.failCount})</button>
        <button type="button" class="cat-pill" data-lhm-status="PASS">Passing Only (${audit.passCount})</button>
      </div>
      <div class="lh-corpus-controls">
        <label class="inline-select" for="lhm-family-sel">
          <span>Family</span>
          <select id="lhm-family-sel">
            <option value="all">All Families</option>
            ${families.map((f) => `<option value="${escapeHtml(f)}" ${state.lhModalFamilyFilter === f ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('')}
          </select>
        </label>
        <label class="inline-select" for="lhm-lead-sel">
          <span>Lead</span>
          <select id="lhm-lead-sel">
            <option value="all" ${state.lhModalLeadFilter === 'all' ? 'selected' : ''}>All Leads</option>
            <option value="agent" ${state.lhModalLeadFilter === 'agent' ? 'selected' : ''}>Agent-Led (pi)</option>
            <option value="oneshot" ${state.lhModalLeadFilter === 'oneshot' ? 'selected' : ''}>1-Shot</option>
          </select>
        </label>
        <label class="inline-select" for="lhm-spec-sel">
          <span>Spec</span>
          <select id="lhm-spec-sel">
            <option value="all" ${state.lhModalSpecFilter === 'all' ? 'selected' : ''}>All Specs</option>
            <option value="freeform" ${state.lhModalSpecFilter === 'freeform' ? 'selected' : ''}>Free-form</option>
            <option value="guided" ${state.lhModalSpecFilter === 'guided' ? 'selected' : ''}>Guided</option>
          </select>
        </label>
        <input id="lhm-search-input" class="transcript-search" type="search" placeholder="Filter model, prompt, value, selector..." />
      </div>
    </div>

    <div id="lh-modal-results-slot"></div>
  `;

  const renderModalTable = () => {
    const slot = document.getElementById('lh-modal-results-slot');
    if (!slot) return;
    const q = state.lhModalSearch.trim().toLowerCase();
    const filtered = records.filter((r) => {
      if (state.lhModalStatusFilter !== 'all' && r.status !== state.lhModalStatusFilter) return false;
      if (state.lhModalFamilyFilter !== 'all' && r.family !== state.lhModalFamilyFilter) return false;
      if (state.lhModalLeadFilter !== 'all' && r.mode !== state.lhModalLeadFilter) return false;
      if (state.lhModalSpecFilter !== 'all' && r.spec !== state.lhModalSpecFilter) return false;
      if (!q) return true;
      const itemText = (r.items || [])
        .map((it) => `${it.selector || ''} ${it.url || ''} ${it.nodeLabel || ''} ${it.snippet || ''}`)
        .join(' ');
      const hay = `${r.modelLabel} ${r.family} ${r.promptTitle} ${r.categoryLabel} ${r.stack} ${r.displayValue || ''} ${itemText}`.toLowerCase();
      return hay.includes(q);
    });

    if (filtered.length === 0) {
      slot.innerHTML = `<div class="panel-card"><p class="panel-sub" style="margin:0">No cell results match the selected filters.</p></div>`;
      return;
    }

    const isLiveStudio = !state.data?.staticMode;

    slot.innerHTML = `
      <div class="table-surface">
        <table class="data-table lh-wrap-table">
          <thead>
            <tr>
              <th>Status</th>
              <th class="num">Audit Score</th>
              <th>Model &amp; Family</th>
              <th>Lead &amp; Spec</th>
              <th class="col-wrap">Prompt &amp; Stack</th>
              <th class="col-wrap">Measured Value &amp; Evidence</th>
              <th class="num">Cell LH / LCP</th>
              <th>Cross-Check &amp; Verify</th>
            </tr>
          </thead>
          <tbody>
            ${filtered
              .map((r) => {
                const badgeCls = r.status === 'PASS' ? 'score-good' : r.score >= 50 ? 'score-warn' : 'score-bad';
                const canOpenSite = isLiveStudio ? r.buildSucceeded : r.hasStaticPreview;
                const siteHref = isLiveStudio
                  ? `./preview/${encodeURIComponent(r.cellId)}/`
                  : `./preview/${encodeURIComponent(r.cellId)}/index.html`;
                const evidenceHtml =
                  r.items && r.items.length > 0
                    ? `<ul class="lh-evidence-list">
                        ${r.items
                          .slice(0, 4)
                          .map((it) => {
                            const parts = [
                              it.selector || it.nodeLabel || '',
                              it.url || '',
                              it.wastedBytes ? `wasted ${Math.round(it.wastedBytes / 1024)}KB` : '',
                              it.wastedMs ? `${it.wastedMs}ms` : '',
                            ].filter(Boolean);
                            return `<li>${escapeHtml(parts.join(' · ') || it.snippet || '')}</li>`;
                          })
                          .join('')}
                      </ul>`
                    : '';
                return `
                  <tr>
                    <td><span class="score-badge ${badgeCls}">${r.status}</span></td>
                    <td class="num mono"><strong>${r.score}</strong></td>
                    <td>
                      <span class="model-cell-title">${escapeHtml(r.modelLabel)}</span>
                      <span class="model-cell-sub">${escapeHtml(r.family)}</span>
                    </td>
                    <td>
                      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
                        ${modeBadgeHtml(r.mode)}
                        ${specBadgeHtml(r.spec)}
                      </div>
                    </td>
                    <td class="col-wrap">
                      <strong>${escapeHtml(r.promptTitle)}</strong>
                      <span class="model-cell-sub">${escapeHtml(r.categoryLabel)} · <span class="fw-tag">${escapeHtml(r.stack)}</span></span>
                    </td>
                    <td class="col-wrap">
                      <span class="mono">${escapeHtml(r.displayValue || (r.status === 'PASS' ? 'Passed' : 'Failed check'))}</span>
                      ${evidenceHtml}
                    </td>
                    <td class="num mono">${fmtScore(r.cellLhScore)} / ${fmtMs(r.mobileLcpMs)}</td>
                    <td>
                      <div style="display:flex;flex-wrap:wrap;gap:5px">
                        <button type="button" class="btn btn-primary" style="padding:3px 8px;font-size:0.74rem" data-lhm-open-cell="${escapeHtml(r.cellId)}" data-dtab="lighthouse">Cell LH →</button>
                        <button type="button" class="btn btn-secondary" style="padding:3px 8px;font-size:0.74rem" data-lhm-open-cell="${escapeHtml(r.cellId)}" data-dtab="overview">Overview →</button>
                        ${
                          canOpenSite
                            ? `<a class="btn btn-ghost" style="padding:3px 8px;font-size:0.74rem" href="${escapeHtml(siteHref)}" target="_blank" rel="noopener">Site ↗</a>`
                            : ''
                        }
                        ${
                          r.hasDesktopScreenshot
                            ? `<a class="btn btn-ghost" style="padding:3px 8px;font-size:0.74rem" href="./artifacts/${encodeURIComponent(r.cellId)}/screenshots/desktop.png" target="_blank" rel="noopener">Shot ↗</a>`
                            : ''
                        }
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

    for (const btn of slot.querySelectorAll('[data-lhm-open-cell]')) {
      btn.addEventListener('click', () => {
        const cid = btn.dataset.lhmOpenCell;
        const tab = btn.dataset.dtab || 'lighthouse';
        dialog.close();
        openCellInspectionDialog(cid, tab);
      });
    }
  };

  renderModalTable();

  for (const btn of body.querySelectorAll('[data-lhm-status]')) {
    btn.addEventListener('click', () => {
      state.lhModalStatusFilter = btn.dataset.lhmStatus;
      for (const b of body.querySelectorAll('[data-lhm-status]')) {
        b.classList.toggle('active', b.dataset.lhmStatus === state.lhModalStatusFilter);
      }
      renderModalTable();
    });
  }
  document.getElementById('lhm-family-sel')?.addEventListener('change', (e) => {
    state.lhModalFamilyFilter = e.target.value;
    renderModalTable();
  });
  document.getElementById('lhm-lead-sel')?.addEventListener('change', (e) => {
    state.lhModalLeadFilter = e.target.value;
    renderModalTable();
  });
  document.getElementById('lhm-spec-sel')?.addEventListener('change', (e) => {
    state.lhModalSpecFilter = e.target.value;
    renderModalTable();
  });
  document.getElementById('lhm-search-input')?.addEventListener('input', (e) => {
    state.lhModalSearch = e.target.value;
    renderModalTable();
  });
}

function renderLeaderboard() {
  const pillBar = document.getElementById('category-filter-bar');
  const cats = state.data?.categories || [];
  const hasGuidedAny = (state.data?.summary?.cells || []).some((c) => c.spec === 'guided');
  const modeCells = (state.data?.summary?.cells || []).filter(
    (c) =>
      (state.selectedMode === 'all' || c.mode === state.selectedMode) &&
      (state.selectedSpec === 'all' || (c.spec || 'freeform') === state.selectedSpec)
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
        const rowSpec = r.spec || 'freeform';
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
        // Find top cell for this model+mode+spec so clicking a row can inspect or jump to matrix
        const sampleCell = (state.data?.summary?.cells || []).find(
          (c) =>
            c.modelKey === r.modelKey &&
            c.mode === r.mode &&
            (c.spec || 'freeform') === rowSpec &&
            (state.selectedCategory === 'all' || c.category === state.selectedCategory)
        );
        const modelLinkHref = sampleCell
          ? buildHashString({ cellId: sampleCell.cellId, dtab: 'overview' })
          : buildHashString({ view: 'matrix', mode: r.mode, spec: rowSpec, cellId: null });

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
            <td>
              <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
                ${modeBadgeHtml(r.mode)}
                ${hasGuidedAny || rowSpec === 'guided' ? specBadgeHtml(rowSpec) : ''}
              </div>
            </td>
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
  const pairs = (state.data?.summary?.modeComparison?.pairedHeadToHead || []).filter(
    (p) => state.selectedSpec === 'all' || (p.spec || 'freeform') === state.selectedSpec
  );
  if (pairs.length === 0) {
    h2hPanel.classList.add('hidden');
  } else {
    h2hPanel.classList.remove('hidden');
    h2hTbody.innerHTML = pairs
      .map((p) => {
        const deltaSign = p.deltaComposite > 0 ? `+${p.deltaComposite}` : `${p.deltaComposite}`;
        const deltaCls = p.deltaComposite >= 2 ? 'score-good' : p.deltaComposite <= -2 ? 'score-bad' : 'score-warn';
        const agentCellId = p.agentCellId || `${p.modelKey}__${p.promptId}__agent`;
        const oneshotCellId = p.oneshotCellId || `${p.modelKey}__${p.promptId}__oneshot`;
        return `
          <tr>
            <td><strong>${escapeHtml(p.modelLabel)}</strong> ${p.spec === 'guided' ? specBadgeHtml('guided') : ''}</td>
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

  // Paired Free-form vs Guided Spec Head-to-Head panel
  const specH2hPanel = document.getElementById('spec-head-to-head-panel');
  const specH2hTbody = document.getElementById('spec-h2h-tbody');
  const specPairs = (state.data?.summary?.specComparison?.pairedSpecHeadToHead || []).filter(
    (p) => state.selectedMode === 'all' || p.mode === state.selectedMode
  );
  if (!specH2hPanel || specPairs.length === 0) {
    specH2hPanel?.classList.add('hidden');
  } else {
    specH2hPanel.classList.remove('hidden');
    specH2hTbody.innerHTML = specPairs
      .map((p) => {
        const deltaSign = p.deltaComposite > 0 ? `+${p.deltaComposite}` : `${p.deltaComposite}`;
        const deltaCls = p.deltaComposite >= 2 ? 'score-good' : p.deltaComposite <= -2 ? 'score-bad' : 'score-warn';
        return `
          <tr>
            <td><strong>${escapeHtml(p.modelLabel)}</strong> ${modeBadgeHtml(p.mode)}</td>
            <td>${escapeHtml(p.promptTitle)}</td>
            <td class="num"><button type="button" class="matrix-cell-btn ${scoreClass(p.freeformComposite)}" data-spec-h2h-cell="${escapeHtml(p.freeformCellId)}">${fmtScore(p.freeformComposite)}</button></td>
            <td class="num"><button type="button" class="matrix-cell-btn ${scoreClass(p.guidedComposite)}" data-spec-h2h-cell="${escapeHtml(p.guidedCellId)}">${fmtScore(p.guidedComposite)}</button></td>
            <td class="num"><span class="score-badge ${deltaCls}">${deltaSign}</span></td>
            <td class="num mono">${fmtMs(p.freeformLcpMs)} / ${fmtMs(p.freeformInpMs)}</td>
            <td class="num mono">${fmtMs(p.guidedLcpMs)} / ${fmtMs(p.guidedInpMs)}</td>
          </tr>
        `;
      })
      .join('');
    for (const btn of specH2hTbody.querySelectorAll('[data-spec-h2h-cell]')) {
      btn.addEventListener('click', () => openCellInspectionDialog(btn.dataset.specH2hCell, 'overview'));
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
  const specFilter = state.selectedSpec;
  const hasGuidedAny = summary.cells.some((c) => c.spec === 'guided');
  const filteredCells = summary.cells.filter(
    (c) =>
      (modeFilter === 'all' || c.mode === modeFilter) &&
      (specFilter === 'all' || (c.spec || 'freeform') === specFilter)
  );

  const prompts = state.data.prompts.filter(
    (p) =>
      (catFilter === 'all' || p.category === catFilter) &&
      filteredCells.some((c) => c.promptId === p.id)
  );
  const models = summary.leaderboard.filter(
    (m) =>
      (modeFilter === 'all' || m.mode === modeFilter) &&
      (specFilter === 'all' || (m.spec || 'freeform') === specFilter)
  );

  const cellLookup = new Map();
  for (const c of filteredCells) {
    const sp = c.spec || 'freeform';
    cellLookup.set(`${c.modelKey}__${c.promptId}__${c.mode || 'oneshot'}__${sp}`, c);
  }

  let html = `<table class="matrix-table"><thead><tr><th>Model &amp; Track \\ Prompt</th>`;
  for (const p of prompts) {
    html += `<th title="${escapeHtml(p.prompt)}">${escapeHtml(p.title)}<span class="model-cell-sub">${escapeHtml(p.categoryLabel)}</span></th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const m of models) {
    const rowSpec = m.spec || 'freeform';
    const specSuffix = hasGuidedAny || rowSpec === 'guided' ? ` · ${rowSpec === 'guided' ? 'Guided' : 'Free-form'}` : '';
    html += `<tr><td><span class="model-cell-title">${escapeHtml(m.label)}</span> <span class="model-cell-sub">${m.mode === 'agent' ? 'Agent · pi' : '1-Shot'}${escapeHtml(specSuffix)}</span></td>`;
    for (const p of prompts) {
      const lookupKey = `${m.modelKey}__${p.id}__${m.mode}__${rowSpec}`;
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
    if (state.selectedSpec !== 'all' && (c.spec || 'freeform') !== state.selectedSpec) return false;
    if (kind === 'mode') return c.mode === val;
    if (kind === 'spec') return (c.spec || 'freeform') === val;
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
  if (kind === 'spec') {
    return val === 'guided'
      ? 'Spec Cohort: Guided (gemini-nano-banana-2.1 Layout + design.md + Seed Data)'
      : 'Spec Cohort: Free-form (Pure Open Prompt)';
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
        ? `<p class="panel-sub">No built sites match <code>${escapeHtml(state.selectedCohort)}</code> under the current Track/Spec filters (${escapeHtml(state.selectedMode)} / ${escapeHtml(state.selectedSpec)}).</p>`
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
                        ${c.spec === 'guided' ? specBadgeHtml('guided') : ''}
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
    (m) =>
      (state.selectedMode === 'all' || m.mode === state.selectedMode) &&
      (state.selectedSpec === 'all' || (m.spec || 'freeform') === state.selectedSpec)
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
      const tag = `${m.mode === 'agent' ? ' [pi' : ' [1s'}${m.spec === 'guided' ? '·G]' : ']'}`;

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
    ...(summary.specComparison?.bySpec || []).map((r) => ({
      cohortKey: `spec:${r.spec}`,
      label: `Spec: ${r.spec === 'guided' ? 'Guided (Ref Layout + design.md + Seed Data)' : 'Free-form (Open Prompt)'}`,
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

  const hasGuidedAny = cells.some((c) => c.spec === 'guided');
  const models = (state.data?.summary?.leaderboard || []).filter(
    (m) =>
      (state.selectedMode === 'all' || m.mode === state.selectedMode) &&
      (state.selectedSpec === 'all' || (m.spec || 'freeform') === state.selectedSpec)
  );
  const modOptions = models
    .map((m) => {
      const sp = m.spec || 'freeform';
      const val = `${m.modelKey}__${m.mode}__${sp}`;
      const tag = `${m.mode === 'agent' ? 'Agent · pi' : '1-Shot'}${hasGuidedAny || sp === 'guided' ? ` · ${sp === 'guided' ? 'Guided' : 'Free-form'}` : ''}`;
      return `<option value="${escapeHtml(val)}">${escapeHtml(m.label)} [${tag}]</option>`;
    })
    .join('');
  modASel.innerHTML = modOptions;
  modBSel.innerHTML = modOptions;

  const matchArenaOption = (sel, val) => {
    if (!val) return false;
    if (Array.from(sel.options).some((o) => o.value === val)) {
      sel.value = val;
      return true;
    }
    const legacy = `${val}__freeform`;
    if (Array.from(sel.options).some((o) => o.value === legacy)) {
      sel.value = legacy;
      return true;
    }
    return false;
  };

  matchArenaOption(modASel, state.arenaModelA);
  if (!matchArenaOption(modBSel, state.arenaModelB) && models.length > 1) {
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
  if (promptObj) {
    const refImg = (promptObj.guidedReferenceImages || promptObj.referenceImages || [])[0];
    const seed = promptObj.seedData || null;
    const refStripHtml =
      refImg || seed
        ? `<div class="arena-ref-strip">
             ${
               refImg
                 ? `<a href="./${escapeHtml(String(refImg.path || '').replace(/^\/+/, ''))}" target="_blank" rel="noopener" title="Open full-size gemini-nano-banana-2.1 proposed layout reference">
                      <img class="arena-ref-thumb" loading="lazy" src="./${escapeHtml(String(refImg.path || '').replace(/^\/+/, ''))}" alt="${escapeHtml(refImg.label || 'Reference layout')}" />
                    </a>`
                 : ''
             }
             <div style="flex:1;min-width:220px;font-size:0.82rem;color:var(--ink-secondary)">
               <strong style="color:var(--ink-primary)">Guided Reference Spec (${escapeHtml(promptObj.id)}):</strong>
               ${seed ? `Brand: <strong>${escapeHtml(seed.brandName || '')}</strong>${seed.tagline ? ` — <em>${escapeHtml(seed.tagline)}</em>` : ''}` : ''}
               ${seed?.address ? `<br/>Address: <span class="mono">${escapeHtml(seed.address)}</span>${seed.phone ? ` · ${escapeHtml(seed.phone)}` : ''}${seed.hours ? ` · ${escapeHtml(seed.hours)}` : ''}` : ''}
               <br/><span style="color:var(--ink-muted)">Attached in <code>--spec=guided</code> alongside <code>prompts/design.md</code> &amp; starter domain records; omitted in <code>--spec=freeform</code>.</span>
             </div>
           </div>`
        : '';
    banner.innerHTML = `<div><strong>${escapeHtml(promptObj.categoryLabel)} — ${escapeHtml(promptObj.title)}:</strong> “${escapeHtml(promptObj.prompt)}”</div>${refStripHtml}`;
  } else {
    banner.innerHTML = '';
  }

  const grid = document.getElementById('arena-split-grid');
  const cells = state.data?.summary?.cells || [];

  const renderPane = (rowSelector) => {
    if (!rowSelector) return '';
    const [modelKey, mode, specRaw] = rowSelector.split('__');
    const wantSpec = specRaw === 'guided' ? 'guided' : 'freeform';
    const cell = cells.find(
      (c) =>
        c.modelKey === modelKey &&
        c.promptId === promptId &&
        (c.mode || 'oneshot') === (mode || 'oneshot') &&
        (c.spec || 'freeform') === wantSpec
    );
    if (!cell) {
      return `<div class="arena-pane"><div class="panel-card"><p>No generated build yet for <code>${escapeHtml(rowSelector)}</code> on this prompt.</p></div></div>`;
    }
    const isLiveStudio = !state.data?.staticMode;
    const canEmbed = canEmbedCellLivePreview(cell, null);
    const iframeSrc = isLiveStudio
      ? `./preview/${encodeURIComponent(cell.cellId)}/`
      : `./preview/${encodeURIComponent(cell.cellId)}/index.html`;
    const stackBadge =
      cell.techStack?.primaryBackend && cell.techStack.primaryBackend !== 'static-only'
        ? `${cell.techStack.primaryFramework} + ${cell.techStack.primaryBackend}`
        : cell.techStack?.primaryFramework || 'vanilla';

    let previewPaneBody = '';
    if (!cell.buildSucceeded) {
      previewPaneBody = `<div class="panel-card"><p>Build failed: ${escapeHtml(cell.generationError || 'Unrunnable output')}</p></div>`;
    } else if (canEmbed) {
      previewPaneBody = `<iframe class="arena-iframe" sandbox="${PREVIEW_IFRAME_SANDBOX}" src="${escapeHtml(iframeSrc)}" title="${escapeHtml(cell.modelLabel)} preview"></iframe>`;
    } else if (cell.hasDesktopScreenshot) {
      previewPaneBody = `
        <div style="background:var(--bg-subtle);border-top:1px solid var(--border-subtle)">
          <div style="padding:8px 12px;font-size:0.78rem;color:var(--ink-secondary);display:flex;justify-content:space-between;align-items:center">
            <span>Server-rendered runtime snapshot (no static bundle exported for this older run — re-export or run locally to interact live)</span>
            <a href="./artifacts/${encodeURIComponent(cell.cellId)}/screenshots/desktop.png" target="_blank" rel="noopener">Full PNG ↗</a>
          </div>
          <img src="./artifacts/${encodeURIComponent(cell.cellId)}/screenshots/desktop.png" alt="${escapeHtml(cell.modelLabel)} captured screenshot" style="width:100%;display:block" />
        </div>`;
    } else {
      previewPaneBody = `<div class="panel-card"><p>No static preview bundle recorded for <code>${escapeHtml(cell.cellId)}</code>.</p></div>`;
    }

    return `
      <div class="arena-pane">
        <div class="arena-pane-header">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <strong>${escapeHtml(cell.modelLabel)}</strong>
            ${modeBadgeHtml(cell.mode)}
            ${specBadgeHtml(cell.spec || 'freeform')}
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
        ${previewPaneBody}
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
  const designDoc = state.data?.designDoc || '';

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
        <h3>2. Two-Track × Two-Spec Architecture (Free-form vs. Guided)</h3>
        <p class="panel-sub">Comparing unconstrained model priors (<code>freeform</code>) against structurally controlled apples-to-apples layouts (<code>guided</code>).</p>
        <div class="form-stack">
          <div class="turn-card">
            <div class="turn-card-header">
              <strong>Track A / B — Agent Loop (<code>pi</code> + <code>$PORT</code>) vs. 1-Shot Stream</strong>
              <div>${modeBadgeHtml('agent')} ${modeBadgeHtml('oneshot')}</div>
            </div>
            <p style="margin:0;font-size:0.84rem;color:var(--ink-secondary)">
              ${escapeHtml(cr.modeDesignRationale?.agent || 'Agent mode runs multi-turn with read/bash/edit/write tools and a real HTTP server bound to $PORT (plus an auto-captured static preview mirror for GitHub Pages); 1-Shot emits one self-contained HTML document.')}
            </p>
          </div>
          <div class="turn-card">
            <div class="turn-card-header">
              <strong>Spec 1 vs. Spec 2 — Free-form Open Prompt vs. Guided Reference Spec</strong>
              <div>${specBadgeHtml('freeform')} ${specBadgeHtml('guided')}</div>
            </div>
            <p style="margin:0;font-size:0.84rem;color:var(--ink-secondary)">
              <strong>Free-form (<code>--spec=freeform</code>):</strong> Dispatches only the natural 1-sentence prompt to observe raw visual &amp; architectural defaults.<br/>
              <strong>Guided (<code>--spec=guided</code>):</strong> Attaches a 1440×900 <code>gemini-nano-banana-2.1</code> proposed layout image + canonical company/domain seed data (<code>prompts/seed-data.json</code>) + stack-neutral <code>prompts/design.md</code> so CWV, INP, and memory comparisons hold visual complexity and content volume constant.
            </p>
          </div>
        </div>
      </article>

      <article class="panel-card">
        <h3>3. Guided Multimodal Assets: <code>gemini-nano-banana-2.1</code> + <code>seed-data.json</code> + <code>design.md</code></h3>
        <p class="panel-sub">Controlling for layout density and content payload across all 37 prompts with zero framework or speed steering.</p>
        <ul style="font-size:0.84rem;line-height:1.6;color:var(--ink-secondary);padding-left:18px;margin-top:4px">
          <li><strong>37 Proposed Layout Images:</strong> Pre-generated with <code>models/gemini-nano-banana-2.1</code> under <code>assets/reference-images/&lt;promptId&gt;.jpg</code> and attached multimodally in <code>guided</code> runs.</li>
          <li><strong>Canonical Company &amp; Domain Seed Data:</strong> Consistent brand name, street address, phone, email, hours, palette tokens, and starter records per prompt so models render identical text/card density.</li>
          <li><strong>Zero-Bias Validation:</strong> Every word of <code>prompts/index.json</code>, <code>prompts/design.md</code>, and <code>prompts/seed-data.json</code> passes <code>npm run validate</code> with zero framework, Lighthouse, or CWV hints.</li>
        </ul>
        <p class="panel-sub" style="margin-bottom:4px"><strong>Verbatim Visual Reference Instruction (Guided Mode):</strong></p>
        <div class="prompt-verbatim-box">${escapeHtml(gen.visualReferenceInstruction || '')}</div>
        ${
          designDoc
            ? `<details style="margin-top:8px">
                 <summary style="cursor:pointer;font-weight:600;font-size:0.85rem">View Verbatim <code>prompts/design.md</code> Specification</summary>
                 <pre class="code-viewer" style="max-height:220px;margin-top:8px;white-space:pre-wrap">${escapeHtml(designDoc)}</pre>
               </details>`
            : ''
        }
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

# Regenerate 37 layout reference mockups via gemini-nano-banana-2.1:
npm run generate:refs</pre>
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
        <pre class="code-viewer" style="max-height:115px"># Stage 1 (Free-form + Guided side-by-side generation, zero Chrome):
npm run bench:generate -- --pilot --mode=agent --spec=both

# Stage 2 (Dedicated runner, ZERO LLM secrets, Canary + Static Pages Mirror):
npm run bench:audit -- --pilot --spec=both --audit-runs=3</pre>
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
                  <span>${escapeHtml(p.title)}${p.requiresAuth ? ' 🔒' : ''}${(p.guidedReferenceImages || p.referenceImages || []).length ? ' 🖼' : ''}</span>
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
    const specVal = document.getElementById('opt-spec-mode')?.value || 'freeform';
    const modeMult = modeVal === 'both' ? 2 : 1;
    const specMult = specVal === 'both' ? 2 : 1;
    const modeDesc = modeVal === 'both' ? ' × 2 leads' : ` (${modeVal})`;
    const specDesc = specVal === 'both' ? ' × 2 specs (freeform+guided)' : ` [${specVal}]`;
    document.getElementById('run-scope-estimate').textContent = `${mCount} models × ${pCount} prompts${modeDesc}${specDesc} = ${mCount * pCount * modeMult * specMult} cells (${bCount} pillars)`;
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
  const cellMode =
    detail.generation?.mode === 'agent' || cellId.includes('__agent') ? 'agent' : 'oneshot';
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
  const canEmbedLive = canEmbedCellLivePreview(summaryCell, detail);
  const hasDesktopShot = Boolean(summaryCell?.hasDesktopScreenshot);
  const hasMobileShot = Boolean(summaryCell?.hasMobileScreenshot);
  const previewHref = isLiveStudio
    ? detail.livePreviewUrl || `./preview/${encodeURIComponent(cellId)}/`
    : `./preview/${encodeURIComponent(cellId)}/index.html`;

  let effectiveViewMode = state.previewViewMode || 'live';
  if (effectiveViewMode === 'live' && !canEmbedLive) {
    effectiveViewMode = hasDesktopShot ? 'desktop-shot' : hasMobileShot ? 'mobile-shot' : 'live';
  }
  if (effectiveViewMode === 'desktop-shot' && !hasDesktopShot) effectiveViewMode = canEmbedLive ? 'live' : 'mobile-shot';
  if (effectiveViewMode === 'mobile-shot' && !hasMobileShot) effectiveViewMode = canEmbedLive ? 'live' : 'desktop-shot';

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

  let previewFrameHtml = '';
  if (!detail.materialization?.ok) {
    previewFrameHtml = `<div class="panel-card"><p>Materialization failed: ${escapeHtml(detail.materialization?.error || 'Unknown error')}</p></div>`;
  } else if (effectiveViewMode === 'live' && canEmbedLive) {
    previewFrameHtml = `<iframe sandbox="${PREVIEW_IFRAME_SANDBOX}" src="${escapeHtml(previewHref)}" title="Live generated webpage"></iframe>`;
  } else if (effectiveViewMode === 'mobile-shot' && hasMobileShot) {
    previewFrameHtml = `<div style="background:var(--bg-subtle);display:flex;justify-content:center;padding:12px"><img src="./artifacts/${encodeURIComponent(cellId)}/screenshots/mobile.png" alt="Captured mobile audit screenshot" style="max-height:430px;width:auto;border-radius:8px;box-shadow:var(--shadow-sm)" /></div>`;
  } else if (hasDesktopShot) {
    previewFrameHtml = `
      ${
        !canEmbedLive
          ? `<div style="padding:7px 12px;font-size:0.77rem;background:var(--bg-subtle);color:var(--ink-secondary);border-bottom:1px solid var(--border-subtle)">
               Showing audit desktop screenshot (re-export this run to bundle interactive static Pages mirror for full-stack server workspaces).
             </div>`
          : ''
      }
      <img src="./artifacts/${encodeURIComponent(cellId)}/screenshots/desktop.png" alt="Captured desktop audit preview" style="width:100%;display:block" />
    `;
  } else {
    previewFrameHtml = `<div class="panel-card"><p>No hosted static preview or screenshot recorded for this cell.</p></div>`;
  }

  const showViewModePills = detail.materialization?.ok && (canEmbedLive ? hasDesktopShot || hasMobileShot : hasDesktopShot && hasMobileShot);

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
        <div class="preview-header-bar">
          <h3 style="margin:0">
            Interactive Live Preview
            ${isProdServer ? '<span class="mode-badge mode-agent">Live $PORT Production Server</span>' : canEmbedLive ? '<span class="mode-badge mode-oneshot">Hosted Preview Bundle</span>' : '<span class="fw-tag">Captured Audit Snapshot</span>'}
          </h3>
          ${
            showViewModePills
              ? `<div class="preview-mode-pills">
                  ${canEmbedLive ? `<button type="button" class="preview-mode-pill ${effectiveViewMode === 'live' ? 'active' : ''}" data-pview="live">Live Site</button>` : ''}
                  ${hasDesktopShot ? `<button type="button" class="preview-mode-pill ${effectiveViewMode === 'desktop-shot' ? 'active' : ''}" data-pview="desktop-shot">Desktop Shot</button>` : ''}
                  ${hasMobileShot ? `<button type="button" class="preview-mode-pill ${effectiveViewMode === 'mobile-shot' ? 'active' : ''}" data-pview="mobile-shot">Mobile Shot</button>` : ''}
                </div>`
              : ''
          }
        </div>
        <div class="preview-frame-box">
          ${previewFrameHtml}
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
            <span><strong>Exact Prompt Summary</strong> ${specBadgeHtml(detail.exactPrompt?.spec || detail.generation?.spec || 'freeform')}</span>
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

  for (const pbtn of body.querySelectorAll('[data-pview]')) {
    pbtn.addEventListener('click', () => {
      state.previewViewMode = pbtn.dataset.pview;
      renderCellOverviewTab(detail, summaryCell);
    });
  }

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
  const cellSpec = ep.spec || gen.spec || 'freeform';
  const seedData = ep.seedData || (cellSpec === 'guided' ? detail.promptEntry?.seedData : null);
  const designDoc = cellSpec === 'guided' ? state.data?.designDoc || '' : '';

  body.innerHTML = `
    <div class="detail-grid-2">
      <div>
        <h3>Exact Natural User Prompt ${specBadgeHtml(cellSpec)}</h3>
        <p class="panel-sub">Zero speed, framework, Lighthouse, or quality keywords allowed.</p>
        <div class="prompt-verbatim-box">${escapeHtml(ep.userPrompt || detail.promptEntry?.prompt || '')}</div>

        ${
          refImages.length > 0
            ? `<h3>Attached Multimodal Reference Layout Image(s) (<code>gemini-nano-banana-2.1</code>)</h3>
               <div class="ref-images-grid">
                 ${refImages
                   .map(
                     (img) => `
                     <div class="ref-image-card">
                       <a href="./${escapeHtml(String(img.path || '').replace(/^\/+/, ''))}" target="_blank" rel="noopener">
                         <img src="./${escapeHtml(String(img.path || '').replace(/^\/+/, ''))}" alt="${escapeHtml(img.label || 'Style reference')}" />
                       </a>
                       <p class="panel-sub" style="margin:6px 0 0">${escapeHtml(img.label || img.path)}</p>
                     </div>
                   `
                   )
                   .join('')}
               </div>`
            : `<p class="panel-sub"><em>Reference Style Images:</em> None attached in <code>freeform</code> mode (unconstrained visual design — run with <code>--spec=guided</code> to attach the <code>gemini-nano-banana-2.1</code> layout reference, <code>design.md</code>, and canonical seed data).</p>`
        }

        ${
          seedData
            ? `<details style="margin-top:12px" open>
                 <summary style="cursor:pointer;font-weight:600;font-size:0.88rem">Canonical Brand, Address &amp; Domain Seed Data (<code>prompts/seed-data.json</code>)</summary>
                 <pre class="code-viewer" style="max-height:220px;margin-top:8px;white-space:pre-wrap">${escapeHtml(JSON.stringify(seedData, null, 2))}</pre>
               </details>`
            : ''
        }

        ${
          designDoc
            ? `<details style="margin-top:12px">
                 <summary style="cursor:pointer;font-weight:600;font-size:0.88rem">Attached UI Design Specification (<code>prompts/design.md</code>)</summary>
                 <pre class="code-viewer" style="max-height:220px;margin-top:8px;white-space:pre-wrap">${escapeHtml(designDoc)}</pre>
               </details>`
            : ''
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
                <tr><td><strong>Prompt Spec Mode</strong></td><td>${specBadgeHtml(cellSpec)}</td></tr>
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
              <th class="col-wrap">Measured Value &amp; Evidence</th>
              <th>Corpus Cross-Check</th>
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
                const evidenceHtml =
                  Array.isArray(a.items) && a.items.length > 0
                    ? `<ul class="lh-evidence-list">
                        ${a.items
                          .slice(0, 4)
                          .map((it) => {
                            const parts = [
                              it.selector || it.nodeLabel || '',
                              it.url || '',
                              it.wastedBytes ? `wasted ${Math.round(it.wastedBytes / 1024)}KB` : '',
                              it.wastedMs ? `${it.wastedMs}ms` : '',
                            ].filter(Boolean);
                            return `<li>${escapeHtml(parts.join(' · ') || it.snippet || '')}</li>`;
                          })
                          .join('')}
                      </ul>`
                    : '';
                return `
                  <tr>
                    <td><span class="score-badge ${badgeCls}">${a.status}</span></td>
                    <td>${catBadges}</td>
                    <td class="mono">${escapeHtml(a.id)}</td>
                    <td class="col-wrap"><strong>${escapeHtml(a.title)}</strong></td>
                    <td class="num mono">${a.score ?? (a.status === 'PASS' ? 100 : 0)}</td>
                    <td class="col-wrap">
                      <span class="mono">${escapeHtml(a.displayValue || '—')}</span>
                      ${evidenceHtml}
                    </td>
                    <td>
                      <button type="button" class="btn btn-ghost" style="padding:3px 9px;font-size:0.75rem" data-cell-crosscheck-lh="${escapeHtml(a.id)}">
                        All Models →
                      </button>
                    </td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    for (const btn of slot.querySelectorAll('[data-cell-crosscheck-lh]')) {
      btn.addEventListener('click', () => {
        const aid = btn.dataset.cellCrosscheckLh;
        document.getElementById('cell-detail-dialog')?.close();
        openLighthouseAuditDialog(aid);
      });
    }
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
  state.previewViewMode = 'live';
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
  const cellMode =
    detail.generation?.mode === 'agent' || cellId.includes('__agent') ? 'agent' : 'oneshot';
  const cellSpec = detail.generation?.spec || (cellId.endsWith('__guided') ? 'guided' : 'freeform');
  const modeLabel = cellMode === 'agent' ? 'Agent Loop (pi + $PORT Server)' : '1-Shot Stream';
  const specLabel = cellSpec === 'guided' ? 'Guided Spec' : 'Free-form Spec';
  eyebrowEl.textContent = `${modeLabel} · ${specLabel} · ${detail.promptEntry?.categoryLabel || ''} · ${detail.generation?.provider}/${detail.generation?.modelId}`;
  titleEl.textContent = `${summaryCell?.modelLabel || detail.generation?.modelKey} — ${detail.promptEntry?.title || detail.generation?.promptId}`;

  const isLiveStudio = !state.data?.staticMode;
  const canEmbedLive = canEmbedCellLivePreview(summaryCell, detail);
  const previewHref = isLiveStudio
    ? detail.livePreviewUrl || `./preview/${encodeURIComponent(cellId)}/`
    : `./preview/${encodeURIComponent(cellId)}/index.html`;

  if (canEmbedLive) {
    openTabLink.href = previewHref;
    openTabLink.textContent = 'Open Site ↗';
    openTabLink.classList.remove('hidden');
  } else if (summaryCell?.hasDesktopScreenshot) {
    openTabLink.href = `./artifacts/${encodeURIComponent(cellId)}/screenshots/desktop.png`;
    openTabLink.textContent = 'Open Screenshot ↗';
    openTabLink.classList.remove('hidden');
  } else {
    openTabLink.classList.add('hidden');
  }
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
  const lhFamilySel = document.getElementById('lh-family-select');
  const cats = state.data?.categories || [];

  matCat.innerHTML =
    `<option value="all">All 10 Categories</option>` +
    cats.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join('');
  matCat.value = state.matrixCategory;

  promptCat.innerHTML = cats
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`)
    .join('');

  if (lhFamilySel) {
    const cells = state.data?.summary?.cells || [];
    const families = Array.from(new Set(cells.map((c) => c.family || 'Other').filter(Boolean))).sort();
    const modelsMap = new Map();
    for (const c of cells) {
      if (c.modelKey && !modelsMap.has(c.modelKey)) {
        modelsMap.set(c.modelKey, c.modelLabel || c.modelKey);
      }
    }
    lhFamilySel.innerHTML =
      `<option value="all">All Model Families</option>` +
      (families.length > 0
        ? `<optgroup label="Model Families">` +
          families.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('') +
          `</optgroup>`
        : '') +
      (modelsMap.size > 0
        ? `<optgroup label="Individual Models">` +
          Array.from(modelsMap.entries())
            .map(([k, lbl]) => `<option value="model:${escapeHtml(k)}">${escapeHtml(lbl)}</option>`)
            .join('') +
          `</optgroup>`
        : '');
    if (Array.from(lhFamilySel.options).some((o) => o.value === state.lhFamilyFilter)) {
      lhFamilySel.value = state.lhFamilyFilter;
    }
  }
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
  document.getElementById('copy-lh-audit-link-btn')?.addEventListener('click', (e) => {
    copyCurrentUrlWithFeedback(e.currentTarget);
  });

  // Primary navigation <a class="tab-btn" href="#/..."> links (preserve modifier-clicks for open-in-new-tab!)
  for (const link of document.querySelectorAll('.tab-btn[data-view]')) {
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      state.inspectedCellId = null;
      state.inspectedLhAuditId = null;
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

  // Clear cell / Lighthouse audit URL params when dialogs close
  document.getElementById('cell-detail-dialog')?.addEventListener('close', () => {
    if (state.inspectedCellId) {
      state.inspectedCellId = null;
      syncUrlFromState({ push: false });
    }
  });
  document.getElementById('lh-audit-detail-dialog')?.addEventListener('close', () => {
    if (state.inspectedLhAuditId) {
      state.inspectedLhAuditId = null;
      syncUrlFromState({ push: false });
    }
  });

  // Global Mode + Spec + Matrix + Lighthouse Corpus controls
  document.getElementById('global-mode-select').addEventListener('change', (e) => {
    state.selectedMode = e.target.value;
    syncUrlFromState({ push: false });
    renderLeaderboard();
    renderMatrix();
    renderTechObservatory();
    renderArenaSelectors();
  });

  document.getElementById('global-spec-select')?.addEventListener('change', (e) => {
    state.selectedSpec = e.target.value;
    syncUrlFromState({ push: false });
    renderLeaderboard();
    renderMatrix();
    renderTechObservatory();
    renderArenaSelectors();
  });

  document.getElementById('lh-split-select')?.addEventListener('change', (e) => {
    state.lhSplitBy = e.target.value;
    syncUrlFromState({ push: false });
    renderCorpusLighthouseBreakdown();
  });
  document.getElementById('lh-family-select')?.addEventListener('change', (e) => {
    state.lhFamilyFilter = e.target.value;
    syncUrlFromState({ push: false });
    renderCorpusLighthouseBreakdown();
  });
  document.getElementById('lh-lead-select')?.addEventListener('change', (e) => {
    state.lhLeadFilter = e.target.value;
    syncUrlFromState({ push: false });
    renderCorpusLighthouseBreakdown();
  });
  document.getElementById('lh-spec-select')?.addEventListener('change', (e) => {
    state.lhSpecFilter = e.target.value;
    syncUrlFromState({ push: false });
    renderCorpusLighthouseBreakdown();
  });
  document.getElementById('lh-search-input')?.addEventListener('input', (e) => {
    state.lhSearchQuery = e.target.value;
    renderCorpusLighthouseBreakdown();
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
      spec: document.getElementById('opt-spec-mode')?.value || 'freeform',
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
      spec: state.inspectedCell.generation.spec || 'freeform',
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
