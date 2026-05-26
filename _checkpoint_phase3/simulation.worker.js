/* ============================================================
   Through the Noise — Monte Carlo Portfolio Simulation
   Web Worker: bootstrap simulation engine
   Phase 2
   ============================================================

   Message protocol
   ----------------
   In:  { type: 'run', inputs, data }
   Out: { type: 'progress', completed, total }
   Out: { type: 'results',  data: resultsObject }
   Out: { type: 'error',    message }

   Constraints (per spec section 9.3):
   - No external imports, no DOM, no fetch.
   - Main thread fetches the JSON and passes it in via the run message.
   ============================================================ */

'use strict';

const PERIOD_DEFS = {
  native:  { start: 1871, end: 2025 },
  postwar: { start: 1946, end: 2025 },
  modern:  { start: 1976, end: 2025 },
};

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type !== 'run') return;
  try {
    const startedAt = Date.now();
    const results = runSimulation(msg.inputs, msg.data);
    results.diagnostics = results.diagnostics || {};
    results.diagnostics.runtime_ms = Date.now() - startedAt;
    self.postMessage({ type: 'results', data: results });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};

/* -----------------------------------------------------------
   Entry
   ----------------------------------------------------------- */
function runSimulation(inputs, data) {
  validateInputs(inputs, data);

  const eligibleRows = buildEligibleRows(inputs, data);
  if (eligibleRows.length === 0) {
    throw new Error(
      'No historical years match your selected period and asset classes. Try a different period or a different set of assets.'
    );
  }

  // Sequence of Returns mode.
  //   'computed_worst' — pre-draw all Y rows per simulation, then move whichever
  //       drawn year has the lowest weighted return into position 1. The other
  //       Y-1 years stay in their original drawn order. Tests path dependency.
  //   'forced_2008'    — pre-draw all Y rows per simulation, then overwrite year 1
  //       with 2008's actual returns. Works even if 2008 is outside the selected
  //       period (by design).
  let sorMode = 'inactive';
  let sor2008Row = null;
  if (inputs.sequence_of_returns) {
    sorMode = inputs.sor_force_2008 ? 'forced_2008' : 'computed_worst';
    if (sorMode === 'forced_2008') {
      sor2008Row = data.annual_returns.find((r) => r.year === 2008);
      if (!sor2008Row) {
        throw new Error('2008 data not available for the forced sequence-of-returns stress test.');
      }
    }
  }

  const N = inputs.n_simulations;
  const Y = inputs.period_years;

  // Per-sim storage. We need all balances & returns to compute percentiles
  // and per-sim stats. Use typed arrays for memory efficiency.
  const nominalBalances = new Float64Array(N * (Y + 1));
  const realBalances    = new Float64Array(N * (Y + 1));
  const annualReturnsPct  = new Float64Array(N * Y);
  const tbillReturnsPct   = new Float64Array(N * Y);
  const inflationsPct     = new Float64Array(N * Y); // per-sim per-year inflation for TWR-real
  const depletedFlags   = new Uint8Array(N);
  const depletionYears  = new Int16Array(N); // 0 when not depleted; otherwise 1..Y

  // Diagnostics
  const sampledYearCounts = new Map(); // year -> count of times it was drawn (across all positions)
  const year1YearCounts   = new Map(); // year -> count of sims where it ended up at position 1
  const drawnInflation = [];           // for correlation sanity check
  const drawnStockReturn = [];         // first asset that matches sp500 or total_market_us
  const correlationAssetKey = pickCorrelationAsset(inputs);
  let year1WeightedSum = 0;            // sum of position-1 weighted returns across all sims

  let lastProgressPost = 0;

  for (let s = 0; s < N; s++) {
    runOneSim({
      simIndex: s,
      inputs,
      eligibleRows,
      sorMode,
      sor2008Row,
      Y,
      nominalBalances, realBalances, annualReturnsPct, tbillReturnsPct, inflationsPct,
      depletedFlags, depletionYears,
      sampledYearCounts, year1YearCounts,
      drawnInflation, drawnStockReturn, correlationAssetKey,
      year1AccRef: { add: (w) => { year1WeightedSum += w; } },
    });

    if (s + 1 - lastProgressPost >= 100 || s + 1 === N) {
      lastProgressPost = s + 1;
      self.postMessage({ type: 'progress', completed: s + 1, total: N });
    }
  }

  return aggregate({
    N, Y, inputs, data, eligibleRows,
    nominalBalances, realBalances, annualReturnsPct, tbillReturnsPct, inflationsPct,
    depletedFlags, depletionYears,
    sampledYearCounts, year1YearCounts, year1WeightedSum,
    drawnInflation, drawnStockReturn, correlationAssetKey,
    sorMode, sor2008Row,
  });
}

/* -----------------------------------------------------------
   Validation
   ----------------------------------------------------------- */
function validateInputs(inputs, data) {
  if (!data || !Array.isArray(data.annual_returns) || data.annual_returns.length === 0) {
    throw new Error('Historical return data is missing or empty.');
  }
  if (!inputs || !Array.isArray(inputs.allocations) || inputs.allocations.length === 0) {
    throw new Error('At least one asset class must be selected.');
  }
  const sumPct = inputs.allocations.reduce((a, b) => a + (b.pct || 0), 0);
  if (Math.abs(sumPct - 100) > 0.001) {
    throw new Error(`Allocations must sum to 100%. Current total: ${sumPct.toFixed(2)}%.`);
  }
  if (!(inputs.n_simulations > 0) || !(inputs.period_years > 0)) {
    throw new Error('Number of simulations and period length must be positive integers.');
  }
  if (!(inputs.initial_balance >= 1000)) {
    throw new Error('Starting portfolio balance must be at least $1,000.');
  }
  if (!Array.isArray(inputs.buckets) || inputs.buckets.length === 0) {
    throw new Error('At least one expense bucket is required.');
  }
  if (!(inputs.buckets[0].expense > 0)) {
    throw new Error('Bucket 1 expense must be greater than zero.');
  }
}

/* -----------------------------------------------------------
   Eligible-row pool
   ----------------------------------------------------------- */
function buildEligibleRows(inputs, data) {
  let start, end;
  if (inputs.historical_period === 'custom') {
    start = inputs.custom_start;
    end   = inputs.custom_end;
  } else {
    const def = PERIOD_DEFS[inputs.historical_period];
    if (!def) throw new Error(`Unknown historical period: ${inputs.historical_period}`);
    start = def.start;
    end   = def.end;
  }

  const keys = inputs.allocations.map((a) => a.key);
  const rows = [];
  for (const row of data.annual_returns) {
    if (row.year < start || row.year > end) continue;
    if (row.inflation == null) continue;
    if (row.st_tbills == null) continue; // needed for Sharpe denominator term
    let ok = true;
    for (const k of keys) {
      if (row[k] == null) { ok = false; break; }
    }
    if (ok) rows.push(row);
  }
  return rows;
}

/* -----------------------------------------------------------
   Single simulation
   ----------------------------------------------------------- */
function runOneSim(ctx) {
  const {
    simIndex, inputs, eligibleRows, sorMode, sor2008Row, Y,
    nominalBalances, realBalances, annualReturnsPct, tbillReturnsPct, inflationsPct,
    depletedFlags, depletionYears,
    sampledYearCounts, year1YearCounts,
    drawnInflation, drawnStockReturn, correlationAssetKey, year1AccRef,
  } = ctx;

  const balanceBase = simIndex * (Y + 1);
  const annBase     = simIndex * Y;

  let balance = inputs.initial_balance;
  let inflationIndex = 1.0;
  let depleted = false;
  let depletionYear = 0;

  nominalBalances[balanceBase] = balance;
  realBalances[balanceBase]    = balance;

  const allocCount = inputs.allocations.length;

  // PHASE 1: pre-draw Y row references (random with replacement).
  const rowSeq = new Array(Y);
  for (let t = 0; t < Y; t++) {
    rowSeq[t] = eligibleRows[(Math.random() * eligibleRows.length) | 0];
  }

  // PHASE 2: sequence-of-returns reorder.
  if (sorMode === 'computed_worst') {
    // Find the position with the lowest weighted-portfolio return.
    let worstIdx = 0;
    let worstReturn = Infinity;
    for (let t = 0; t < Y; t++) {
      const r0 = rowSeq[t];
      let r = 0;
      for (let i = 0; i < allocCount; i++) {
        const a = inputs.allocations[i];
        r += a.pct * r0[a.key] / 100;
      }
      if (r < worstReturn) { worstReturn = r; worstIdx = t; }
    }
    if (worstIdx !== 0) {
      // Move the worst row to position 0; the other Y-1 rows stay in original order.
      const w = rowSeq[worstIdx];
      rowSeq.splice(worstIdx, 1);
      rowSeq.unshift(w);
    }
  } else if (sorMode === 'forced_2008' && sor2008Row) {
    // Overwrite year 1 with 2008. Other Y-1 years stay as drawn.
    rowSeq[0] = sor2008Row;
  }

  // Track which year ended up at position 1 for diagnostics.
  if (sorMode !== 'inactive') {
    const y1 = rowSeq[0];
    year1YearCounts.set(y1.year, (year1YearCounts.get(y1.year) || 0) + 1);
    let y1Weighted = 0;
    for (let i = 0; i < allocCount; i++) {
      const a = inputs.allocations[i];
      y1Weighted += a.pct * y1[a.key] / 100;
    }
    year1AccRef.add(y1Weighted);
  }

  // PHASE 3: iterate through the (possibly reordered) sequence.
  for (let t = 1; t <= Y; t++) {
    const row = rowSeq[t - 1];

    // Diagnostics: sampled-year coverage + correlation pair
    sampledYearCounts.set(row.year, (sampledYearCounts.get(row.year) || 0) + 1);
    if (correlationAssetKey && row[correlationAssetKey] != null && row.inflation != null) {
      drawnInflation.push(row.inflation);
      drawnStockReturn.push(row[correlationAssetKey]);
    }

    // 1. Inflation index update — happens BEFORE expense lookup (today's-dollars to year-t dollars)
    inflationIndex *= 1 + row.inflation / 100;
    inflationsPct[annBase + (t - 1)] = row.inflation;

    // 2. Year-t expense (today's $ -> nominal year-t $)
    const bucketIdx = Math.min(((t - 1) / 5) | 0, inputs.buckets.length - 1);
    let expense = inputs.buckets[bucketIdx].expense || 0;
    if (inputs.expense_mode === 'monthly') expense *= 12;
    if (inputs.inflation_adjust) expense *= inflationIndex;

    // 3. Guaranteed income (SS / pension / annuity). All amounts in today's $.
    const age = inputs.current_age + t;
    const ss      = inputs.ss      || { amount: 0, start_age: 67 };
    const pension = inputs.pension || { amount: 0, start_age: 65, cola: false };
    const annuity = inputs.annuity || { amount: 0, start_age: 65, cola: false };

    let income = 0;
    if (ss.amount > 0 && age >= ss.start_age) {
      // SS always has COLA equal to inflation (spec)
      income += ss.amount * inflationIndex;
    }
    if (pension.amount > 0 && age >= pension.start_age) {
      income += pension.cola ? pension.amount * inflationIndex : pension.amount;
    }
    if (annuity.amount > 0 && age >= annuity.start_age) {
      income += annuity.cola ? annuity.amount * inflationIndex : annuity.amount;
    }

    // 4. Net withdrawal — surplus rolls into portfolio
    const net = expense - income; // positive => draw, negative => surplus
    let postWithdraw;
    if (net >= 0) {
      postWithdraw = balance - net;
    } else {
      postWithdraw = balance + (-net); // surplus added before applying return
    }

    if (postWithdraw <= 0 && !depleted) {
      depleted = true;
      depletionYear = t;
      // Fill remaining years with 0
      for (let u = t; u <= Y; u++) {
        nominalBalances[balanceBase + u] = 0;
        realBalances[balanceBase + u]    = 0;
      }
      annualReturnsPct[annBase + (t - 1)] = 0;
      tbillReturnsPct[annBase + (t - 1)]  = row.st_tbills;
      balance = 0;
      break;
    }

    // 5. Apply weighted portfolio return (annual rebalancing implicit via fixed weights)
    let weightedReturnPct = 0;
    for (let i = 0; i < allocCount; i++) {
      const a = inputs.allocations[i];
      weightedReturnPct += a.pct * row[a.key] / 100;
    }
    balance = postWithdraw * (1 + weightedReturnPct / 100);

    // 6. Record
    nominalBalances[balanceBase + t] = balance;
    realBalances[balanceBase + t]    = balance / inflationIndex;
    annualReturnsPct[annBase + (t - 1)] = weightedReturnPct;
    tbillReturnsPct[annBase + (t - 1)]  = row.st_tbills;
  }

  depletedFlags[simIndex] = depleted ? 1 : 0;
  depletionYears[simIndex] = depletionYear;
}

function pickCorrelationAsset(inputs) {
  // Use the first US-equity asset in the allocation for the correlation sanity check.
  const equityKeys = new Set([
    'sp500', 'total_market_us',
    'large_cap_blend', 'large_cap_value', 'large_cap_growth',
    'mid_cap_blend', 'mid_cap_value', 'mid_cap_growth',
    'small_cap_blend', 'small_cap_value', 'small_cap_growth',
  ]);
  for (const a of inputs.allocations) {
    if (equityKeys.has(a.key)) return a.key;
  }
  return inputs.allocations[0]?.key || null;
}

/* -----------------------------------------------------------
   Aggregate -> results object (Section 5.4)
   ----------------------------------------------------------- */
function aggregate(ctx) {
  const {
    N, Y, inputs, data, eligibleRows,
    nominalBalances, realBalances, annualReturnsPct, tbillReturnsPct, inflationsPct,
    depletedFlags, depletionYears,
    sampledYearCounts, year1YearCounts, year1WeightedSum,
    drawnInflation, drawnStockReturn, correlationAssetKey,
    sorMode, sor2008Row,
  } = ctx;

  // --- Per-sim summaries
  const sims = new Array(N);
  for (let s = 0; s < N; s++) {
    const balanceBase = s * (Y + 1);
    const annBase = s * Y;
    const endingNominal = nominalBalances[balanceBase + Y];
    const endingReal    = realBalances[balanceBase + Y];
    const isDepleted    = depletedFlags[s] === 1;
    const deplYear      = isDepleted ? depletionYears[s] : null;

    const activeYears = isDepleted ? Math.max(0, deplYear - 1) : Y;

    // --- Max drawdown — two flavors:
    //
    //   (a) Account-balance MDD: peak-to-trough of the actual nominal balance
    //       trajectory the user experienced — withdrawals INCLUDED. Reflects
    //       the worst dip the account ever showed. For depleted sims this
    //       saturates at -100% (the trough hits $0).
    //
    //   (b) Investment-only MDD: peak-to-trough of a hypothetical no-withdrawal
    //       trajectory using the same yearly returns the simulation drew.
    //       Reflects pure market performance for an apples-to-apples comparison
    //       across withdrawal rates. For depleted sims, runs over active years
    //       (1..deplYear-1) — the years where returns were actually applied.

    // (a) Account-balance MDD
    let peakAcct = nominalBalances[balanceBase];
    let maxDDAcct = 0;
    for (let t = 1; t <= Y; t++) {
      const b = nominalBalances[balanceBase + t];
      if (b > peakAcct) peakAcct = b;
      if (peakAcct > 0) {
        const dd = (peakAcct - b) / peakAcct;
        if (dd > maxDDAcct) maxDDAcct = dd;
      }
    }

    // (b) Investment-only MDD
    let nwBalance = inputs.initial_balance;
    let peakInv   = nwBalance;
    let maxDDInv  = 0;
    for (let t = 0; t < activeYears; t++) {
      nwBalance *= 1 + annualReturnsPct[annBase + t] / 100;
      if (nwBalance > peakInv) peakInv = nwBalance;
      if (peakInv > 0) {
        const dd = (peakInv - nwBalance) / peakInv;
        if (dd > maxDDInv) maxDDInv = dd;
      }
    }

    // Annualized volatility + per-sim Sharpe — use the active years only.
    let meanR = 0, meanRf = 0;
    for (let t = 0; t < activeYears; t++) {
      meanR  += annualReturnsPct[annBase + t];
      meanRf += tbillReturnsPct[annBase + t];
    }
    const denom = Math.max(1, activeYears);
    meanR /= denom; meanRf /= denom;
    let variance = 0;
    for (let t = 0; t < activeYears; t++) {
      const d = annualReturnsPct[annBase + t] - meanR;
      variance += d * d;
    }
    variance /= denom;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? (meanR - meanRf) / std : 0;

    // Time-weighted return — the geometric mean of the annual portfolio returns
    // earned by the underlying assets, independent of withdrawals. For depleted
    // sims, compute over the years where returns were actually applied
    // (1..depletionYear-1); those years still earned real returns even though
    // the sim later ran out of money.
    let cagrNominal = null;
    let cagrReal    = null;
    if (activeYears > 0) {
      let logNom  = 0;
      let logReal = 0;
      for (let t = 0; t < activeYears; t++) {
        const rNom  = annualReturnsPct[annBase + t] / 100;
        const rInfl = inflationsPct[annBase + t]    / 100;
        logNom  += Math.log(1 + rNom);
        // Real return per year via the Fisher relation
        const realFactor = (1 + rNom) / (1 + rInfl);
        // Guard against pathological negative-factor data (shouldn't occur for full rows)
        if (realFactor > 0) logReal += Math.log(realFactor);
      }
      cagrNominal = (Math.exp(logNom  / activeYears) - 1) * 100;
      cagrReal    = (Math.exp(logReal / activeYears) - 1) * 100;
    }

    sims[s] = {
      idx: s,
      endingNominal,
      endingReal,
      cagrNominal,
      cagrReal,
      volatility: std,
      sharpe,
      maxDrawdownPct:           -maxDDAcct * 100,   // account balance (incl. withdrawals)
      maxDrawdownInvestmentPct: -maxDDInv  * 100,   // pure investment performance
      depleted: isDepleted,
      depletionYear: deplYear,
    };
  }

  // --- Rank sims from worst outcome to best.
  // Primary key: ending nominal balance ascending. Depleted sims all sit at $0
  // at the bottom of that ordering. Within the depleted cluster (where every
  // ending balance is $0), break ties by depletion year — a sim that depleted
  // in year 28 is strictly better than one that depleted in year 8, so the
  // earlier depletion sorts lower (worse). Among survivors with identical
  // nominal endings (rare), fall back to ending real.
  sims.sort((a, b) => {
    if (a.endingNominal !== b.endingNominal) return a.endingNominal - b.endingNominal;
    if (a.depleted && b.depleted) {
      return (a.depletionYear || 0) - (b.depletionYear || 0);
    }
    if (a.depleted && !b.depleted) return -1;
    if (!a.depleted && b.depleted) return 1;
    return a.endingReal - b.endingReal;
  });

  const pickSim = (pct) => sims[Math.min(N - 1, Math.max(0, Math.floor((pct / 100) * (N - 1))))];
  const chosen = {
    p10: pickSim(10),
    p25: pickSim(25),
    p50: pickSim(50),
    p75: pickSim(75),
    p90: pickSim(90),
  };

  const extractPath = (sim, useReal) => {
    const src = useReal ? realBalances : nominalBalances;
    const base = sim.idx * (Y + 1);
    const out = new Array(Y + 1);
    for (let t = 0; t <= Y; t++) out[t] = src[base + t];
    return out;
  };

  const percentile_paths = {
    p10: extractPath(chosen.p10, false),
    p25: extractPath(chosen.p25, false),
    p50: extractPath(chosen.p50, false),
    p75: extractPath(chosen.p75, false),
    p90: extractPath(chosen.p90, false),
    real_p10: extractPath(chosen.p10, true),
    real_p25: extractPath(chosen.p25, true),
    real_p50: extractPath(chosen.p50, true),
    real_p75: extractPath(chosen.p75, true),
    real_p90: extractPath(chosen.p90, true),
  };

  // --- Per-metric independent percentile ranking.
  //
  // Each metric is ranked across the full population of N sims so that p10
  // always represents the "worst 10% for THAT metric" and p90 the "best 10%."
  // This means a row of the statistics object no longer corresponds to a single
  // simulation — it's the marginal distribution per metric. Far easier to
  // interpret in a results table than the prior "metrics of the representative
  // sim" approach, which created non-monotonic columns when metrics weren't
  // perfectly correlated with ending balance.
  //
  // Direction is "worst first" (ascending) for every metric where lower = worse
  // (ending balance, CAGR, Sharpe, drawdown — most-negative = worst); descending
  // for volatility (higher = worse).
  //
  // depleted? and depletion_year stay tied to the outcome ranking (the chosen
  // sim by ending balance + depletion-year tiebreak), because the meaningful
  // question is "in a bad-outcome scenario, what's the depletion picture?"

  const arr_endingNominal = sims.map((s) => s.endingNominal);
  const arr_endingReal    = sims.map((s) => s.endingReal);
  const arr_cagrNominal   = sims.map((s) => s.cagrNominal);
  const arr_cagrReal      = sims.map((s) => s.cagrReal);
  const arr_sharpe        = sims.map((s) => s.sharpe);
  const arr_vol           = sims.map((s) => s.volatility);
  const arr_mddAcct       = sims.map((s) => s.maxDrawdownPct);
  const arr_mddInv        = sims.map((s) => s.maxDrawdownInvestmentPct);

  const statsAt = (p) => ({
    ending_balance_nominal:        percentileOf(arr_endingNominal, p, 'asc'),
    ending_balance_real:           percentileOf(arr_endingReal,    p, 'asc'),
    cagr_nominal:                  percentileOf(arr_cagrNominal,   p, 'asc'),
    cagr_real:                     percentileOf(arr_cagrReal,      p, 'asc'),
    annualized_volatility:         percentileOf(arr_vol,           p, 'desc'), // higher = worse
    sharpe_ratio:                  percentileOf(arr_sharpe,        p, 'asc'),
    max_drawdown_pct:              percentileOf(arr_mddAcct,       p, 'asc'),  // more negative = worse
    max_drawdown_investment_pct:   percentileOf(arr_mddInv,        p, 'asc'),
    depleted:                      chosen[`p${p}`].depleted,
    depletion_year:                chosen[`p${p}`].depletionYear,
  });

  const statistics = {
    p10: statsAt(10),
    p25: statsAt(25),
    p50: statsAt(50),
    p75: statsAt(75),
    p90: statsAt(90),
  };

  // --- Success metrics
  let successCount = 0;
  let totalDeplYears = 0;
  const deplYearsList = [];
  const pctDepletedByYear = new Array(Y + 1).fill(0);
  for (const sim of sims) {
    if (sim.depleted) {
      totalDeplYears += sim.depletionYear;
      deplYearsList.push(sim.depletionYear);
      for (let y = sim.depletionYear; y <= Y; y++) pctDepletedByYear[y]++;
    } else {
      successCount++;
    }
  }
  const failureCount = N - successCount;
  deplYearsList.sort((a, b) => a - b);
  const medianDeplYear = deplYearsList.length
    ? deplYearsList[Math.floor(deplYearsList.length / 2)]
    : null;

  const success_metrics = {
    success_count: successCount,
    total_simulations: N,
    success_rate_pct: (successCount / N) * 100,
    failure_count: failureCount,
    avg_depletion_year:    failureCount ? totalDeplYears / failureCount : null,
    median_depletion_year: medianDeplYear,
    pct_depleted_by_year:  pctDepletedByYear.map((c) => (c / N) * 100),
  };

  // --- Historical-period reference statistics for the chosen portfolio
  const portStats = computePortfolioPeriodStats(inputs, eligibleRows);
  const inflStats = computeInflationPeriodStats(eligibleRows);

  // --- Constraining asset (latest native_start among chosen assets)
  const constraining = findConstrainingAsset(inputs, data);

  // --- inputs_summary
  const periodLabel = describePeriod(inputs, eligibleRows);
  const inputs_summary = {
    n_simulations: N,
    period_years: Y,
    start_age: inputs.current_age,
    end_age: inputs.current_age + Y,
    initial_balance: inputs.initial_balance,
    historical_period: periodLabel,
    portfolio_historical_cagr: portStats.cagr,
    portfolio_historical_mean: portStats.mean,
    portfolio_historical_std:  portStats.std,
    inflation_historical_mean: inflStats.mean,
    inflation_historical_std:  inflStats.std,
    constraining_asset:        constraining ? constraining.name : null,
    constraining_asset_start:  constraining ? constraining.native_start : null,
    sequence_of_returns_active: !!inputs.sequence_of_returns,
    sor_mode: sorMode || 'inactive',                            // 'inactive' | 'forced_2008' | 'computed_worst'
    // For forced_2008: year 1 is always 2008 (single value).
    // For computed_worst: year 1 varies by sim — report avg & top years separately below.
    sor_year_used: sorMode === 'forced_2008' && sor2008Row ? 2008 : null,
    sor_year_portfolio_return: sorMode === 'forced_2008' && sor2008Row
      ? inputs.allocations.reduce((s, a) => s + a.pct * sor2008Row[a.key] / 100, 0)
      : null,
    sor_year1_avg_return: sorMode !== 'inactive' && N > 0 ? year1WeightedSum / N : null,
    sor_year1_top_years: sorMode !== 'inactive'
      ? Array.from(year1YearCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([y, c]) => ({ year: y, count: c, pct: (c / N) * 100 }))
      : null,
    rebalancing: 'annual_post_withdrawal',
  };

  // --- Results table
  const results_table = [
    { percentile: 10, label: '10th percentile (pessimistic)', ...statistics.p10 },
    { percentile: 25, label: '25th percentile',               ...statistics.p25 },
    { percentile: 50, label: '50th percentile (median)',      ...statistics.p50 },
    { percentile: 75, label: '75th percentile',               ...statistics.p75 },
    { percentile: 90, label: '90th percentile (optimistic)',  ...statistics.p90 },
  ];

  // --- Diagnostics (Phase 2 sanity checks; safe to leave in production)
  const sampledYearArr = Array.from(sampledYearCounts.entries()).sort((a, b) => a[0] - b[0]);
  const crisisFlags = {
    has_1929: sampledYearCounts.has(1929),
    has_1931: sampledYearCounts.has(1931),
    has_1973: sampledYearCounts.has(1973),
    has_2008: sampledYearCounts.has(2008),
  };
  const inflStockCorr = pearson(drawnInflation, drawnStockReturn);

  const diagnostics = {
    eligible_year_pool_size: eligibleRows.length,
    eligible_year_first:     eligibleRows.length ? eligibleRows[0].year : null,
    eligible_year_last:      eligibleRows.length ? eligibleRows[eligibleRows.length - 1].year : null,
    distinct_years_sampled:  sampledYearCounts.size,
    crisis_year_coverage:    crisisFlags,
    sampled_year_top10:      sampledYearArr
      .slice()
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([y, c]) => ({ year: y, count: c })),
    inflation_vs_equity_correlation: inflStockCorr,
    correlation_asset_key: correlationAssetKey,
  };

  return {
    inputs_summary,
    percentile_paths,
    statistics,
    success_metrics,
    results_table,
    diagnostics,
  };
}

/* -----------------------------------------------------------
   Helpers
   ----------------------------------------------------------- */
function computePortfolioPeriodStats(inputs, eligibleRows) {
  // Historical pre-tax annual returns for the user's portfolio over the eligible pool.
  // Used in the results summary text block — not for the simulation itself.
  const returns = eligibleRows.map((row) => {
    let r = 0;
    for (const a of inputs.allocations) {
      r += a.pct * row[a.key] / 100;
    }
    return r;
  });
  return descriptiveStats(returns);
}

function computeInflationPeriodStats(eligibleRows) {
  const infl = eligibleRows.map((r) => r.inflation);
  return descriptiveStats(infl);
}

function descriptiveStats(arr) {
  const n = arr.length;
  if (n === 0) return { mean: 0, std: 0, cagr: 0 };
  let mean = 0;
  for (const x of arr) mean += x;
  mean /= n;
  let variance = 0;
  for (const x of arr) {
    const d = x - mean;
    variance += d * d;
  }
  variance /= n;
  const std = Math.sqrt(variance);

  // CAGR via geometric mean (returns are in %).
  let logSum = 0;
  for (const x of arr) logSum += Math.log(1 + x / 100);
  const cagr = (Math.exp(logSum / n) - 1) * 100;

  return { mean, std, cagr };
}

function findConstrainingAsset(inputs, data) {
  let latest = null;
  for (const a of inputs.allocations) {
    const meta = data.assets[a.key];
    if (!meta) continue;
    if (latest == null || meta.native_start > latest.native_start) latest = meta;
  }
  return latest;
}

function describePeriod(inputs, rows) {
  const first = rows.length ? rows[0].year : null;
  const last  = rows.length ? rows[rows.length - 1].year : null;
  if (inputs.historical_period === 'custom') return `${first}-${last} (custom)`;
  if (inputs.historical_period === 'native')  return `${first}-${last} (full data set)`;
  if (inputs.historical_period === 'postwar') return `${first}-${last} (post-WWII)`;
  if (inputs.historical_period === 'modern')  return `${first}-${last} (modern era)`;
  return `${first}-${last}`;
}

function percentileOf(values, pct, direction) {
  // Returns the value at the (pct/100)th percentile of `values`. `direction`
  // controls the sort order:
  //   'asc'  — ascending: index 0 = worst (lowest). Use for metrics where
  //            lower = worse (ending balance, CAGR, Sharpe, drawdown).
  //   'desc' — descending: index 0 = worst (highest). Use for metrics where
  //            higher = worse (volatility).
  // Nulls are pushed to the "worst" end (index 0) so a null doesn't accidentally
  // count as a best-case outcome.
  if (!values || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => {
    if (a == null && b == null) return 0;
    if (a == null) return -1;   // null treated as worst → goes to index 0
    if (b == null) return 1;
    return direction === 'desc' ? (b - a) : (a - b);
  });
  const n = sorted.length;
  const idx = Math.min(n - 1, Math.max(0, Math.floor((pct / 100) * (n - 1))));
  return sorted[idx];
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const ax = x[i] - mx;
    const ay = y[i] - my;
    num += ax * ay;
    dx2 += ax * ax;
    dy2 += ay * ay;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den > 0 ? num / den : null;
}
