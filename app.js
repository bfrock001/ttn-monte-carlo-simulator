/* ============================================================
   Through the Noise — Monte Carlo Portfolio Simulation
   Phase 1: data layer + asset class reference table
   ============================================================ */

'use strict';

const STATE = {
  data: null,            // parsed simba_returns_data.json
  assets: [],            // array of asset records (key, name, ticker, group, ...)
  period: 'modern',      // 'native' | 'postwar' | 'modern' | 'custom'
  customRange: { start: 1976, end: 2025 }, // reference-table custom range
  sort: { key: 'cagr', dir: 'desc' },
};

const GROUP_ORDER = ['US Equity', 'International Equity', 'Fixed Income', 'Alternatives'];

const PERIOD_LABELS = {
  native:  { name: 'Full Data Set',          start: 1871, end: 2025 },
  postwar: { name: 'Post-WWII (1946–2025)',  start: 1946, end: 2025 },
  modern:  { name: 'Modern era (1976–2025)', start: 1976, end: 2025 },
  custom:  { name: 'Custom range',           start: null, end: null }, // populated from STATE.customRange
};

const DATA_URL = './simba_returns_data%20(1).json';

/* -----------------------------------------------------------
   Boot
   ----------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  loadData().catch((err) => showError(err.message || String(err)));
});

async function loadData() {
  const res = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(
      `Unable to load historical return data (${res.status}). Please check that simba_returns_data.json is in the project root and refresh the page.`
    );
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(
      'Historical return data could not be parsed. The file may be malformed.'
    );
  }

  validateSchema(json);
  applyDataQualityOverrides(json);

  STATE.data = json;
  STATE.assets = buildAssetList(json.assets);

  hideElement('loading-state');
  showElement('app-layout');
  showElement('reference-section');

  bindPeriodToggle();
  bindSortHeaders();
  render();

  // Phase 3 input panel — initialized once data is available
  initInputPanel();
}

function validateSchema(json) {
  for (const key of ['metadata', 'assets', 'annual_returns']) {
    if (!json[key]) {
      throw new Error(
        `Historical return data is missing the required '${key}' section. Please check simba_returns_data.json.`
      );
    }
  }
  if (!Array.isArray(json.annual_returns) || json.annual_returns.length === 0) {
    throw new Error('Historical return data contains no annual return rows.');
  }
  if (typeof json.assets !== 'object' || Object.keys(json.assets).length === 0) {
    throw new Error('Historical return data contains no asset definitions.');
  }
}

/* -----------------------------------------------------------
   Data quality overrides
   -----------------------------------------------------------
   Real US Treasury TIPS were first issued in January 1997.
   The Simba dataset labels its 1985–1996 TIPS values as "native"
   but they're really proxy/reconstructed series. Per editorial
   direction we treat TIPS as having real data only from 1997+:
   null out pre-1997 values, update the asset's metadata, and
   recompute the cached stats blocks from the filtered rows.
   Source JSON file is not modified — this runs at load time.
   ----------------------------------------------------------- */
const TIPS_REAL_START = 1997;

function applyDataQualityOverrides(json) {
  // 1. Null out TIPS values before the real-issuance year.
  for (const row of json.annual_returns) {
    if (row.year < TIPS_REAL_START) row.tips = null;
  }
  if (!json.assets || !json.assets.tips) return;

  // 2. Update TIPS metadata.
  json.assets.tips.native_start = TIPS_REAL_START;
  json.assets.tips.splice_note =
    `Real TIPS data from ${TIPS_REAL_START} only (US Treasury TIPS inception). Pre-${TIPS_REAL_START} spliced/proxy data removed.`;

  // 3. Recompute cached stats blocks (native / postwar / modern) from filtered rows.
  json.assets.tips.stats = {
    native:  computeAssetStatsForRangeRaw(json, 'tips', 1871, 2025),
    postwar: computeAssetStatsForRangeRaw(json, 'tips', 1946, 2025),
    modern:  computeAssetStatsForRangeRaw(json, 'tips', 1976, 2025),
  };
}

function computeAssetStatsForRangeRaw(json, key, start, end) {
  // Same math as computeAssetStatsForRange, but operates on the raw json
  // before STATE is populated. Used by the data-quality override path.
  const returns = [];
  const tbills  = [];
  let firstYear = null;
  for (const row of json.annual_returns) {
    if (row.year < start || row.year > end) continue;
    if (row[key] == null) continue;
    returns.push(row[key]);
    if (row.st_tbills != null) tbills.push(row.st_tbills);
    if (firstYear == null) firstYear = row.year;
  }
  const n = returns.length;
  if (n === 0) {
    return { mean: 0, std: 0, cagr: 0, min: 0, max: 0, n: 0, sharpe: 0, avg_rf: 0, first_year: null };
  }
  let mean = 0; for (const v of returns) mean += v; mean /= n;
  let variance = 0; for (const v of returns) { const d = v - mean; variance += d * d; } variance /= n;
  const std = Math.sqrt(variance);
  let logSum = 0; for (const v of returns) logSum += Math.log(1 + v / 100);
  const cagr = (Math.exp(logSum / n) - 1) * 100;
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const avg_rf = tbills.length ? tbills.reduce((a, b) => a + b, 0) / tbills.length : 0;
  const sharpe = std > 0 ? (mean - avg_rf) / std : 0;
  return { mean, std, cagr, min, max, n, sharpe, avg_rf, first_year: firstYear };
}

function buildAssetList(assetsObj) {
  return Object.values(assetsObj).map((a) => ({
    ...a,
    quality: classifyQuality(a),
  }));
}

/* -----------------------------------------------------------
   Data quality classification
   ----------------------------------------------------------- */
function classifyQuality(asset) {
  const note = (asset.splice_note || '').toLowerCase();
  const start = asset.native_start;
  if (note.startsWith('native')) return 'native';
  if (note.includes('spliced')) {
    if (start <= 1927) return 'early-splice';
    if (start >= 1969 && start <= 1979) return 'late-splice';
    if (start >= 1980) return 'limited';
    return 'early-splice';
  }
  if (start >= 1980) return 'limited';
  return 'native';
}

const QUALITY_INFO = {
  'native':       { label: 'Native 1871',   className: 'badge--native' },
  'early-splice': { label: 'Spliced <1927', className: 'badge--early-splice' },
  'late-splice':  { label: 'Spliced 1970+', className: 'badge--late-splice' },
  'limited':      { label: 'Limited history', className: 'badge--limited' },
};

/* -----------------------------------------------------------
   Period selection (toggle)
   ----------------------------------------------------------- */
function bindPeriodToggle() {
  // Period buttons
  document.querySelectorAll('.period-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const period = btn.dataset.period;
      if (!period || period === STATE.period) return;
      STATE.period = period;
      document.querySelectorAll('.period-btn').forEach((b) => {
        const active = b.dataset.period === period;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.getElementById('ref-custom-range').hidden = period !== 'custom';
      render();
    });
  });

  // Populate the custom-range year dropdowns once.
  const startSel = document.getElementById('ref-custom-start');
  const endSel   = document.getElementById('ref-custom-end');
  if (startSel && startSel.options.length === 0) {
    for (let y = 1871; y <= 2020; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === STATE.customRange.start) opt.selected = true;
      startSel.appendChild(opt);
    }
    startSel.addEventListener('change', () => {
      STATE.customRange.start = parseInt(startSel.value, 10);
      validateAndRenderCustomRange();
    });
  }
  if (endSel && endSel.options.length === 0) {
    for (let y = 1876; y <= 2025; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === STATE.customRange.end) opt.selected = true;
      endSel.appendChild(opt);
    }
    endSel.addEventListener('change', () => {
      STATE.customRange.end = parseInt(endSel.value, 10);
      validateAndRenderCustomRange();
    });
  }
}

function validateAndRenderCustomRange() {
  const errEl = document.getElementById('ref-custom-range-error');
  const gap = STATE.customRange.end - STATE.customRange.start;
  if (errEl) errEl.hidden = gap >= 5;
  if (gap < 5) return; // skip render when range is invalid
  render();
}

/* -----------------------------------------------------------
   Sort behavior
   ----------------------------------------------------------- */
function bindSortHeaders() {
  document.querySelectorAll('#ref-table thead th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const type = th.dataset.type;
      if (!key) return;
      if (STATE.sort.key === key) {
        STATE.sort.dir = STATE.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        STATE.sort.key = key;
        STATE.sort.dir = type === 'num' ? 'desc' : 'asc';
      }
      render();
    });
  });
}

/* -----------------------------------------------------------
   Render: subtitle, summary strip, warning, table
   ----------------------------------------------------------- */
function render() {
  const periodKey = STATE.period;
  const rows = buildRowsForPeriod(periodKey);

  renderSubtitle(rows);
  renderSummaryStrip(rows);
  renderWarning(rows, periodKey);
  renderSortIndicators();
  renderTable(rows);
}

function buildRowsForPeriod(periodKey) {
  // Each row joins asset metadata with the period stats block.
  // For native/postwar/modern, stats are pre-computed in the JSON.
  // For 'custom', we recompute stats on the fly from annual_returns over the
  // user-selected [start, end] window. Assets with no rows in the window are
  // dropped from the table.
  if (periodKey === 'custom') {
    const { start, end } = STATE.customRange;
    return STATE.assets
      .map((a) => {
        const stats = computeAssetStatsForRange(a, start, end);
        if (!stats || stats.n === 0) return null;
        return {
          key: a.key, name: a.name, ticker: a.ticker, group: a.group,
          native_start: a.native_start, splice_note: a.splice_note, quality: a.quality,
          ...stats,
        };
      })
      .filter(Boolean);
  }
  return STATE.assets
    .map((a) => {
      const stats = a.stats?.[periodKey];
      if (!stats || stats.n == null) return null;
      return {
        key: a.key,
        name: a.name,
        ticker: a.ticker,
        group: a.group,
        native_start: a.native_start,
        splice_note: a.splice_note,
        quality: a.quality,
        first_year: stats.first_year,
        n: stats.n,
        cagr: stats.cagr,
        mean: stats.mean,
        std: stats.std,
        sharpe: stats.sharpe,
        min: stats.min,
        max: stats.max,
        avg_rf: stats.avg_rf,
      };
    })
    .filter(Boolean);
}

function computeAssetStatsForRange(asset, start, end) {
  if (!STATE.data) return null;
  const key = asset.key;
  const returns = [];
  const tbills = [];
  let firstYear = null;
  for (const row of STATE.data.annual_returns) {
    if (row.year < start || row.year > end) continue;
    if (row[key] == null) continue;
    returns.push(row[key]);
    if (row.st_tbills != null) tbills.push(row.st_tbills);
    if (firstYear == null) firstYear = row.year;
  }
  const n = returns.length;
  if (n === 0) return null;

  let mean = 0; for (const v of returns) mean += v; mean /= n;
  let variance = 0; for (const v of returns) { const d = v - mean; variance += d * d; } variance /= n;
  const std = Math.sqrt(variance);
  let logSum = 0; for (const v of returns) logSum += Math.log(1 + v / 100);
  const cagr = (Math.exp(logSum / n) - 1) * 100;
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const avg_rf = tbills.length ? tbills.reduce((a, b) => a + b, 0) / tbills.length : 0;
  const sharpe = std > 0 ? (mean - avg_rf) / std : 0;

  return { mean, std, cagr, min, max, n, sharpe, avg_rf, first_year: firstYear };
}

function renderSubtitle(rows) {
  const el = document.getElementById('reference-sub');
  if (!el) return;
  const totalYears = STATE.data.metadata.total_years;
  const totalAssets = Object.keys(STATE.data.assets).length;
  const shown = rows.length;
  const periodLabel = STATE.period === 'custom'
    ? `Custom range (${STATE.customRange.start}–${STATE.customRange.end})`
    : PERIOD_LABELS[STATE.period].name;
  el.textContent =
    `${totalAssets} asset classes · ${totalYears} years of annual data (1871–2025) · ` +
    `Showing ${shown} assets for ${periodLabel}.`;
}

function renderSummaryStrip(rows) {
  const ul = document.getElementById('summary-strip');
  if (!ul) return;

  const highestCagr = rows.reduce((best, r) => (r.cagr > (best?.cagr ?? -Infinity) ? r : best), null);
  const bestSharpe  = rows.reduce((best, r) => (r.sharpe > (best?.sharpe ?? -Infinity) ? r : best), null);

  const usEquity = rows.filter((r) => r.group === 'US Equity');
  const avgUsCagr = usEquity.length
    ? usEquity.reduce((s, r) => s + r.cagr, 0) / usEquity.length
    : null;

  // Average risk-free rate: take from ST T-Bills row if present, else mean of avg_rf.
  const tbillsRow = rows.find((r) => r.key === 'st_tbills');
  const avgRf = tbillsRow
    ? tbillsRow.cagr
    : (rows.reduce((s, r) => s + (r.avg_rf || 0), 0) / Math.max(1, rows.length));

  ul.innerHTML = '';
  ul.appendChild(summaryCell('Highest CAGR',  highestCagr ? `${fmtPct(highestCagr.cagr)}` : '—', highestCagr ? highestCagr.name : ''));
  ul.appendChild(summaryCell('Best Sharpe',   bestSharpe  ? `${fmtNum(bestSharpe.sharpe, 3)}` : '—', bestSharpe ? bestSharpe.name : ''));
  ul.appendChild(summaryCell('Avg US Equity CAGR', avgUsCagr != null ? fmtPct(avgUsCagr) : '—', `${usEquity.length} assets`));
  ul.appendChild(summaryCell('Avg Risk-Free Rate', avgRf != null ? fmtPct(avgRf) : '—', tbillsRow ? 'ST T-Bills CAGR' : 'mean of avg_rf'));
}

function summaryCell(label, value, hint) {
  const li = document.createElement('li');
  const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
  const v = document.createElement('span'); v.className = 'value'; v.textContent = value;
  const h = document.createElement('span'); h.className = 'hint';  h.textContent = hint || '';
  li.appendChild(l); li.appendChild(v); li.appendChild(h);
  return li;
}

function renderWarning(rows, periodKey) {
  const el = document.getElementById('period-warning');
  if (!el) return;
  if (periodKey === 'modern') {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  // Resolve the period's start year (custom overrides PERIOD_LABELS).
  const periodStart = periodKey === 'custom'
    ? STATE.customRange.start
    : PERIOD_LABELS[periodKey].start;

  // Identify the most-constrained asset shown: latest native_start beyond the period start.
  const constrained = rows
    .filter((r) => r.quality !== 'native' && (periodStart == null || r.native_start > periodStart))
    .sort((a, b) => b.native_start - a.native_start)[0];

  if (!constrained) {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  let periodLabel;
  if (periodKey === 'native')       periodLabel = 'the full data set (1871 onward)';
  else if (periodKey === 'custom')  periodLabel = `${STATE.customRange.start}–${STATE.customRange.end}`;
  else                              periodLabel = `${periodStart}`;

  el.hidden = false;
  el.textContent =
    `${constrained.name} has native data starting in ${constrained.native_start}. ` +
    `Using ${periodLabel} will include reconstructed proxy data prior to ${constrained.native_start}, ` +
    `which may affect simulation accuracy. Other assets may also use spliced data — see the badges in the table.`;
}

function renderSortIndicators() {
  document.querySelectorAll('#ref-table thead th.sortable').forEach((th) => {
    if (th.dataset.key === STATE.sort.key) {
      th.setAttribute('aria-sort', STATE.sort.dir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  });
}

function renderTable(rows) {
  const tbody = document.getElementById('ref-tbody');
  if (!tbody) return;

  // Sort
  const { key, dir } = STATE.sort;
  const sorted = [...rows].sort((a, b) => compareRows(a, b, key, dir));

  // Max std for volatility bar scaling (use sorted rows; same population)
  const maxStd = rows.reduce((m, r) => Math.max(m, r.std || 0), 0) || 1;

  tbody.innerHTML = '';
  sorted.forEach((r) => {
    const tr = document.createElement('tr');

    tr.appendChild(cellAsset(r));
    tr.appendChild(cellMonoText(r.ticker, 'ticker'));
    tr.appendChild(cellYear(r.first_year));
    tr.appendChild(cellNum(r.n, 0));
    tr.appendChild(cellPct(r.cagr));
    tr.appendChild(cellPct(r.std));
    tr.appendChild(cellVolBar(r.std, maxStd));
    tr.appendChild(cellNum(r.sharpe, 3));
    tr.appendChild(cellPct(r.min, true));
    tr.appendChild(cellPct(r.max, true));
    tr.appendChild(cellPct(r.avg_rf));
    tr.appendChild(cellQuality(r.quality));

    tbody.appendChild(tr);
  });
}

function compareRows(a, b, key, dir) {
  // Special-case: group ordering when sorting by name asc.
  let av, bv;
  if (key === 'quality') {
    const order = ['native', 'early-splice', 'late-splice', 'limited'];
    av = order.indexOf(a.quality);
    bv = order.indexOf(b.quality);
  } else {
    av = a[key];
    bv = b[key];
  }
  if (av == null && bv == null) return 0;
  if (av == null) return 1;       // nulls sort to the end
  if (bv == null) return -1;
  if (typeof av === 'string') {
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  }
  return dir === 'asc' ? av - bv : bv - av;
}

/* -----------------------------------------------------------
   Cell builders
   ----------------------------------------------------------- */
function cellAsset(r) {
  const td = document.createElement('td');
  const name = document.createElement('span');
  name.className = 'asset-name';
  name.textContent = r.name;
  const group = document.createElement('span');
  group.className = 'asset-group';
  group.textContent = r.group;
  td.appendChild(name);
  td.appendChild(group);
  return td;
}

function cellMonoText(text, extraClass = '') {
  const td = document.createElement('td');
  const span = document.createElement('span');
  if (extraClass) span.className = extraClass;
  span.textContent = text;
  td.appendChild(span);
  return td;
}

function cellNum(value, decimals) {
  const td = document.createElement('td');
  td.className = 'num';
  td.textContent = value == null ? '—' : fmtNum(value, decimals);
  if (value == null) td.classList.add('dash');
  return td;
}

function cellYear(value) {
  // Years should never get a thousands separator (e.g. "1976", not "1,976").
  const td = document.createElement('td');
  td.className = 'num';
  if (value == null) { td.textContent = '—'; td.classList.add('dash'); return td; }
  td.textContent = String(value);
  return td;
}

function cellPct(value, signColor = false) {
  const td = document.createElement('td');
  td.className = 'num';
  if (value == null) { td.textContent = '—'; td.classList.add('dash'); return td; }
  td.textContent = fmtPct(value);
  if (signColor) td.classList.add(value < 0 ? 'neg' : 'pos');
  return td;
}

function cellVolBar(std, maxStd) {
  const td = document.createElement('td');
  td.className = 'volbar-cell num';
  if (std == null) { td.textContent = '—'; td.classList.add('dash'); return td; }
  const track = document.createElement('div');
  track.className = 'volbar-track';
  const fill = document.createElement('div');
  fill.className = 'volbar-fill';
  const pct = Math.max(2, Math.min(100, (std / maxStd) * 100));
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  td.appendChild(track);
  return td;
}

function cellQuality(quality) {
  const td = document.createElement('td');
  const info = QUALITY_INFO[quality] || { label: '—', className: '' };
  const span = document.createElement('span');
  span.className = `badge ${info.className}`;
  span.textContent = info.label;
  td.appendChild(span);
  return td;
}

/* -----------------------------------------------------------
   Formatters
   ----------------------------------------------------------- */
function fmtNum(v, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(v, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${fmtNum(v, decimals)}%`;
}

/* -----------------------------------------------------------
   UI helpers
   ----------------------------------------------------------- */
function showElement(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}
function hideElement(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}
function showError(message) {
  hideElement('loading-state');
  hideElement('reference-section');
  const wrapper = document.getElementById('error-state');
  const msg = document.getElementById('error-message');
  if (msg) msg.textContent = message;
  if (wrapper) wrapper.hidden = false;
}

// Expose a tiny inspection hook for verification in DevTools/preview_eval.
window.__MC_STATE__ = STATE;

/* ============================================================
   Phase 2/3 — Web Worker
   ============================================================ */

const WORKER = {
  instance: null,
  busy: false,
  startedAt: 0,
};

function initWorker() {
  if (WORKER.instance) return WORKER.instance;
  try {
    WORKER.instance = new Worker('./simulation.worker.js');
  } catch (e) {
    showError(
      'Your browser does not support Web Workers, or the simulation engine failed to load. ' +
      'Please use a modern browser (Chrome, Firefox, Safari, Edge).'
    );
    return null;
  }
  WORKER.instance.onmessage = onWorkerMessage;
  WORKER.instance.onerror = (e) => {
    devShowError(`Simulation worker error: ${e.message || 'unknown'}`);
    WORKER.busy = false;
    setRunButtonBusy(false);
  };
  return WORKER.instance;
}

function onWorkerMessage(e) {
  const msg = e.data || {};
  if (msg.type === 'progress') {
    devUpdateProgress(msg.completed, msg.total);
  } else if (msg.type === 'results') {
    devRenderResults(msg.data);
    WORKER.busy = false;
    setRunButtonBusy(false);
    // Per spec 4.4.1 — disclaimer resets after each successful run
    const disc = document.getElementById('disclaimer-check');
    if (disc) disc.checked = false;
    refreshRunButtonState();
  } else if (msg.type === 'error') {
    devShowError(msg.message || 'Unknown simulation error.');
    WORKER.busy = false;
    setRunButtonBusy(false);
    refreshRunButtonState();
  }
}

function setRunButtonBusy(busy) {
  const btn = document.getElementById('run-sim');
  if (btn) btn.disabled = busy || !computeValidation().valid;
  const status = document.getElementById('run-status');
  if (status) status.textContent = busy ? 'Running simulation…' : '';
}

/* ============================================================
   Phase 3 — Input panel
   ============================================================ */

const ASSET_GROUPS_FOR_DROPDOWN = ['US Equity', 'International Equity', 'Fixed Income', 'Alternatives'];

const DEFAULTS = {
  current_age: 60,
  period_years: 30,
  n_simulations: 10000,
  historical_period: 'modern',
  custom_start: 1976,
  custom_end: 2025,
  sequence_of_returns: false,
  sor_force_2008: false,
  inflation_adjust: true,
  expense_mode: 'annual', // 'annual' | 'monthly'
  initial_balance: 1_000_000,
  allocations: [
    { key: 'sp500',      pct: 60 },
    { key: 'total_bond', pct: 40 },
    { key: '',           pct: 0 },
    { key: '',           pct: 0 },
    { key: '',           pct: 0 },
  ],
  ss:      { amount: 0, start_age: 67 },
  pension: { amount: 0, start_age: 65, cola: false },
  annuity: { amount: 0, start_age: 65, cola: false },
  // Buckets — one expense per 5 years. Default first bucket is blank;
  // user must enter at least bucket 1 expense before Run enables.
  bucket1_default_expense: 0,
  // Distribution Strategy (v1.1 + v1.2 + v1.3 "None")
  distribution_strategy: 'none',
  minimum_withdrawal_annual: 0,
  strategy_params: {
    real_spending_decline_pct: 2.0,
    upper_guardrail_pct: 6.0,
    lower_guardrail_pct: 4.0,
    upper_adjustment_pct: 10.0,
    lower_adjustment_pct: 10.0,
  },
};

// Mutable working state for the form
const INPUT_STATE = {
  current_age: DEFAULTS.current_age,
  period_years: DEFAULTS.period_years,
  n_simulations: DEFAULTS.n_simulations,
  historical_period: DEFAULTS.historical_period,
  custom_start: DEFAULTS.custom_start,
  custom_end: DEFAULTS.custom_end,
  sequence_of_returns: DEFAULTS.sequence_of_returns,
  sor_force_2008: DEFAULTS.sor_force_2008,
  inflation_adjust: DEFAULTS.inflation_adjust,
  expense_mode: DEFAULTS.expense_mode,
  expenses_uniform: true,            // when true, all buckets sync to Bucket 1
  initial_balance: DEFAULTS.initial_balance,
  allocations: DEFAULTS.allocations.map((a) => ({ ...a })),
  ss:      { ...DEFAULTS.ss },
  pension: { ...DEFAULTS.pension },
  annuity: { ...DEFAULTS.annuity },
  buckets: [], // [{ expense, manual }]
  // Distribution Strategy
  distribution_strategy: DEFAULTS.distribution_strategy,
  minimum_withdrawal_annual: DEFAULTS.minimum_withdrawal_annual,
  strategy_params: { ...DEFAULTS.strategy_params },
};

function initInputPanel() {
  if (!STATE.data) return;
  buildAgeDropdown();
  buildPeriodYearsDropdown();
  buildHistoricalCustomYearDropdowns();
  buildStartAgeDropdowns();
  populateAssetDropdownTemplate();

  // Initialize buckets to match the default period
  INPUT_STATE.buckets = buildBucketsArray(INPUT_STATE.period_years, INPUT_STATE.buckets);
  // Render initial UI
  renderAllocationRows();
  renderBuckets();
  syncSimpleInputsFromState();

  // Event bindings
  bindInputEvents();
  bindStrategyModal();

  // Initial validation pass
  refreshAllDerived();
}

/* -----------------------------------------------------------
   Build dropdowns
   ----------------------------------------------------------- */
function buildAgeDropdown() {
  const sel = document.getElementById('current-age');
  if (!sel) return;
  sel.innerHTML = '';
  for (let a = 40; a <= 80; a++) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    if (a === DEFAULTS.current_age) opt.selected = true;
    sel.appendChild(opt);
  }
}

function buildPeriodYearsDropdown() {
  const sel = document.getElementById('period-years');
  if (!sel) return;
  sel.innerHTML = '';
  for (const y of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = `${y} years`;
    if (y === DEFAULTS.period_years) opt.selected = true;
    sel.appendChild(opt);
  }
}

function buildHistoricalCustomYearDropdowns() {
  const startSel = document.getElementById('custom-start');
  const endSel   = document.getElementById('custom-end');
  if (!startSel || !endSel) return;
  startSel.innerHTML = '';
  endSel.innerHTML = '';
  for (let y = 1871; y <= 2020; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === DEFAULTS.custom_start) opt.selected = true;
    startSel.appendChild(opt);
  }
  for (let y = 1876; y <= 2025; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === DEFAULTS.custom_end) opt.selected = true;
    endSel.appendChild(opt);
  }
}

function buildStartAgeDropdowns() {
  const ss      = document.getElementById('ss-start-age');
  const pension = document.getElementById('pension-start-age');
  const annuity = document.getElementById('annuity-start-age');
  fillAgeOptions(ss,      62, 70, DEFAULTS.ss.start_age);
  fillAgeOptions(pension, 50, 80, DEFAULTS.pension.start_age);
  fillAgeOptions(annuity, 50, 90, DEFAULTS.annuity.start_age);
}

function fillAgeOptions(sel, min, max, defaultVal) {
  if (!sel) return;
  sel.innerHTML = '';
  for (let a = min; a <= max; a++) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    if (a === defaultVal) opt.selected = true;
    sel.appendChild(opt);
  }
}

function populateAssetDropdownTemplate() {
  // Build a single <select> template (a string) that we clone into each
  // allocation row. Reorders assets by group.
  const groups = ASSET_GROUPS_FOR_DROPDOWN.map((group) => ({
    group,
    assets: STATE.assets.filter((a) => a.group === group),
  }));
  let html = '<option value="">— Select asset —</option>';
  for (const g of groups) {
    html += `<optgroup label="${g.group}">`;
    for (const a of g.assets) {
      html += `<option value="${a.key}">${escapeHtml(a.name)}</option>`;
    }
    html += '</optgroup>';
  }
  INPUT_STATE._assetSelectHtml = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;',
  }[c]));
}

/* -----------------------------------------------------------
   Allocation table — render + interactions
   ----------------------------------------------------------- */
function renderAllocationRows() {
  const tbody = document.getElementById('alloc-rows');
  if (!tbody) return;
  tbody.innerHTML = '';

  const usedKeys = new Set(INPUT_STATE.allocations.map((a) => a.key).filter(Boolean));

  INPUT_STATE.allocations.forEach((alloc, idx) => {
    const tr = document.createElement('tr');

    // Asset dropdown
    const td1 = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'alloc-select select';
    sel.innerHTML = INPUT_STATE._assetSelectHtml;
    sel.value = alloc.key || '';
    // Disable options already used by other rows
    Array.from(sel.options).forEach((opt) => {
      if (opt.value && opt.value !== alloc.key && usedKeys.has(opt.value)) {
        opt.disabled = true;
      }
    });
    sel.addEventListener('change', () => {
      const newKey = sel.value || '';
      if (newKey && INPUT_STATE.allocations.some((a, j) => j !== idx && a.key === newKey)) {
        // Should not happen because options are disabled, but guard anyway
        sel.value = alloc.key || '';
        return;
      }
      INPUT_STATE.allocations[idx].key = newKey;
      renderAllocationRows();
      refreshAllDerived();
    });
    td1.appendChild(sel);
    tr.appendChild(td1);

    // Percentage input
    const td2 = document.createElement('td');
    const pct = document.createElement('input');
    pct.type = 'number';
    pct.min = 0;
    pct.max = 100;
    pct.step = 1;
    pct.className = 'alloc-pct';
    pct.value = alloc.pct ?? '';
    pct.addEventListener('input', () => {
      let v = parseInt(pct.value, 10);
      if (!Number.isFinite(v)) v = 0;
      v = Math.max(0, Math.min(100, v));
      INPUT_STATE.allocations[idx].pct = v;
      updateAllocTotal();
      refreshRunButtonState();
    });
    pct.addEventListener('blur', () => {
      pct.value = INPUT_STATE.allocations[idx].pct ?? 0;
    });
    td2.appendChild(pct);
    tr.appendChild(td2);

    // Remove button (disabled when only 1 row)
    const td3 = document.createElement('td');
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'alloc-remove';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove asset row');
    rm.disabled = INPUT_STATE.allocations.length <= 1;
    rm.addEventListener('click', () => {
      INPUT_STATE.allocations.splice(idx, 1);
      renderAllocationRows();
      refreshAllDerived();
    });
    td3.appendChild(rm);
    tr.appendChild(td3);

    tbody.appendChild(tr);
  });

  // Disable Add button at 10 rows
  const add = document.getElementById('add-alloc');
  if (add) add.disabled = INPUT_STATE.allocations.length >= 10;

  updateAllocTotal();
}

function updateAllocTotal() {
  const total = INPUT_STATE.allocations.reduce((s, a) => s + (a.pct || 0), 0);
  const el = document.getElementById('alloc-total');
  if (el) {
    const ok = total === 100;
    el.textContent = `Total: ${total}%`;
    el.classList.toggle('is-valid',   ok);
    el.classList.toggle('is-invalid', !ok);
  }
  const err = document.getElementById('alloc-error');
  if (err) err.hidden = total === 100;
}

/* -----------------------------------------------------------
   Expense buckets — generation + render + carry-forward
   ----------------------------------------------------------- */
function buildBucketsArray(periodYears, existing) {
  const target = Math.ceil(periodYears / 5);
  const out = [];
  let lastValue = null;
  let lastManual = false;
  for (let i = 0; i < target; i++) {
    if (existing && existing[i]) {
      const b = existing[i];
      out.push({ expense: b.expense || 0, manual: !!b.manual });
      if (b.manual) { lastValue = b.expense; lastManual = true; }
      else if (lastManual && lastValue != null) {
        out[i].expense = lastValue;
      }
    } else {
      // New bucket added because period grew — carry forward from last value
      out.push({ expense: lastValue != null ? lastValue : 0, manual: false });
    }
  }
  return out;
}

function renderBuckets() {
  const container = document.getElementById('buckets-container');
  if (!container) return;
  container.innerHTML = '';
  const monthly = INPUT_STATE.expense_mode === 'monthly';
  const uniform = INPUT_STATE.expenses_uniform;

  // Strategies that lock buckets 2-N (visually + functionally disabled):
  // Constant Dollar uses only bucket 1. Actual Spending Decline carries forward
  // year-over-year and uses bucket 1 alone for floor/ceiling. Strategies that
  // drive baseline directly from buckets (None, FI, G-K) keep them editable.
  const cdLockBuckets =
    INPUT_STATE.distribution_strategy === 'constant_dollar' ||
    INPUT_STATE.distribution_strategy === 'actual_spending';

  INPUT_STATE.buckets.forEach((bucket, idx) => {
    const startYear = idx * 5 + 1;
    const endYear   = Math.min(startYear + 4, INPUT_STATE.period_years);
    const startAge  = INPUT_STATE.current_age + (startYear - 1);
    const endAge    = INPUT_STATE.current_age + (endYear - 1);

    const wrap = document.createElement('div');
    wrap.className = 'bucket';
    if ((uniform || cdLockBuckets) && idx > 0) wrap.classList.add('bucket--locked');

    const header = document.createElement('div');
    header.className = 'bucket__header';
    const title = document.createElement('div');
    title.className = 'bucket__title';
    title.textContent = `Bucket ${idx + 1} · Ages ${startAge}–${endAge}`;
    const yearsSpan = document.createElement('div');
    yearsSpan.className = 'bucket__years';
    yearsSpan.textContent = `Years ${startYear}–${endYear}`;
    header.appendChild(title);
    header.appendChild(yearsSpan);
    wrap.appendChild(header);

    const labelRow = document.createElement('div');
    labelRow.style.display = 'flex';
    labelRow.style.justifyContent = 'space-between';
    labelRow.style.alignItems = 'baseline';

    const lbl = document.createElement('label');
    lbl.className = 'field-label small';
    lbl.textContent = monthly ? 'Monthly Expenses (today’s $)' : 'Annual Expenses (today’s $)';
    lbl.setAttribute('for', `bucket-${idx}`);
    labelRow.appendChild(lbl);

    if ((uniform || cdLockBuckets) && idx > 0) {
      const synced = document.createElement('span');
      synced.className = 'bucket__carry';
      synced.textContent = cdLockBuckets ? 'not used' : '= Bucket 1';
      labelRow.appendChild(synced);
    } else if (!bucket.manual && idx > 0 && bucket.expense > 0) {
      const carry = document.createElement('span');
      carry.className = 'bucket__carry';
      carry.textContent = '↓ carried forward';
      labelRow.appendChild(carry);
    }
    wrap.appendChild(labelRow);

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `bucket-${idx}`;
    input.className = 'currency-input';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    const displayVal = monthly ? Math.round((bucket.expense || 0) / 12) : (bucket.expense || 0);
    input.value = bucket.expense > 0 ? formatCurrency(displayVal) : '$0';

    if ((uniform || cdLockBuckets) && idx > 0) {
      input.disabled = true;
    } else {
      attachCurrencyHandlers(input, (raw) => {
        const annualValue = monthly ? raw * 12 : raw;
        INPUT_STATE.buckets[idx].expense = annualValue;
        INPUT_STATE.buckets[idx].manual = true;
        if (INPUT_STATE.expenses_uniform) {
          // Bucket 1 is the only editable bucket — propagate to all
          for (let j = 1; j < INPUT_STATE.buckets.length; j++) {
            INPUT_STATE.buckets[j].expense = annualValue;
            INPUT_STATE.buckets[j].manual = false;
          }
        } else {
          // Per-bucket carry-forward: propagate into later non-manual buckets
          for (let j = idx + 1; j < INPUT_STATE.buckets.length; j++) {
            if (!INPUT_STATE.buckets[j].manual) {
              INPUT_STATE.buckets[j].expense = annualValue;
            }
          }
        }
        renderBuckets();
        refreshAllDerived();
      });
    }
    wrap.appendChild(input);

    // Strategy callout for buckets 2+ under non-Constant strategies.
    // Field stays editable; the callout just explains what happens.
    if (idx > 0) {
      const note = strategyBucketNote(INPUT_STATE.distribution_strategy);
      if (note) {
        const callout = document.createElement('div');
        callout.className = 'bucket__strategy-note';
        callout.textContent = note;
        wrap.appendChild(callout);
      }
    }

    container.appendChild(wrap);
  });
}

function strategyBucketNote(strategy) {
  if (strategy === 'none') {
    return null; // No callout — buckets are honored literally as planned.
  }
  if (strategy === 'constant_dollar') {
    return 'Not used under Constant Dollar. Only Bucket 1 drives every year’s withdrawal (inflation-adjusted).';
  }
  if (strategy === 'forgo_inflation') {
    return 'Used as the baseline withdrawal target for years in this bucket. Inflation raises are skipped in years following a portfolio loss, and skipped raises are permanent.';
  }
  if (strategy === 'actual_spending') {
    return 'Not used under Actual Spending Decline. Only Bucket 1 drives the year-1 anchor and the 50% floor / 150% ceiling references.';
  }
  if (strategy === 'guyton_klinger') {
    return 'Acts as a rebase point at this bucket’s transition year. Within the bucket, the prior year’s withdrawal carries forward (with Rule 1 inflation and Rule 2 guardrails). At the transition, the carry-forward value is scaled by (this bucket / prior bucket) so the rebased plan becomes the new baseline.';
  }
  return null;
}

/* -----------------------------------------------------------
   Currency input formatting
   ----------------------------------------------------------- */
function attachCurrencyHandlers(input, onCommit) {
  input.addEventListener('focus', () => {
    const raw = parseCurrency(input.value);
    input.value = raw > 0 ? String(raw) : '';
  });
  input.addEventListener('input', () => {
    // Strip non-digit chars while typing (but leave the field as the user sees)
    const cleaned = input.value.replace(/[^0-9]/g, '');
    input.value = cleaned;
  });
  input.addEventListener('blur', () => {
    const raw = parseCurrency(input.value);
    input.value = formatCurrency(raw);
    onCommit(raw);
  });
}

function parseCurrency(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[^0-9]/g, '');
  if (!cleaned) return 0;
  return parseInt(cleaned, 10) || 0;
}

function formatCurrency(n) {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return '$' + Math.round(n).toLocaleString('en-US');
}

/* -----------------------------------------------------------
   Sync DOM from INPUT_STATE (one-time after build)
   ----------------------------------------------------------- */
function syncSimpleInputsFromState() {
  const ib = document.getElementById('initial-balance');
  if (ib) ib.value = formatCurrency(INPUT_STATE.initial_balance);

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('current-age',  INPUT_STATE.current_age);
  setVal('period-years', INPUT_STATE.period_years);
  setVal('n-simulations',INPUT_STATE.n_simulations);
  setVal('historical-period', INPUT_STATE.historical_period);
  setVal('custom-start', INPUT_STATE.custom_start);
  setVal('custom-end',   INPUT_STATE.custom_end);

  const setChecked = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
  setChecked('sor-toggle',       INPUT_STATE.sequence_of_returns);
  setChecked('sor-force-2008',   INPUT_STATE.sor_force_2008);
  setChecked('inflation-toggle', INPUT_STATE.inflation_adjust);
  setChecked('expense-mode',     INPUT_STATE.expense_mode === 'monthly');
  setChecked('uniform-expense',  INPUT_STATE.expenses_uniform);

  setVal('ss-amount',      formatCurrency(INPUT_STATE.ss.amount));
  setVal('ss-start-age',   INPUT_STATE.ss.start_age);
  setVal('pension-amount', formatCurrency(INPUT_STATE.pension.amount));
  setVal('pension-start-age', INPUT_STATE.pension.start_age);
  setChecked('pension-cola',   INPUT_STATE.pension.cola);
  setVal('annuity-amount', formatCurrency(INPUT_STATE.annuity.amount));
  setVal('annuity-start-age', INPUT_STATE.annuity.start_age);
  setChecked('annuity-cola',   INPUT_STATE.annuity.cola);

  // Strategy
  setVal('distribution-strategy', INPUT_STATE.distribution_strategy);
  setVal('minimum-withdrawal',    INPUT_STATE.minimum_withdrawal_annual > 0 ? formatCurrency(INPUT_STATE.minimum_withdrawal_annual) : '');
  setVal('real-spending-decline', INPUT_STATE.strategy_params.real_spending_decline_pct);
  setVal('gk-upper-guardrail',    INPUT_STATE.strategy_params.upper_guardrail_pct);
  setVal('gk-lower-guardrail',    INPUT_STATE.strategy_params.lower_guardrail_pct);
  setVal('gk-upper-adjustment',   INPUT_STATE.strategy_params.upper_adjustment_pct);
  setVal('gk-lower-adjustment',   INPUT_STATE.strategy_params.lower_adjustment_pct);

  // Show/hide custom range pane
  const customWrap = document.getElementById('custom-range');
  if (customWrap) customWrap.hidden = INPUT_STATE.historical_period !== 'custom';

  // Show/hide strategy parameter panels + populate description
  const stratDesc = document.getElementById('strategy-description');
  if (stratDesc) stratDesc.textContent = STRATEGY_DESCRIPTIONS[INPUT_STATE.distribution_strategy] || '';
  const aspParams = document.getElementById('params-actual-spending');
  if (aspParams) aspParams.hidden = INPUT_STATE.distribution_strategy !== 'actual_spending';
  const gkParams = document.getElementById('params-guyton-klinger');
  if (gkParams) gkParams.hidden = INPUT_STATE.distribution_strategy !== 'guyton_klinger';
  // Uniform-expense toggle visibility matches strategy
  const uniformRow = document.getElementById('uniform-expense-row');
  if (uniformRow) {
    uniformRow.hidden =
      INPUT_STATE.distribution_strategy === 'constant_dollar' ||
      INPUT_STATE.distribution_strategy === 'actual_spending';
  }
}

/* -----------------------------------------------------------
   Wire form events
   ----------------------------------------------------------- */
function bindInputEvents() {
  // Add allocation
  document.getElementById('add-alloc')?.addEventListener('click', () => {
    if (INPUT_STATE.allocations.length >= 10) return;
    INPUT_STATE.allocations.push({ key: '', pct: 0 });
    renderAllocationRows();
    refreshAllDerived();
  });

  // Initial balance
  const ib = document.getElementById('initial-balance');
  if (ib) {
    attachCurrencyHandlers(ib, (raw) => {
      INPUT_STATE.initial_balance = raw;
      refreshAllDerived();
    });
  }

  // Age / period / simulations
  document.getElementById('current-age')?.addEventListener('change', (e) => {
    INPUT_STATE.current_age = parseInt(e.target.value, 10) || DEFAULTS.current_age;
    renderBuckets();
    refreshAllDerived();
  });
  document.getElementById('period-years')?.addEventListener('change', (e) => {
    INPUT_STATE.period_years = parseInt(e.target.value, 10) || DEFAULTS.period_years;
    INPUT_STATE.buckets = buildBucketsArray(INPUT_STATE.period_years, INPUT_STATE.buckets);
    renderBuckets();
    refreshAllDerived();
  });
  document.getElementById('n-simulations')?.addEventListener('change', (e) => {
    INPUT_STATE.n_simulations = parseInt(e.target.value, 10) || DEFAULTS.n_simulations;
  });

  // Historical period
  document.getElementById('historical-period')?.addEventListener('change', (e) => {
    INPUT_STATE.historical_period = e.target.value;
    const customWrap = document.getElementById('custom-range');
    if (customWrap) customWrap.hidden = INPUT_STATE.historical_period !== 'custom';
    refreshAllDerived();
  });
  document.getElementById('custom-start')?.addEventListener('change', (e) => {
    INPUT_STATE.custom_start = parseInt(e.target.value, 10);
    refreshAllDerived();
  });
  document.getElementById('custom-end')?.addEventListener('change', (e) => {
    INPUT_STATE.custom_end = parseInt(e.target.value, 10);
    refreshAllDerived();
  });

  // SoR + inflation toggles
  document.getElementById('sor-toggle')?.addEventListener('change', (e) => {
    INPUT_STATE.sequence_of_returns = e.target.checked;
    refreshSorUi();
  });
  document.getElementById('sor-force-2008')?.addEventListener('change', (e) => {
    INPUT_STATE.sor_force_2008 = e.target.checked;
    refreshSorUi();
  });
  document.getElementById('inflation-toggle')?.addEventListener('change', (e) => {
    INPUT_STATE.inflation_adjust = e.target.checked;
    const w = document.getElementById('inflation-warning');
    if (w) w.hidden = INPUT_STATE.inflation_adjust;
  });

  // Expense mode (Annual / Monthly)
  document.getElementById('expense-mode')?.addEventListener('change', (e) => {
    INPUT_STATE.expense_mode = e.target.checked ? 'monthly' : 'annual';
    renderBuckets();
  });

  // Use Bucket 1 for all buckets
  document.getElementById('uniform-expense')?.addEventListener('change', (e) => {
    INPUT_STATE.expenses_uniform = e.target.checked;
    if (INPUT_STATE.expenses_uniform && INPUT_STATE.buckets.length > 0) {
      const b1 = INPUT_STATE.buckets[0].expense || 0;
      for (let j = 1; j < INPUT_STATE.buckets.length; j++) {
        INPUT_STATE.buckets[j].expense = b1;
        INPUT_STATE.buckets[j].manual = false;
      }
    }
    renderBuckets();
    refreshAllDerived();
  });

  // Income sources
  const ssAmt = document.getElementById('ss-amount');
  if (ssAmt) attachCurrencyHandlers(ssAmt, (raw) => { INPUT_STATE.ss.amount = raw; refreshAllDerived(); });
  document.getElementById('ss-start-age')?.addEventListener('change', (e) => {
    INPUT_STATE.ss.start_age = parseInt(e.target.value, 10) || DEFAULTS.ss.start_age;
    refreshAllDerived();
  });

  const pensAmt = document.getElementById('pension-amount');
  if (pensAmt) attachCurrencyHandlers(pensAmt, (raw) => { INPUT_STATE.pension.amount = raw; refreshAllDerived(); });
  document.getElementById('pension-start-age')?.addEventListener('change', (e) => {
    INPUT_STATE.pension.start_age = parseInt(e.target.value, 10) || DEFAULTS.pension.start_age;
    refreshAllDerived();
  });
  document.getElementById('pension-cola')?.addEventListener('change', (e) => {
    INPUT_STATE.pension.cola = e.target.checked;
    refreshAllDerived();
  });

  const annAmt = document.getElementById('annuity-amount');
  if (annAmt) attachCurrencyHandlers(annAmt, (raw) => { INPUT_STATE.annuity.amount = raw; refreshAllDerived(); });
  document.getElementById('annuity-start-age')?.addEventListener('change', (e) => {
    INPUT_STATE.annuity.start_age = parseInt(e.target.value, 10) || DEFAULTS.annuity.start_age;
    refreshAllDerived();
  });
  document.getElementById('annuity-cola')?.addEventListener('change', (e) => {
    INPUT_STATE.annuity.cola = e.target.checked;
    refreshAllDerived();
  });

  // Distribution Strategy
  document.getElementById('distribution-strategy')?.addEventListener('change', handleStrategyChange);
  document.getElementById('real-spending-decline')?.addEventListener('input', updateActualSpendingPreview);
  document.getElementById('gk-upper-guardrail')?.addEventListener('input',  () => { updateGKPreview(); validateGKInputs(); refreshRunButtonState(); });
  document.getElementById('gk-lower-guardrail')?.addEventListener('input',  () => { updateGKPreview(); validateGKInputs(); refreshRunButtonState(); });
  document.getElementById('gk-upper-adjustment')?.addEventListener('input', () => { updateGKPreview(); validateGKInputs(); refreshRunButtonState(); });
  document.getElementById('gk-lower-adjustment')?.addEventListener('input', () => { updateGKPreview(); validateGKInputs(); refreshRunButtonState(); });
  const minEl = document.getElementById('minimum-withdrawal');
  if (minEl) {
    attachCurrencyHandlers(minEl, (raw) => {
      INPUT_STATE.minimum_withdrawal_annual = raw;
      handleMinimumWithdrawalChange();
    });
  }

  // Disclaimer + Run + Reset
  document.getElementById('disclaimer-check')?.addEventListener('change', refreshRunButtonState);
  document.getElementById('run-sim')?.addEventListener('click', runSimulationFromInputs);
  document.getElementById('reset-defaults')?.addEventListener('click', resetToDefaults);
}

/* -----------------------------------------------------------
   Derived UI updates (constraining warning, net draw, button)
   ----------------------------------------------------------- */
function refreshAllDerived() {
  refreshConstrainingWarning();
  refreshCustomRangeError();
  refreshBalanceError();
  refreshNetDraw();
  refreshSorUi();
  // Strategy live previews — update whenever underlying inputs (bucket 1, balance, income, ages) change.
  if (INPUT_STATE.distribution_strategy === 'actual_spending') updateActualSpendingPreview();
  if (INPUT_STATE.distribution_strategy === 'guyton_klinger')  updateGKPreview();
  refreshRunButtonState();
}

function refreshSorUi() {
  const sub  = document.getElementById('sor-sub');
  const note = document.getElementById('sor-note');
  if (!sub || !note) return;
  if (!INPUT_STATE.sequence_of_returns) {
    sub.hidden = true;
    note.textContent = '';
    return;
  }
  sub.hidden = false;
  const Y = INPUT_STATE.period_years;
  if (INPUT_STATE.sor_force_2008) {
    note.textContent =
      `Year 1 of every simulation is replaced with 2008's actual returns. The other ${Y - 1} years come from the random bootstrap draw in their drawn order.`;
  } else {
    note.textContent =
      `Within each simulation, ${Y} years are randomly drawn from the selected historical period; the year with the lowest weighted portfolio return is moved to Year 1, and the other ${Y - 1} years stay in their original drawn order. Different simulations will have different Year 1 outcomes.`;
  }
}

function refreshConstrainingWarning() {
  const el = document.getElementById('constraining-warning');
  if (!el) return;
  const period = INPUT_STATE.historical_period;
  let start;
  if (period === 'custom') start = INPUT_STATE.custom_start;
  else if (period === 'native')  start = 1871;
  else if (period === 'postwar') start = 1946;
  else if (period === 'modern')  start = 1976;

  // Find selected asset with latest native_start > period start
  let worst = null;
  for (const a of INPUT_STATE.allocations) {
    if (!a.key) continue;
    const meta = STATE.data.assets[a.key];
    if (!meta) continue;
    if (meta.native_start > start) {
      if (!worst || meta.native_start > worst.native_start) worst = meta;
    }
  }
  if (!worst) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  // Detect data-quality-override assets (TIPS): their splice_note explicitly
  // says pre-native data was REMOVED, so the simulator does NOT use proxy data
  // for them. Tell the truth: the sample pool is narrowed instead.
  const note = (worst.splice_note || '').toLowerCase();
  const proxyRemoved = note.includes('removed') || note.startsWith('real ');
  if (proxyRemoved) {
    el.textContent =
      `${worst.name} has native data starting in ${worst.native_start}. ` +
      `When ${worst.name} is in your allocation, years prior to ${worst.native_start} are excluded ` +
      `from the bootstrap sample pool, effectively restricting the simulation to ${worst.native_start}–${period === 'custom' ? INPUT_STATE.custom_end : 2025}.`;
  } else {
    el.textContent =
      `${worst.name} has native data starting in ${worst.native_start}. Using ${start} ` +
      `will include reconstructed proxy data prior to ${worst.native_start}, which may affect simulation accuracy.`;
  }
}

function refreshCustomRangeError() {
  const el = document.getElementById('custom-range-error');
  if (!el) return;
  if (INPUT_STATE.historical_period !== 'custom') { el.hidden = true; return; }
  const gap = INPUT_STATE.custom_end - INPUT_STATE.custom_start;
  el.hidden = gap >= 5;
}

function refreshBalanceError() {
  const el = document.getElementById('balance-error');
  const input = document.getElementById('initial-balance');
  if (!el) return;
  const v = INPUT_STATE.initial_balance;
  let msg = '';
  if (v < 1000) msg = 'Minimum is $1,000.';
  else if (v > 99_999_999) msg = 'Maximum is $99,999,999.';
  el.hidden = !msg;
  el.textContent = msg;
  if (input) input.classList.toggle('is-invalid', !!msg);
}

function refreshNetDraw() {
  const el = document.getElementById('net-draw-value');
  const hint = document.getElementById('net-draw-hint');
  if (!el || !hint) return;

  // Year 1 net draw using today's-$ values (no inflation applied).
  const monthly = INPUT_STATE.expense_mode === 'monthly';
  const bucket1 = INPUT_STATE.buckets[0]?.expense || 0;
  const annualExpense = bucket1; // already stored as annual

  const age = INPUT_STATE.current_age + 1; // year 1
  let income = 0;
  if (INPUT_STATE.ss.amount      > 0 && age >= INPUT_STATE.ss.start_age)      income += INPUT_STATE.ss.amount;
  if (INPUT_STATE.pension.amount > 0 && age >= INPUT_STATE.pension.start_age) income += INPUT_STATE.pension.amount;
  if (INPUT_STATE.annuity.amount > 0 && age >= INPUT_STATE.annuity.start_age) income += INPUT_STATE.annuity.amount;

  const net = annualExpense - income;

  el.classList.remove('is-positive','is-neutral','is-surplus');
  if (annualExpense === 0) {
    el.textContent = '—';
    hint.textContent = 'Enter Bucket 1 expense to see net portfolio draw.';
  } else if (net > 0) {
    el.textContent = formatCurrency(net) + ' / yr';
    el.classList.add('is-positive');
    hint.textContent = monthly
      ? `${formatCurrency(Math.round(net / 12))} / month · Expenses ${formatCurrency(annualExpense)}, Income ${formatCurrency(income)}`
      : `Expenses ${formatCurrency(annualExpense)} − Income ${formatCurrency(income)}`;
  } else if (net === 0) {
    el.textContent = '$0';
    el.classList.add('is-neutral');
    hint.textContent = 'Income exactly covers expenses in Year 1.';
  } else {
    el.textContent = '+ ' + formatCurrency(-net) + ' / yr';
    el.classList.add('is-surplus');
    hint.textContent = 'Income exceeds expenses — surplus will be added to portfolio.';
  }
}

/* -----------------------------------------------------------
   Distribution Strategy (v1.1 + v1.2)
   ----------------------------------------------------------- */
const STRATEGY_DESCRIPTIONS = {
  none:
    'No strategy logic — each year’s withdrawal is set by your expense schedule (the bucket ' +
    'for that year, inflated forward from today’s dollars). Use this when you want the model ' +
    'to honor your planned spending exactly as entered. The simulation tells you whether your ' +
    'portfolio survives that plan.',
  constant_dollar:
    'Withdraws your target expense amount each year, adjusted upward for inflation. ' +
    'Your portfolio absorbs all market gains and losses. This is the strategy assumed ' +
    'in Bengen’s original 4% rule research. Only Bucket 1 is used (buckets 2-N are locked).',
  forgo_inflation:
    'Same as Constant Dollar, except the annual inflation raise is skipped in any year ' +
    'the portfolio lost value. The skipped raise is permanent — it does not catch up. ' +
    'A small, cumulative protection that compounds over a 30+ year retirement.',
  actual_spending:
    'Starts at your target expense level and increases withdrawals at a reduced rate — ' +
    'inflation minus your selected real spending decline rate. Reflects research showing ' +
    'retirees naturally spend less as they age.',
  guyton_klinger:
    'Sets upper and lower withdrawal rate guardrails relative to your portfolio balance. ' +
    'When breached, spending adjusts up or down by the adjustment percentage. Accepts ' +
    'occasional income adjustments in exchange for higher normal-year withdrawals and ' +
    'improved portfolio longevity.',
};

/* ============================================================
   Strategy Info Modal — content (Batch C4)
   ============================================================
   Rewritten to reflect the actual implemented behavior of each strategy
   (bucket-driven FI + G-K, bucket-1-only CD + AS, etc.) rather than the
   original v1.2 spec text which described the pre-Phase-3 carry-forward
   models that no longer exist in our worker.
   ============================================================ */
const STRATEGY_INFO_CONTENT = {
  none: {
    title: 'None — Use Expense Schedule',
    sections: [
      { heading: 'How it works',
        body: 'Each year’s withdrawal is whatever you entered in the bucket for that year, inflated forward from today’s dollars. No strategy logic, no guardrails, no inflation skipping. The model honors your planned spending exactly as written — the simulation tells you whether the portfolio can sustain it.' },
      { heading: 'Best for',
        body: 'Users who want to test their own specific spending plan — including planned changes across phases (e.g. higher spending in active early retirement, lower late). The most flexible option for letting your bucket schedule drive the model literally.' },
      { heading: 'Key trade-off',
        body: 'No protection mechanism. If markets perform poorly early in retirement, the model still withdraws your full planned amount each year. Pure stress test of the plan as written.' },
    ],
  },
  constant_dollar: {
    title: 'Constant Dollar — Bengen 4% Rule',
    sections: [
      { heading: 'How it works',
        body: 'Withdraw your Bucket 1 amount in year 1, then increase that exact dollar amount by inflation each year. No exceptions. The portfolio absorbs all market gains and losses silently. No decisions required after initial setup. Buckets 2-N are locked when this strategy is selected — only Bucket 1 drives every year’s withdrawal.' },
      { heading: 'Best for',
        body: 'Retirees who want total spending certainty and have Social Security or a pension covering baseline needs. Comfortable leaving money on the table in good markets. Focused on stable real purchasing power.' },
      { heading: 'What it feels like',
        scenarios: [
          { type: 'steady', label: 'Steady markets', text: 'Calm and predictable. Income rises slightly each year with inflation. The couple never thinks about their strategy — it just works.' },
          { type: 'bear',   label: 'Bear markets',   text: 'Income stays at the same real level — no panic, no decisions. But the portfolio quietly absorbs the full loss. If losses continue, the effective withdrawal rate on the shrinking portfolio climbs.' },
          { type: 'bull',   label: 'Bull markets',   text: 'Income stays the same real level even though the portfolio jumped. Good for building a bequest; less satisfying for those who want to enjoy a strong year in their spending.' },
        ] },
      { heading: 'Key risk',
        body: 'Sequence-of-returns risk. A major bear market early in retirement forces the same real withdrawal from a much smaller portfolio, dramatically increasing depletion risk if losses persist.' },
    ],
  },
  forgo_inflation: {
    title: 'Forgo Inflation Adjustment — T. Rowe Price Method',
    sections: [
      { heading: 'How it works',
        body: 'Each year’s baseline withdrawal = bucket[year] × the effective inflation index. The effective inflation index advances by that year’s inflation if your portfolio gained value, but does NOT advance after a portfolio-loss year. Skipped inflation raises are permanent — the index never catches up. Bucket transitions are honored at face value (planned spending changes still happen).' },
      { heading: 'Best for',
        body: 'Retirees who want a paycheck-like income stream and are comfortable skipping inflation raises after a down year. Identical to Constant Dollar in positive market years — the protection only activates when needed.' },
      { heading: 'What it feels like',
        scenarios: [
          { type: 'steady', label: 'Steady markets', text: 'Income rises with inflation — the protection mechanism never fires.' },
          { type: 'bear',   label: 'Bear markets',   text: 'Next year’s income holds flat instead of rising with inflation. A modest protection — but the skipped raise compounds forward through every remaining year, preserving meaningful portfolio value.' },
          { type: 'bull',   label: 'Bull markets',   text: 'Identical to Constant Dollar — income rises with inflation. The strategy only activates after losses.' },
        ] },
      { heading: 'Key advantage',
        body: 'Each skipped raise stays invested and compounds forward. Research shows this small, repeated protection meaningfully extends portfolio longevity over a 30+ year retirement without requiring any active decision-making.' },
    ],
  },
  actual_spending: {
    title: 'Actual Spending Decline — EBRI / Blanchett Method',
    sections: [
      { heading: 'How it works',
        body: 'Year 1 anchors at Bucket 1 in today’s dollars. Each subsequent year, withdrawal grows at (inflation − your selected real spending decline rate). At the default 2% real decline with 2.5% inflation, withdrawals grow only 0.5% per year in nominal terms — and decline in real terms. A floor (50% of Bucket 1’s inflated target) and ceiling (150%) guard against extreme drift. Buckets 2-N are locked under this strategy — only Bucket 1 drives the math.' },
      { heading: 'The research behind it',
        body: 'EBRI found that inflation-adjusted household spending declines roughly 19% from age 65 to 75, 34% from 65 to 85, and 52% from 65 to 95. David Blanchett modeled this as roughly 2% real decline per year. Morningstar 2025 research confirms this strategy supports meaningfully higher starting withdrawal rates at the same probability of success.' },
      { heading: 'Best for',
        body: 'Retirees who want to spend more in the active early years of retirement, with realistic acceptance that spending will naturally decline as they age. Requires honest self-assessment — the strategy assumes you genuinely will spend less at 80 than at 65.' },
      { heading: 'Key trade-off',
        body: 'Constant Dollar eventually catches up in nominal income — typically around age 73. But by then, spending research shows retirees’ actual needs have declined. The strategy is designed around how people actually live, not an inflation formula.' },
    ],
  },
  guyton_klinger: {
    title: 'Guyton-Klinger Guardrails',
    sections: [
      { heading: 'How it works',
        body: 'Year 1 anchors at Bucket 1 in today’s dollars. Each subsequent year starts from the prior year’s actual withdrawal — cuts and raises compound forward. Rule 1: if last year had a portfolio loss, the inflation raise is skipped (same mechanism as Forgo Inflation). Rule 2: compute the effective withdrawal rate = (gross expense − SS − Pension − Annuity) ÷ current portfolio. If it exceeds your upper guardrail, cut spending by the upper adjustment %. If it falls below your lower guardrail, raise by the lower adjustment %. The cut/raise is applied to the carry-forward, so its effect persists into all future years. Buckets 2-N act as rebase points: at a bucket transition the carry-forward is scaled by (new bucket / old bucket), so the user’s revised real-dollar plan becomes the new baseline. The upper-guardrail cut is suspended in the final 15 years (no point cutting late in life).' },
      { heading: 'Best for',
        body: 'Retirees who want to maximize lifetime spending and accept occasional income adjustments. Works best when Social Security or a pension covers essential expenses — so guardrail cuts affect discretionary spending rather than basic needs.' },
      { heading: 'What it feels like',
        scenarios: [
          { type: 'steady', label: 'Steady markets', text: 'Income rises with inflation — rate stays within the guardrail band. The couple earns significantly more than Constant Dollar with no decisions required.' },
          { type: 'bear',   label: 'Bear markets',   text: 'Both rules may activate. Rule 1 skips the inflation raise. Rule 2 may then fire a spending cut. A meaningful income reduction — but the couple still typically earns more than Constant Dollar even after the cut.' },
          { type: 'bull',   label: 'Bull markets',   text: 'Income rises with inflation. In a strong year the lower guardrail may fire, triggering a spending raise. Strong markets accumulate quietly until the lower threshold is reached.' },
        ] },
      { heading: 'Key advantage over Constant Dollar',
        body: 'Morningstar 2025 research shows Guyton-Klinger supports significantly higher starting safe withdrawal rates than Constant Dollar at the same probability of success. Lifetime spending is higher in the median scenario despite occasional cuts.' },
      { heading: 'Key risk',
        is_warning: true,
        body: 'In severe or prolonged bear markets, the upper guardrail may fire repeatedly, producing meaningful cumulative income cuts. Research shows this strategy can require cuts exceeding 40% of original income in the worst historical sequences. A minimum withdrawal floor helps protect against this.' },
    ],
  },
};

function buildModalContent(strategy) {
  const content = STRATEGY_INFO_CONTENT[strategy];
  if (!content) return;
  document.getElementById('modal-title').textContent = content.title;
  let html = '';
  content.sections.forEach((section) => {
    html += `<h3>${escapeHtml(section.heading)}</h3>`;
    if (section.body) {
      const cls = section.is_warning ? 'modal-warning' : '';
      html += `<p class="${cls}">${escapeHtml(section.body)}</p>`;
    }
    if (section.scenarios) {
      section.scenarios.forEach((sc) => {
        html += `<div class="modal-scenario ${escapeHtml(sc.type)}"><span class="modal-scenario__label">${escapeHtml(sc.label)}</span><p>${escapeHtml(sc.text)}</p></div>`;
      });
    }
  });
  document.getElementById('modal-body').innerHTML = html;
}

function openStrategyModal() {
  const strategy = document.getElementById('distribution-strategy').value;
  buildModalContent(strategy);
  const modal = document.getElementById('strategy-info-modal');
  modal.hidden = false;
  // Move focus into the modal for keyboard users
  setTimeout(() => document.getElementById('modal-close-btn')?.focus(), 50);
  document.addEventListener('keydown', handleModalKeydown);
}

function closeStrategyModal() {
  document.getElementById('strategy-info-modal').hidden = true;
  document.removeEventListener('keydown', handleModalKeydown);
  document.getElementById('strategy-info-btn')?.focus();
}

function handleModalKeydown(e) {
  if (e.key === 'Escape') closeStrategyModal();
}

function bindStrategyModal() {
  document.getElementById('strategy-info-btn')?.addEventListener('click', openStrategyModal);
  document.getElementById('modal-close-btn')?.addEventListener('click', closeStrategyModal);
  document.getElementById('modal-close-footer-btn')?.addEventListener('click', closeStrategyModal);
  document.getElementById('strategy-info-modal')?.addEventListener('click', (e) => {
    // Click on the overlay background (not the panel) closes the modal
    if (e.target.id === 'strategy-info-modal') closeStrategyModal();
  });
}

function handleStrategyChange() {
  const strategy = document.getElementById('distribution-strategy').value;
  INPUT_STATE.distribution_strategy = strategy;
  document.getElementById('strategy-description').textContent = STRATEGY_DESCRIPTIONS[strategy] || '';
  document.getElementById('params-actual-spending').hidden = strategy !== 'actual_spending';
  document.getElementById('params-guyton-klinger').hidden = strategy !== 'guyton_klinger';
  // Hide the uniform-expense toggle for CD/AS — buckets 2-N are locked regardless
  // for those strategies, so the toggle has no effect there.
  const uniformRow = document.getElementById('uniform-expense-row');
  if (uniformRow) {
    uniformRow.hidden = (strategy === 'constant_dollar' || strategy === 'actual_spending');
  }
  if (strategy === 'actual_spending') updateActualSpendingPreview();
  if (strategy === 'guyton_klinger')  updateGKPreview();
  renderBuckets(); // re-render to add/remove bucket-2+ strategy callouts
  // If the info modal is open, refresh its content for the new strategy
  const modal = document.getElementById('strategy-info-modal');
  if (modal && !modal.hidden) buildModalContent(strategy);
  refreshRunButtonState();
}

function updateActualSpendingPreview() {
  const decline = parseFloat(document.getElementById('real-spending-decline').value);
  if (Number.isFinite(decline)) INPUT_STATE.strategy_params.real_spending_decline_pct = decline;
  const r = INPUT_STATE.strategy_params.real_spending_decline_pct;
  const assumedInflation = 2.5;
  const netGrowth = assumedInflation - r;
  const year1 = getBucket1AnnualExpense();
  document.getElementById('preview-net-growth').textContent =
    `${netGrowth.toFixed(1)}%${netGrowth < 0 ? ' (real declining)' : ''}`;
  if (!(year1 > 0)) {
    document.getElementById('preview-as-year1').textContent = '—';
    document.getElementById('preview-as-year10-nominal').textContent = '—';
    document.getElementById('preview-as-year10-real').textContent    = '—';
    document.getElementById('preview-as-year20-nominal').textContent = '—';
    document.getElementById('preview-as-year20-real').textContent    = '—';
    return;
  }
  const y10n = year1 * Math.pow(1 + netGrowth / 100, 9);
  const y10r = y10n / Math.pow(1 + assumedInflation / 100, 9);
  const y20n = year1 * Math.pow(1 + netGrowth / 100, 19);
  const y20r = y20n / Math.pow(1 + assumedInflation / 100, 19);
  document.getElementById('preview-as-year1').textContent          = formatCurrency(year1);
  document.getElementById('preview-as-year10-nominal').textContent = formatCurrency(y10n);
  document.getElementById('preview-as-year10-real').textContent    = formatCurrency(y10r);
  document.getElementById('preview-as-year20-nominal').textContent = formatCurrency(y20n);
  document.getElementById('preview-as-year20-real').textContent    = formatCurrency(y20r);
}

function updateGKPreview() {
  const upper = parseFloat(document.getElementById('gk-upper-guardrail').value);
  const lower = parseFloat(document.getElementById('gk-lower-guardrail').value);
  const upAdj = parseFloat(document.getElementById('gk-upper-adjustment').value);
  const loAdj = parseFloat(document.getElementById('gk-lower-adjustment').value);
  if (Number.isFinite(upper)) INPUT_STATE.strategy_params.upper_guardrail_pct  = upper;
  if (Number.isFinite(lower)) INPUT_STATE.strategy_params.lower_guardrail_pct  = lower;
  if (Number.isFinite(upAdj)) INPUT_STATE.strategy_params.upper_adjustment_pct = upAdj;
  if (Number.isFinite(loAdj)) INPUT_STATE.strategy_params.lower_adjustment_pct = loAdj;

  const balance = INPUT_STATE.initial_balance;
  const expense = getBucket1AnnualExpense();
  if (!balance || !expense) {
    document.getElementById('gk-preview-rate').textContent              = '—';
    document.getElementById('gk-preview-upper-portfolio').textContent   = '—';
    document.getElementById('gk-preview-lower-portfolio').textContent   = '—';
    return;
  }
  // Year-1 income — only counts streams whose start age has been reached at year 1 (age = current_age + 1)
  const age1 = INPUT_STATE.current_age + 1;
  let income = 0;
  if (INPUT_STATE.ss.amount      > 0 && age1 >= INPUT_STATE.ss.start_age)      income += INPUT_STATE.ss.amount;
  if (INPUT_STATE.pension.amount > 0 && age1 >= INPUT_STATE.pension.start_age) income += INPUT_STATE.pension.amount;
  if (INPUT_STATE.annuity.amount > 0 && age1 >= INPUT_STATE.annuity.start_age) income += INPUT_STATE.annuity.amount;
  const net = Math.max(0, expense - income);
  const u = INPUT_STATE.strategy_params.upper_guardrail_pct;
  const l = INPUT_STATE.strategy_params.lower_guardrail_pct;
  document.getElementById('gk-preview-rate').textContent =
    ((net / balance) * 100).toFixed(2) + '%';
  document.getElementById('gk-preview-upper-portfolio').textContent =
    u > 0 ? formatCurrency(net / (u / 100)) : '—';
  document.getElementById('gk-preview-lower-portfolio').textContent =
    l > 0 ? formatCurrency(net / (l / 100)) : '—';
}

function validateGKInputs() {
  if (INPUT_STATE.distribution_strategy !== 'guyton_klinger') return true;
  const u  = INPUT_STATE.strategy_params.upper_guardrail_pct;
  const l  = INPUT_STATE.strategy_params.lower_guardrail_pct;
  const ua = INPUT_STATE.strategy_params.upper_adjustment_pct;
  const la = INPUT_STATE.strategy_params.lower_adjustment_pct;
  let valid = true;
  const ue  = document.getElementById('gk-upper-error');
  const le  = document.getElementById('gk-lower-error');
  const ge  = document.getElementById('gk-gap-error');
  const uae = document.getElementById('gk-upper-adj-error');
  const lae = document.getElementById('gk-lower-adj-error');
  if (!Number.isFinite(u) || u < 4.0 || u > 8.0) {
    ue.textContent = 'Upper guardrail must be between 4.0% and 8.0%';
    ue.hidden = false; valid = false;
  } else { ue.hidden = true; }
  if (!Number.isFinite(l) || l < 3.0 || l > 5.5) {
    le.textContent = 'Lower guardrail must be between 3.0% and 5.5%';
    le.hidden = false; valid = false;
  } else { le.hidden = true; }
  if (Number.isFinite(u) && Number.isFinite(l) && (u - l) < 1.0) {
    ge.hidden = false; valid = false;
  } else { ge.hidden = true; }
  if (!Number.isFinite(ua) || ua < 5 || ua > 20) {
    uae.textContent = 'Upper adjustment must be between 5% and 20%';
    uae.hidden = false; valid = false;
  } else { uae.hidden = true; }
  if (!Number.isFinite(la) || la < 5 || la > 20) {
    lae.textContent = 'Lower adjustment must be between 5% and 20%';
    lae.hidden = false; valid = false;
  } else { lae.hidden = true; }
  return valid;
}

function handleMinimumWithdrawalChange() {
  // currency-input already has attachCurrencyHandlers; this fires on blur after parse.
  const bucket1 = getBucket1AnnualExpense();
  const min = INPUT_STATE.minimum_withdrawal_annual;
  document.getElementById('minimum-withdrawal-warning').hidden =
    !(bucket1 > 0 && min > bucket1 * 0.5);
  refreshRunButtonState();
}

function getBucket1AnnualExpense() {
  const b = INPUT_STATE.buckets[0];
  if (!b || !(b.expense > 0)) return 0;
  return b.expense; // INPUT_STATE.buckets[i].expense is always stored as annual (monthly converted at edit time)
}

/* -----------------------------------------------------------
   Validation
   ----------------------------------------------------------- */
function computeValidation() {
  const errors = [];
  const allocTotal = INPUT_STATE.allocations.reduce((s, a) => s + (a.pct || 0), 0);
  const hasAsset = INPUT_STATE.allocations.some((a) => !!a.key);
  if (!hasAsset) errors.push('Select at least one asset class.');
  if (allocTotal !== 100) errors.push('Allocations must sum to 100%.');
  if (INPUT_STATE.initial_balance < 1000) errors.push('Starting balance below $1,000.');
  if (INPUT_STATE.initial_balance > 99_999_999) errors.push('Starting balance above $99,999,999.');
  if (!INPUT_STATE.buckets[0] || !(INPUT_STATE.buckets[0].expense > 0)) errors.push('Enter Bucket 1 expense.');
  if (INPUT_STATE.historical_period === 'custom') {
    if (INPUT_STATE.custom_end - INPUT_STATE.custom_start < 5) errors.push('Custom range too short.');
  }
  // Guyton-Klinger param validity
  if (INPUT_STATE.distribution_strategy === 'guyton_klinger') {
    const u  = INPUT_STATE.strategy_params.upper_guardrail_pct;
    const l  = INPUT_STATE.strategy_params.lower_guardrail_pct;
    const ua = INPUT_STATE.strategy_params.upper_adjustment_pct;
    const la = INPUT_STATE.strategy_params.lower_adjustment_pct;
    if (!Number.isFinite(u) || u < 4.0 || u > 8.0) errors.push('Upper guardrail out of range.');
    if (!Number.isFinite(l) || l < 3.0 || l > 5.5) errors.push('Lower guardrail out of range.');
    if (Number.isFinite(u) && Number.isFinite(l) && (u - l) < 1.0) errors.push('Guardrail gap < 1.0%.');
    if (!Number.isFinite(ua) || ua < 5 || ua > 20) errors.push('Upper adjustment out of range.');
    if (!Number.isFinite(la) || la < 5 || la > 20) errors.push('Lower adjustment out of range.');
  }
  const disc = document.getElementById('disclaimer-check');
  if (!disc || !disc.checked) errors.push('Acknowledge the disclaimer.');
  return { valid: errors.length === 0, errors };
}

function refreshRunButtonState() {
  const btn = document.getElementById('run-sim');
  if (!btn) return;
  const v = computeValidation();
  btn.disabled = !v.valid || WORKER.busy;
  const status = document.getElementById('run-status');
  if (status) {
    if (WORKER.busy) status.textContent = 'Running simulation…';
    else if (!v.valid) status.textContent = v.errors[0];
    else status.textContent = 'Ready.';
  }
}

/* -----------------------------------------------------------
   Run Simulation (from form state)
   ----------------------------------------------------------- */
function runSimulationFromInputs() {
  if (WORKER.busy) return;
  const v = computeValidation();
  if (!v.valid) { refreshRunButtonState(); return; }
  const worker = initWorker();
  if (!worker) return;

  // Build inputs object the worker expects
  const allocations = INPUT_STATE.allocations
    .filter((a) => a.key && a.pct > 0)
    .map((a) => ({ key: a.key, pct: a.pct }));

  const inputs = {
    n_simulations:        INPUT_STATE.n_simulations,
    period_years:         INPUT_STATE.period_years,
    current_age:          INPUT_STATE.current_age,
    initial_balance:      INPUT_STATE.initial_balance,
    historical_period:    INPUT_STATE.historical_period,
    custom_start:         INPUT_STATE.custom_start,
    custom_end:           INPUT_STATE.custom_end,
    sequence_of_returns:  INPUT_STATE.sequence_of_returns,
    sor_force_2008:       INPUT_STATE.sor_force_2008,
    inflation_adjust:     INPUT_STATE.inflation_adjust,
    expense_mode:         'annual', // we always store annualized expenses
    allocations,
    ss:      { ...INPUT_STATE.ss },
    pension: { ...INPUT_STATE.pension },
    annuity: { ...INPUT_STATE.annuity },
    buckets: INPUT_STATE.buckets.map((b) => ({ expense: b.expense || 0 })),
    // Distribution Strategy (v1.1 + v1.2)
    distribution_strategy:     INPUT_STATE.distribution_strategy,
    minimum_withdrawal_annual: INPUT_STATE.minimum_withdrawal_annual,
    strategy_params:           { ...INPUT_STATE.strategy_params },
  };

  WORKER.busy = true;
  WORKER.startedAt = performance.now();
  setRunButtonBusy(true);
  hideElement('dev-error');
  hideElement('dev-results');
  hideElement('results-placeholder');
  showElement('dev-progress');
  devUpdateProgress(0, inputs.n_simulations);

  worker.postMessage({ type: 'run', inputs, data: STATE.data });
}

/* -----------------------------------------------------------
   Reset
   ----------------------------------------------------------- */
function resetToDefaults() {
  if (!confirm('Are you sure you want to reset all inputs?')) return;
  // Reset INPUT_STATE
  INPUT_STATE.current_age        = DEFAULTS.current_age;
  INPUT_STATE.period_years       = DEFAULTS.period_years;
  INPUT_STATE.n_simulations      = DEFAULTS.n_simulations;
  INPUT_STATE.historical_period  = DEFAULTS.historical_period;
  INPUT_STATE.custom_start       = DEFAULTS.custom_start;
  INPUT_STATE.custom_end         = DEFAULTS.custom_end;
  INPUT_STATE.sequence_of_returns= DEFAULTS.sequence_of_returns;
  INPUT_STATE.sor_force_2008     = DEFAULTS.sor_force_2008;
  INPUT_STATE.inflation_adjust   = DEFAULTS.inflation_adjust;
  INPUT_STATE.expense_mode       = DEFAULTS.expense_mode;
  INPUT_STATE.expenses_uniform   = true;
  INPUT_STATE.initial_balance    = DEFAULTS.initial_balance;
  INPUT_STATE.allocations        = DEFAULTS.allocations.map((a) => ({ ...a }));
  INPUT_STATE.ss      = { ...DEFAULTS.ss };
  INPUT_STATE.pension = { ...DEFAULTS.pension };
  INPUT_STATE.annuity = { ...DEFAULTS.annuity };
  INPUT_STATE.buckets = buildBucketsArray(INPUT_STATE.period_years, null);
  // Distribution Strategy
  INPUT_STATE.distribution_strategy   = DEFAULTS.distribution_strategy;
  INPUT_STATE.minimum_withdrawal_annual = DEFAULTS.minimum_withdrawal_annual;
  INPUT_STATE.strategy_params         = { ...DEFAULTS.strategy_params };

  // Re-render
  renderAllocationRows();
  renderBuckets();
  syncSimpleInputsFromState();
  // Reset toggle-driven warnings
  const inflW = document.getElementById('inflation-warning');  if (inflW) inflW.hidden = true;
  refreshAllDerived();
}

// Expose for tests
window.__INPUT_STATE__ = INPUT_STATE;

/* -----------------------------------------------------------
   Dev panel — progress + results rendering
   ----------------------------------------------------------- */
function devUpdateProgress(completed, total) {
  const fill = document.getElementById('dev-progress-fill');
  const label = document.getElementById('dev-progress-label');
  if (fill)  fill.style.width = `${Math.min(100, (completed / total) * 100)}%`;
  if (label) label.textContent = `Simulating… ${completed.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`;
}

function devShowError(message) {
  hideElement('dev-progress');
  hideElement('dev-results');
  const wrap = document.getElementById('dev-error');
  const msg  = document.getElementById('dev-error-msg');
  if (msg)  msg.textContent = message;
  if (wrap) wrap.hidden = false;
}

/* ============================================================
   Phase 4 — Headline Success Rate card
   ============================================================ */
function renderSuccessCard(results) {
  const sm = results.success_metrics;
  const startAge = results.inputs_summary.start_age;
  const pct = sm.success_rate_pct;
  const pctEl   = document.getElementById('success-card-pct');
  const countEl = document.getElementById('success-card-count');
  const divEl   = document.getElementById('success-card-divider');
  const deplEl  = document.getElementById('success-card-depletion');
  if (!pctEl) return;

  pctEl.textContent = `${pct.toFixed(1)}%`;
  pctEl.classList.remove('is-green','is-navy','is-gold','is-clay');
  if      (pct >= 90) pctEl.classList.add('is-green');
  else if (pct >= 75) pctEl.classList.add('is-navy');
  else if (pct >= 50) pctEl.classList.add('is-gold');
  else                pctEl.classList.add('is-clay');

  countEl.textContent =
    `${sm.success_count.toLocaleString('en-US')} of ${sm.total_simulations.toLocaleString('en-US')} simulations ended with $1 or more`;

  if (sm.failure_count > 0 && sm.avg_depletion_year != null && sm.median_depletion_year != null) {
    divEl.hidden  = false;
    deplEl.hidden = false;
    const avgY = Math.round(sm.avg_depletion_year);
    const avgAge = startAge + avgY;
    const medY = sm.median_depletion_year;
    const medAge = startAge + medY;
    document.getElementById('depl-avg').textContent    = `Year ${avgY} (Age ${avgAge})`;
    document.getElementById('depl-median').textContent = `Year ${medY} (Age ${medAge})`;
  } else {
    divEl.hidden  = true;
    deplEl.hidden = true;
  }
}

/* ============================================================
   Phase 4 — Portfolio fan chart (Chart.js)
   ============================================================ */
let portfolioFanChart = null;
let currentPortfolioMode = 'nominal';
let lastResults = null;

function renderPortfolioFanChart(results, mode) {
  const canvas = document.getElementById('portfolio-fan-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (portfolioFanChart) { portfolioFanChart.destroy(); portfolioFanChart = null; }

  const sa = results.inputs_summary.start_age;
  const py = results.inputs_summary.period_years;
  const sims = results.inputs_summary.n_simulations;
  const paths = results.percentile_paths;
  const initial = results.inputs_summary.initial_balance;

  // X-axis labels: ages from start_age to start_age + period_years (year 0 = sa, year Y = sa+py)
  const labels = [];
  for (let i = 0; i <= py; i++) labels.push(sa + i);

  // Brand colors
  const NAVY      = '#1F3D6B';
  const NAVY_15   = 'rgba(31, 61, 107, 0.13)';
  const NAVY_25   = 'rgba(31, 61, 107, 0.22)';
  const GOLD      = '#B58820';
  const CLAY      = '#C84A30';
  const INK       = '#14181E';

  const p = (key) => mode === 'real' ? paths[`real_${key}`] : paths[key];

  // Build datasets — fan layered bottom-up so fills target the right previous dataset.
  // Order: p10 (transparent, no fill), p90 (fill to p10 = outer band),
  //        p25 (transparent, no fill), p75 (fill to p25 = inner band),
  //        p50 (median solid line).
  const datasets = [
    { label: '_p10', data: p('p10'),
      borderColor: 'transparent', backgroundColor: NAVY_15,
      pointRadius: 0, fill: false, tension: 0.2 },
    { label: '10–90% range', data: p('p90'),
      borderColor: 'transparent', backgroundColor: NAVY_15,
      pointRadius: 0, fill: 0, tension: 0.2 },
    { label: '_p25', data: p('p25'),
      borderColor: 'transparent', backgroundColor: NAVY_25,
      pointRadius: 0, fill: false, tension: 0.2 },
    { label: '25–75% range', data: p('p75'),
      borderColor: 'transparent', backgroundColor: NAVY_25,
      pointRadius: 0, fill: 2, tension: 0.2 },
    { label: 'Median (50th)', data: p('p50'),
      borderColor: NAVY, backgroundColor: 'transparent',
      borderWidth: 2.5, pointRadius: 0, fill: false, tension: 0.2 },
    // Year-0 starting balance dot — gold accent
    { label: '_year0', data: labels.map((_, i) => i === 0 ? initial : null),
      borderColor: 'transparent', backgroundColor: GOLD,
      pointRadius: labels.map((_, i) => i === 0 ? 5 : 0),
      pointBackgroundColor: GOLD, pointBorderColor: GOLD,
      fill: false, spanGaps: false },
    // $0 depleted line — clay dashed
    { label: '_zero', data: labels.map(() => 0),
      borderColor: CLAY, backgroundColor: 'transparent',
      borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false },
  ];

  portfolioFanChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            filter: (item) => !item.text.startsWith('_'),
            font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11 },
            color: INK,
            boxWidth: 22, boxHeight: 10, padding: 14,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => `Age ${items[0].label}`,
            label: (ctx) => {
              if (ctx.dataset.label.startsWith('_')) return null;
              return `${ctx.dataset.label}: ${fmtCurrencyShort(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Age', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: {
            callback: (_, i) => i % 5 === 0 ? labels[i] : '',
            maxRotation: 0, color: INK,
            font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 },
          },
          grid: { color: 'rgba(20,24,30,0.05)' },
        },
        y: {
          min: 0,
          title: {
            display: true,
            text: mode === 'real' ? 'Portfolio Balance (Real, today’s $)' : 'Portfolio Balance (Nominal)',
            color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' },
          },
          ticks: {
            callback: (v) => fmtCurrencyShort(v),
            color: INK,
            font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 },
          },
          grid: { color: 'rgba(20,24,30,0.10)' },
        },
      },
    },
  });

  // Title + depletion note
  const titleEl = document.getElementById('portfolio-chart-title');
  if (titleEl) titleEl.textContent = `Projected Portfolio Balance — ${sims.toLocaleString('en-US')} Simulations`;
  const noteEl = document.getElementById('portfolio-chart-depletion-note');
  if (noteEl) {
    if (results.success_metrics.failure_count > 0) {
      noteEl.hidden = false;
      noteEl.textContent = `${results.success_metrics.failure_count.toLocaleString('en-US')} of ${results.success_metrics.total_simulations.toLocaleString('en-US')} simulations depleted before year ${py}.`;
    } else {
      noteEl.hidden = true;
    }
  }
}

function bindPortfolioChartToggle() {
  document.querySelectorAll('[data-chart="portfolio"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentPortfolioMode) return;
      currentPortfolioMode = mode;
      document.querySelectorAll('[data-chart="portfolio"]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (lastResults) renderPortfolioFanChart(lastResults, mode);
    });
  });
}

/* ============================================================
   Section 6.3 — Results Summary Text Block
   ============================================================ */
function renderResultsSummaryText(results) {
  const el = document.getElementById('results-summary');
  if (!el) return;
  const inp = results.inputs_summary;
  const sm  = results.success_metrics;
  const sims = inp.n_simulations.toLocaleString('en-US');
  const initBal = formatCurrency(inp.initial_balance);
  // Parse historical period e.g. "1976-2025 (modern era)" → start/end year
  const m = String(inp.historical_period).match(/(\d{4})\D+(\d{4})/);
  const startYear = m ? m[1] : '—';
  const endYear   = m ? m[2] : '—';
  const portMean = inp.portfolio_historical_mean.toFixed(2);
  const portCagr = inp.portfolio_historical_cagr.toFixed(2);
  const portStd  = inp.portfolio_historical_std.toFixed(2);
  const inflMean = inp.inflation_historical_mean.toFixed(2);
  const inflStd  = inp.inflation_historical_std.toFixed(2);
  const bucket1Expense = INPUT_STATE.buckets[0]?.expense || 0;
  const successRate = sm.success_rate_pct.toFixed(1);

  // Strategy-specific descriptor
  const stratName = {
    none: 'None — Use Expense Schedule',
    constant_dollar: 'Constant Dollar (Bengen 4% rule)',
    forgo_inflation: 'Forgo Inflation Adjustment',
    actual_spending: 'Actual Spending Decline',
    guyton_klinger: 'Guyton-Klinger Guardrails',
  }[INPUT_STATE.distribution_strategy] || INPUT_STATE.distribution_strategy;

  const stratDescription = (() => {
    const sp = INPUT_STATE.strategy_params || {};
    switch (INPUT_STATE.distribution_strategy) {
      case 'constant_dollar':
        return `Withdrawals followed the <strong>Constant Dollar</strong> method — Bucket 1’s amount (${formatCurrency(bucket1Expense)} in today’s dollars) inflation-adjusted each subsequent year.`;
      case 'forgo_inflation':
        return `Withdrawals followed the <strong>Forgo Inflation</strong> method — each year’s bucket × the effective inflation index. Inflation raises are skipped permanently after any portfolio-loss year.`;
      case 'actual_spending':
        return `Withdrawals followed the <strong>Actual Spending Decline</strong> method at ${(sp.real_spending_decline_pct || 2).toFixed(1)}% real decline per year — Bucket 1 anchored at year 1 (${formatCurrency(bucket1Expense)} in today’s dollars), then carry-forward growth at (inflation − decline). Floor and ceiling at 50% / 150% of Bucket 1’s inflated target.`;
      case 'guyton_klinger':
        return `Withdrawals followed <strong>Guyton-Klinger Guardrails</strong> — bucket-driven baseline, Rule 1 inflation skip after loss years, Rule 2 guardrails (cut ${(sp.upper_adjustment_pct || 10).toFixed(0)}% if rate > ${(sp.upper_guardrail_pct || 6).toFixed(1)}%; raise ${(sp.lower_adjustment_pct || 10).toFixed(0)}% if rate < ${(sp.lower_guardrail_pct || 4).toFixed(1)}%). Upper cut suspended in the final 15 years.`;
      case 'none':
      default:
        return `Withdrawals followed your expense schedule literally — each year’s bucket value, inflation-adjusted from today’s dollars.`;
    }
  })();

  let html = '';
  html += `<p>Monte Carlo simulation results for <em>${sims}</em> portfolios with a <em>${initBal}</em> initial balance, using historical returns data from <em>Jan ${startYear}</em> to <em>Dec ${endYear}</em> with annual sampling. The historical pre-tax return for the selected portfolio over this period was <em>${portMean}%</em> mean return (<em>${portCagr}%</em> CAGR) with <em>${portStd}%</em> standard deviation of annual returns.</p>`;
  html += `<p>${stratDescription} The inflation model used historical inflation with <em>${inflMean}%</em> mean and <em>${inflStd}%</em> standard deviation based on CPI-U data over the same window. Generated inflation samples were correlated with simulated asset returns based on row-level historical correlations.</p>`;
  if (inp.constraining_asset && inp.constraining_asset_start > parseInt(startYear, 10)) {
    html += `<p>The available historical data for the simulation inputs was constrained by <em>${escapeHtml(inp.constraining_asset)}</em>, whose native data begins in <em>${inp.constraining_asset_start}</em>.</p>`;
  }
  if (inp.sequence_of_returns_active) {
    if (inp.sor_mode === 'forced_2008') {
      html += `<p>This simulation applied <strong>2008’s actual returns</strong> to Year 1 of every portfolio path as a sequence-of-returns stress test.</p>`;
    } else if (inp.sor_mode === 'computed_worst') {
      html += `<p>This simulation applied a <strong>worst-year-first</strong> sequence-of-returns stress test — within each simulation’s random 30-year sequence, the year with the lowest weighted portfolio return was moved to Year 1.</p>`;
    }
  }
  if (results.minimum_withdrawal_annual > 0) {
    html += `<p>A minimum annual withdrawal floor of <em>${formatCurrency(results.minimum_withdrawal_annual)}</em> was active. The floor grows with inflation each year; it overrides the strategy’s output whenever the strategy would calculate a lower amount.</p>`;
  }
  html += `<p>All returns are pre-tax — users should account for income taxes within their expense inputs. Portfolio is rebalanced annually after each year’s withdrawal. Overall success rate: <strong>${successRate}%</strong> across <em>${sims}</em> simulations.</p>`;
  el.innerHTML = html;
}

/* ============================================================
   Income Variability Report (Batch C3)
   ============================================================ */
let incomeFanChart = null;
let guardrailHeatmapChart = null;
let currentIncomeMode = 'nominal';

function renderIncomeVariabilityReport(results) {
  const strategy = INPUT_STATE.distribution_strategy;
  renderIVRSubheader(strategy);
  renderIncomeFanChart(results, currentIncomeMode);
  bindIncomeChartToggle();
  renderIncomeSummaryCards(results);
  // G-K specific:
  const isGK = strategy === 'guyton_klinger' && results.gk_statistics;
  document.getElementById('guardrail-heatmap-card').hidden = !isGK;
  document.getElementById('gk-stats-card').hidden = !isGK;
  if (isGK) {
    renderGuardrailHeatmap(results);
    renderGKStatsTable(results);
  } else {
    if (guardrailHeatmapChart) { guardrailHeatmapChart.destroy(); guardrailHeatmapChart = null; }
  }
  renderIVRCallout(results);
}

function renderIVRSubheader(strategy) {
  const el = document.getElementById('ivr-subheader');
  if (!el) return;
  const subheaders = {
    none:            'With None (Use Expense Schedule), income tracks your plan literally — each year’s bucket value, inflated forward.',
    constant_dollar: 'With Constant Dollar, income is fully predictable — Bucket 1 inflated each year. The chart shows the resulting nominal/real path.',
    forgo_inflation: 'With Forgo Inflation Adjustment, income is nearly stable but permanently behind inflation after every loss year.',
    actual_spending: 'With Actual Spending Decline, income grows slowly nominally and declines in real terms — matching how retirees actually spend.',
    guyton_klinger:  'With Guyton-Klinger Guardrails, income varies based on market performance. The chart shows the full range of annual withdrawal outcomes.',
  };
  el.textContent = subheaders[strategy] || '';
}

function renderIncomeFanChart(results, mode) {
  const canvas = document.getElementById('income-fan-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (incomeFanChart) { incomeFanChart.destroy(); incomeFanChart = null; }

  const sa = results.inputs_summary.start_age;
  const py = results.inputs_summary.period_years;
  const sims = results.inputs_summary.n_simulations;
  const paths = results.income_percentile_paths;
  const year1 = results.year1_withdrawal_nominal;
  const strategy = INPUT_STATE.distribution_strategy;

  // Income arrays are length period_years (one value per year, year 1 .. year Y).
  const labels = [];
  for (let i = 0; i < py; i++) labels.push(sa + i + 1);

  const NAVY    = '#1F3D6B';
  const NAVY_15 = 'rgba(31, 61, 107, 0.13)';
  const NAVY_25 = 'rgba(31, 61, 107, 0.22)';
  const GOLD    = '#B58820';
  const CLAY    = '#C84A30';
  const INK     = '#14181E';

  const p = (key) => mode === 'real' ? paths[`real_${key}`] : paths[key];
  // Whether to show filled bands: skip for near-deterministic strategies (None / CD)
  // where all percentiles overlap closely.
  const showBands = strategy === 'actual_spending' || strategy === 'guyton_klinger' || strategy === 'forgo_inflation';

  const datasets = [];
  if (showBands) {
    datasets.push(
      { label: '_p10', data: p('p10'), borderColor: 'transparent', backgroundColor: NAVY_15, pointRadius: 0, fill: false, tension: 0.2 },
      { label: '10–90% range', data: p('p90'), borderColor: 'transparent', backgroundColor: NAVY_15, pointRadius: 0, fill: 0, tension: 0.2 },
      { label: '_p25', data: p('p25'), borderColor: 'transparent', backgroundColor: NAVY_25, pointRadius: 0, fill: false, tension: 0.2 },
      { label: '25–75% range', data: p('p75'), borderColor: 'transparent', backgroundColor: NAVY_25, pointRadius: 0, fill: 2, tension: 0.2 },
    );
  }
  datasets.push({
    label: 'Median (50th)', data: p('p50'),
    borderColor: NAVY, backgroundColor: 'transparent',
    borderWidth: 2.5, pointRadius: 0, fill: false, tension: 0.2,
  });
  // Year 1 reference line (gold dashed)
  datasets.push({
    label: `Year 1 (${fmtCurrencyShort(year1)})`,
    data: labels.map(() => year1),
    borderColor: GOLD, backgroundColor: 'transparent',
    borderWidth: 1, borderDash: [6, 4], pointRadius: 0, fill: false,
  });
  // G-K first-cut reference line (amber dashed)
  if (strategy === 'guyton_klinger') {
    const adj = INPUT_STATE.strategy_params.upper_adjustment_pct || 10;
    const firstCutLevel = year1 * (1 - adj / 100);
    datasets.push({
      label: `Cut reference (−${adj.toFixed(0)}% from Year 1)`,
      data: labels.map(() => firstCutLevel),
      borderColor: CLAY, backgroundColor: 'transparent',
      borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false,
    });
  }

  incomeFanChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            filter: (item) => !item.text.startsWith('_'),
            font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11 },
            color: INK, boxWidth: 22, boxHeight: 10, padding: 14,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => `Age ${items[0].label}`,
            label: (ctx) => ctx.dataset.label.startsWith('_') ? null
              : `${ctx.dataset.label}: ${fmtCurrencyShort(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Age', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: {
            callback: (_, i) => i % 5 === 0 ? labels[i] : '',
            maxRotation: 0, color: INK,
            font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 },
          },
          grid: { color: 'rgba(20,24,30,0.05)' },
        },
        y: {
          min: 0,
          title: {
            display: true,
            text: mode === 'real' ? 'Annual Withdrawal (Real, today’s $)' : 'Annual Withdrawal (Nominal)',
            color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' },
          },
          ticks: { callback: (v) => fmtCurrencyShort(v), color: INK, font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 } },
          grid: { color: 'rgba(20,24,30,0.10)' },
        },
      },
    },
  });

  const titleEl = document.getElementById('income-chart-title');
  if (titleEl) titleEl.textContent = `Projected Annual Income — ${sims.toLocaleString('en-US')} Simulations`;
}

function bindIncomeChartToggle() {
  document.querySelectorAll('[data-chart="income"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentIncomeMode) return;
      currentIncomeMode = mode;
      document.querySelectorAll('[data-chart="income"]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (lastResults) renderIncomeFanChart(lastResults, mode);
    });
  });
}

function renderGuardrailHeatmap(results) {
  const canvas = document.getElementById('guardrail-heatmap-chart');
  if (!canvas || typeof Chart === 'undefined' || !results.gk_statistics) return;
  if (guardrailHeatmapChart) { guardrailHeatmapChart.destroy(); guardrailHeatmapChart = null; }

  const gk = results.gk_statistics;
  const py = results.inputs_summary.period_years;
  const sa = results.inputs_summary.start_age;
  const labels = [];
  for (let i = 0; i < py; i++) labels.push(sa + i + 1);

  const CLAY = '#C84A30';
  const TEAL = '#1A6E6E';
  const INK  = '#14181E';

  guardrailHeatmapChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Upper guardrail hit (spending cut)',
          data: gk.pct_cuts_by_year,
          backgroundColor: 'rgba(200, 74, 48, 0.75)', borderColor: CLAY, borderWidth: 1 },
        { label: 'Lower guardrail hit (spending raise)',
          data: gk.pct_raises_by_year,
          backgroundColor: 'rgba(26, 110, 110, 0.75)', borderColor: TEAL, borderWidth: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11 }, color: INK, boxWidth: 22, boxHeight: 10, padding: 14 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}% of simulations` } },
      },
      scales: {
        x: {
          title: { display: true, text: 'Age', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: { callback: (_, i) => i % 5 === 0 ? labels[i] : '', maxRotation: 0, color: INK, font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 } },
          grid: { color: 'rgba(20,24,30,0.05)' },
        },
        y: {
          min: 0, max: 100,
          title: { display: true, text: '% of Simulations', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: { callback: (v) => v + '%', color: INK, font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 } },
          grid: { color: 'rgba(20,24,30,0.10)' },
        },
      },
    },
  });
}

function renderIncomeSummaryCards(results) {
  const container = document.getElementById('income-summary-cards');
  if (!container) return;
  const strategy = INPUT_STATE.distribution_strategy;
  const inp = results.inputs_summary;
  const sa = inp.start_age;
  const py = inp.period_years;
  const paths = results.income_percentile_paths;
  const year1 = results.year1_withdrawal_nominal;
  const endAge = sa + py;
  const midYearIdx = Math.min(14, py - 1); // year 15 if available
  const midAge = sa + midYearIdx + 1;

  // Card 4 is strategy-specific
  let card4Label, card4Value, card4Sub;
  if (strategy === 'constant_dollar') {
    card4Label = 'Real income — final year (median)';
    card4Value = fmtCurrencyShort(paths.real_p50[py - 1]);
    card4Sub = 'Purchasing power in today’s dollars';
  } else if (strategy === 'forgo_inflation') {
    card4Label = 'Real income — final year (median)';
    card4Value = fmtCurrencyShort(paths.real_p50[py - 1]);
    card4Sub = 'Erosion vs. Constant Dollar reflects skipped raises';
  } else if (strategy === 'actual_spending') {
    card4Label = 'Real income — final year (median)';
    card4Value = fmtCurrencyShort(paths.real_p50[py - 1]);
    card4Sub = `Declining at ~${(INPUT_STATE.strategy_params.real_spending_decline_pct || 2).toFixed(1)}%/yr by design`;
  } else if (strategy === 'guyton_klinger' && results.gk_statistics) {
    card4Label = 'Simulations with at least 1 cut';
    card4Value = `${results.gk_statistics.pct_sims_with_any_cut.toFixed(1)}%`;
    card4Sub = 'Upper guardrail triggered at least once';
  } else {
    card4Label = 'Real income — final year (median)';
    card4Value = fmtCurrencyShort(paths.real_p50[py - 1]);
    card4Sub = 'Purchasing power in today’s dollars';
  }

  container.innerHTML = '';
  container.appendChild(ivrCard('Year 1 Withdrawal', fmtCurrencyShort(year1),
    `${(results.year1_withdrawal_rate_pct || 0).toFixed(2)}% of starting portfolio`));
  container.appendChild(ivrCard('Median Final Year Withdrawal', fmtCurrencyShort(paths.p50[py - 1]),
    `Age ${endAge} · 50th percentile (nominal)`));
  container.appendChild(ivrCard(`Income Range at Age ${midAge}`,
    `${fmtCurrencyShort(paths.p10[midYearIdx])} – ${fmtCurrencyShort(paths.p90[midYearIdx])}`,
    `10th to 90th percentile`));
  container.appendChild(ivrCard(card4Label, card4Value, card4Sub));
}

function ivrCard(label, value, sub) {
  const div = document.createElement('div');
  div.className = 'ivr-card';
  const l = document.createElement('div'); l.className = 'ivr-card__label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'ivr-card__value'; v.textContent = value;
  const s = document.createElement('div'); s.className = 'ivr-card__sub';   s.textContent = sub || '';
  div.appendChild(l); div.appendChild(v); div.appendChild(s);
  return div;
}

function renderGKStatsTable(results) {
  if (!results.gk_statistics) return;
  const tbody = document.querySelector('#gk-stats-table tbody');
  if (!tbody) return;
  const gk = results.gk_statistics;
  const sa = results.inputs_summary.start_age;
  const paths = results.income_percentile_paths;
  const totalSum = (arr) => arr.reduce((a, b) => a + b, 0);
  const rows = [
    ['Simulations with at least one spending cut',  `${gk.pct_sims_with_any_cut.toFixed(1)}%`],
    ['Simulations with at least one spending raise', `${gk.pct_sims_with_any_raise.toFixed(1)}%`],
    ['Average spending cuts per simulation',   gk.avg_cuts_per_sim.toFixed(2)],
    ['Average spending raises per simulation', gk.avg_raises_per_sim.toFixed(2)],
    ['Average year of first spending cut',
      gk.avg_year_of_first_cut != null ? `Year ${gk.avg_year_of_first_cut.toFixed(1)} (≈ Age ${Math.round(sa + gk.avg_year_of_first_cut)})` : 'No cuts occurred'],
    ['Median year of first spending cut',
      gk.median_year_of_first_cut != null ? `Year ${gk.median_year_of_first_cut} (Age ${sa + gk.median_year_of_first_cut})` : 'No cuts occurred'],
    ['Median total lifetime income (nominal)', fmtCurrencyShort(totalSum(paths.p50))],
    ['Median total lifetime income (real, today’s $)', fmtCurrencyShort(totalSum(paths.real_p50))],
  ];
  tbody.innerHTML = '';
  for (const [label, val] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.className = 'metric-label'; td1.textContent = label;
    const td2 = document.createElement('td'); td2.className = 'num'; td2.textContent = val;
    tr.appendChild(td1); tr.appendChild(td2);
    tbody.appendChild(tr);
  }
}

function renderIVRCallout(results) {
  const el = document.getElementById('ivr-callout');
  if (!el) return;
  const strategy = INPUT_STATE.distribution_strategy;
  const gk = results.gk_statistics;
  const callouts = {
    none:
      'With None, income variance comes entirely from inflation. Portfolio success depends on whether the inflation-adjusted draws are sustainable for your selected allocation.',
    constant_dollar:
      'With Constant Dollar, income is fully predictable in real terms. Portfolio success rate reflects whether the fixed real withdrawal schedule depleted the portfolio.',
    forgo_inflation:
      'With Forgo Inflation, each skipped raise stays invested and compounds forward — preserving meaningful portfolio value over a 30+ year retirement without active decision-making.',
    actual_spending:
      'With Actual Spending Decline, lower late-life withdrawals preserve the portfolio. Typically produces a higher success rate than Constant Dollar at the same starting balance, with more income in the active early years.',
    guyton_klinger:
      gk
        ? `Guardrail strategies trade income predictability for portfolio longevity. In these simulations, ${gk.pct_sims_with_any_cut.toFixed(1)}% of scenarios triggered at least one spending cut and ${gk.pct_sims_with_any_raise.toFixed(1)}% triggered at least one raise. Scenarios where the upper guardrail fires more frequently tend to have higher portfolio survival rates — the strategy is working as designed.`
        : 'Guardrail strategies trade income predictability for portfolio longevity. The guardrail rules cut spending in stressed markets and raise spending in strong ones.',
  };
  let text = callouts[strategy] || '';
  if (results.minimum_withdrawal_annual > 0 && results.floor_binding_percentiles) {
    const p50bind = results.floor_binding_percentiles.p50 || 0;
    text += ` A minimum annual withdrawal floor of ${formatCurrency(results.minimum_withdrawal_annual)} was active; in the median scenario it was binding in ${p50bind} of ${results.inputs_summary.period_years} years.`;
  }
  el.textContent = text;
}

function devRenderResults(results) {
  hideElement('dev-progress');
  hideElement('results-placeholder');
  showElement('dev-results');

  // Cache for chart toggle re-renders
  lastResults = results;
  // Render the new Phase-4 visuals (above the existing dev-style table)
  renderSuccessCard(results);
  renderPortfolioFanChart(results, currentPortfolioMode);
  bindPortfolioChartToggle();
  renderResultsSummaryText(results);
  renderIncomeVariabilityReport(results);

  const elapsed = ((performance.now() - WORKER.startedAt) / 1000).toFixed(2);

  // ---- Results metrics table (Section 6.4)
  const tbody = document.querySelector('#dev-results-table tbody');
  if (tbody) {
    const s = results.statistics;
    const initial = results.inputs_summary.initial_balance;
    // Row spec: [label, val10, val25, val50, val75, val90, formatter, colorMode]
    //   colorMode: 'balance' tags cells by value vs initial (positive/eroded/zero)
    //              'plain' uses default
    const rows = [
      ['Ending balance (nominal)', s.p10.ending_balance_nominal, s.p25.ending_balance_nominal, s.p50.ending_balance_nominal, s.p75.ending_balance_nominal, s.p90.ending_balance_nominal, fmtCurrencyShort, 'balance'],
      ['Ending balance (real)',    s.p10.ending_balance_real,    s.p25.ending_balance_real,    s.p50.ending_balance_real,    s.p75.ending_balance_real,    s.p90.ending_balance_real,    fmtCurrencyShort, 'balance'],
      ['CAGR — nominal',           s.p10.cagr_nominal, s.p25.cagr_nominal, s.p50.cagr_nominal, s.p75.cagr_nominal, s.p90.cagr_nominal, fmtPctMaybe, 'plain'],
      ['CAGR — real',              s.p10.cagr_real,    s.p25.cagr_real,    s.p50.cagr_real,    s.p75.cagr_real,    s.p90.cagr_real,    fmtPctMaybe, 'plain'],
      ['Annualized volatility',    s.p10.annualized_volatility, s.p25.annualized_volatility, s.p50.annualized_volatility, s.p75.annualized_volatility, s.p90.annualized_volatility, fmtPctMaybe, 'plain'],
      ['Sharpe ratio',             s.p10.sharpe_ratio, s.p25.sharpe_ratio, s.p50.sharpe_ratio, s.p75.sharpe_ratio, s.p90.sharpe_ratio, (v) => v != null ? v.toFixed(3) : '—', 'plain'],
      ['Max drawdown — investment (Peak to Trough)', s.p10.max_drawdown_investment_pct, s.p25.max_drawdown_investment_pct, s.p50.max_drawdown_investment_pct, s.p75.max_drawdown_investment_pct, s.p90.max_drawdown_investment_pct, fmtPctMaybe, 'plain'],
      ['Max drawdown — account (Peak to Trough)',    s.p10.max_drawdown_pct,             s.p25.max_drawdown_pct,             s.p50.max_drawdown_pct,             s.p75.max_drawdown_pct,             s.p90.max_drawdown_pct,             fmtPctMaybe, 'plain'],
      ['Depleted?',                s.p10.depleted, s.p25.depleted, s.p50.depleted, s.p75.depleted, s.p90.depleted, (v) => v ? 'Yes' : 'No', 'plain'],
      ['Depletion year',           s.p10.depletion_year, s.p25.depletion_year, s.p50.depletion_year, s.p75.depletion_year, s.p90.depletion_year, (v) => v == null ? '—' : `Year ${v}`, 'plain'],
    ];
    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      const label = document.createElement('td');
      label.textContent = row[0];
      label.className = 'metric-label';
      tr.appendChild(label);
      const fmt = row[6];
      const colorMode = row[7];
      for (let i = 1; i <= 5; i++) {
        const td = document.createElement('td');
        td.className = 'num';
        if (i === 3) td.classList.add('is-median-col'); // p50 is the 3rd value column (index 1..5; 3 → p50)
        const v = row[i];
        td.textContent = fmt(v);
        if (colorMode === 'balance' && typeof v === 'number') {
          if (v <= 0)                td.classList.add('balance-zero');
          else if (v >= initial)     td.classList.add('balance-positive');
          else                       td.classList.add('balance-eroded');
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  // ---- Diagnostics
  const dl = document.getElementById('dev-diagnostics');
  if (dl) {
    const d = results.diagnostics;
    const c = d.crisis_year_coverage;
    const inputs = results.inputs_summary;
    const pairs = [
      ['Historical period',          inputs.historical_period],
      ['Eligible year pool size',    `${d.eligible_year_pool_size} rows (${d.eligible_year_first}–${d.eligible_year_last})`],
      ['Distinct years sampled',     `${d.distinct_years_sampled} of ${d.eligible_year_pool_size}`],
      ['Crisis-year coverage',       formatCrisisFlags(c)],
      ['Inflation × equity correlation', d.inflation_vs_equity_correlation != null
        ? `${d.inflation_vs_equity_correlation.toFixed(3)} (asset: ${d.correlation_asset_key})`
        : '—'],
      ['Portfolio historical mean',  `${inputs.portfolio_historical_mean.toFixed(2)}%`],
      ['Portfolio historical CAGR',  `${inputs.portfolio_historical_cagr.toFixed(2)}%`],
      ['Portfolio historical σ',     `${inputs.portfolio_historical_std.toFixed(2)}%`],
      ['Inflation mean / σ',         `${inputs.inflation_historical_mean.toFixed(2)}% / ${inputs.inflation_historical_std.toFixed(2)}%`],
      ['Constraining asset',         inputs.constraining_asset
        ? `${inputs.constraining_asset} (native ${inputs.constraining_asset_start})`
        : 'none'],
      ['Sequence-of-returns active', formatSorStatus(inputs)],
    ];
    dl.innerHTML = '';
    for (const [k, v] of pairs) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    }
  }

}

function devSummaryCell(label, value, hint) {
  const li = document.createElement('li');
  const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
  const v = document.createElement('span'); v.className = 'value'; v.textContent = value;
  const h = document.createElement('span'); h.className = 'hint';  h.textContent = hint || '';
  li.appendChild(l); li.appendChild(v); li.appendChild(h);
  return li;
}

function formatSorStatus(inputs) {
  if (!inputs.sequence_of_returns_active) return 'no';
  const mode = inputs.sor_mode;
  const avg = inputs.sor_year1_avg_return;
  const avgStr = (avg != null && Number.isFinite(avg)) ? ` (avg year-1 weighted ${avg.toFixed(2)}%)` : '';
  if (mode === 'forced_2008') {
    const r = inputs.sor_year_portfolio_return;
    const rStr = (r != null && Number.isFinite(r)) ? ` (weighted ${r.toFixed(2)}%)` : '';
    return `yes — 2008 placed at year 1${rStr}`;
  }
  if (mode === 'computed_worst') {
    const top = inputs.sor_year1_top_years;
    const topStr = (top && top.length) ? ` · top year-1 picks: ${top.map(t => `${t.year} (${t.pct.toFixed(1)}%)`).join(', ')}` : '';
    return `yes — worst drawn year moved to year 1${avgStr}${topStr}`;
  }
  return 'yes';
}

function formatCrisisFlags(c) {
  const flags = [
    ['1929', c.has_1929], ['1931', c.has_1931], ['1973', c.has_1973], ['2008', c.has_2008],
  ];
  return flags.map(([yr, ok]) => `${yr}: ${ok ? '✓' : '—'}`).join('  ');
}

function fmtCurrencyShort(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v <= 0) return '$0';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtPctMaybe(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}
// Boot the dev panel after the data layer is ready.
// We piggyback on the existing DOMContentLoaded handler by polling
// briefly for STATE.data; loadData() resolves on its own timeline.
function whenDataReady(cb) {
  const tryNow = () => {
    if (STATE.data) { cb(); return true; }
    return false;
  };
  if (tryNow()) return;
  const iv = setInterval(() => { if (tryNow()) clearInterval(iv); }, 80);
}
whenDataReady(initDevPanel);
