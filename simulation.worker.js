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
  modern:  { start: 1972, end: 2025 },
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

  // Distribution strategy fields (v1.1 + v1.2 + v1.3).
  // Default to 'none' — the pure bucket-driven expense schedule, which is what
  // v1.0 actually did. Callers that don't supply distribution_strategy get the
  // user's literal multi-bucket plan honored each year (no strategy logic).
  const distributionStrategy = inputs.distribution_strategy || 'none';
  const sp = inputs.strategy_params || {};
  const minimumWithdrawalAnnual = inputs.minimum_withdrawal_annual || 0;
  const realSpendingDeclinePct = sp.real_spending_decline_pct != null ? sp.real_spending_decline_pct : 2.0;
  const upperGuardrailPct      = sp.upper_guardrail_pct      != null ? sp.upper_guardrail_pct      : 6.0;
  const lowerGuardrailPct      = sp.lower_guardrail_pct      != null ? sp.lower_guardrail_pct      : 4.0;
  // Separate cut % and raise %. Backward-compat: older callers may pass a single `adjustment_pct` — use it for both.
  const fallbackAdjustmentPct  = sp.adjustment_pct           != null ? sp.adjustment_pct           : 10.0;
  const gkUpperAdjustmentPct   = sp.upper_adjustment_pct     != null ? sp.upper_adjustment_pct     : fallbackAdjustmentPct;
  const gkLowerAdjustmentPct   = sp.lower_adjustment_pct     != null ? sp.lower_adjustment_pct     : fallbackAdjustmentPct;
  // Vanguard Dynamic Spending caps year-over-year nominal change in either direction.
  // Defaults match the standard Vanguard formulation: +5% ceiling, −2.5% floor.
  const vdsCeilingPct          = sp.vds_ceiling_pct          != null ? sp.vds_ceiling_pct          : 5.0;
  const vdsFloorPct            = sp.vds_floor_pct            != null ? sp.vds_floor_pct            : 2.5;

  // Per-sim storage. We need all balances & returns to compute percentiles
  // and per-sim stats. Use typed arrays for memory efficiency.
  const nominalBalances = new Float64Array(N * (Y + 1));
  const realBalances    = new Float64Array(N * (Y + 1));
  const annualReturnsPct  = new Float64Array(N * Y);
  const tbillReturnsPct   = new Float64Array(N * Y);
  const inflationsPct     = new Float64Array(N * Y); // per-sim per-year inflation for TWR-real
  const cumInflationIdx   = new Float64Array(N * Y); // per-sim per-year cumulative inflation index (for real income paths)
  const withdrawalByYear  = new Float64Array(N * Y); // per-sim per-year nominal gross withdrawal (strategy output)
  const depletedFlags   = new Uint8Array(N);
  const depletionYears  = new Int16Array(N); // 0 when not depleted; otherwise 1..Y
  const initialWithdrawalRates = new Float64Array(N); // year-1 (proposed_withdrawal / starting_balance) * 100

  // G-K event log — only populated when strategy === 'guyton_klinger'.
  // Outer array indexed by simIndex; inner array of {year, type, old_withdrawal, new_withdrawal, effective_rate_pct}.
  const allGkEvents  = distributionStrategy === 'guyton_klinger'   ? new Array(N) : null;
  const allVdsEvents = distributionStrategy === 'vanguard_dynamic' ? new Array(N) : null;

  // Per-sim floor-binding counts (years in which minimum_withdrawal_annual overrode the strategy).
  const floorBindingCounts = minimumWithdrawalAnnual > 0 ? new Int16Array(N) : null;

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
      // strategy state
      distributionStrategy,
      minimumWithdrawalAnnual,
      realSpendingDeclinePct,
      upperGuardrailPct,
      lowerGuardrailPct,
      gkUpperAdjustmentPct,
      gkLowerAdjustmentPct,
      vdsCeilingPct,
      vdsFloorPct,
      allGkEvents,
      allVdsEvents,
      floorBindingCounts,
      withdrawalByYear,
      cumInflationIdx,
      initialWithdrawalRates,
      // pre-existing storage
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
    cumInflationIdx, withdrawalByYear,
    depletedFlags, depletionYears,
    initialWithdrawalRates,
    distributionStrategy, minimumWithdrawalAnnual,
    allGkEvents, allVdsEvents, floorBindingCounts,
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
    distributionStrategy, minimumWithdrawalAnnual,
    realSpendingDeclinePct, upperGuardrailPct, lowerGuardrailPct, gkUpperAdjustmentPct, gkLowerAdjustmentPct,
    vdsCeilingPct, vdsFloorPct,
    allGkEvents, allVdsEvents, floorBindingCounts,
    withdrawalByYear, cumInflationIdx, initialWithdrawalRates,
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

  // --- Per-sim strategy state (v1.1 + v1.2)
  let current_withdrawal_nominal = 0; // gross expense target this year (used by all strategies; carry-forward for AS + G-K)
  let prior_year_portfolio_return = null;
  let sim_floor_binding_count = 0;
  // Effective inflation index for FI + G-K: cumulative inflation that does NOT
  // advance after a portfolio-loss year. Implements Rule 1 (inflation skip).
  let eff_inflation_index = 1.0;
  // G-K real-dollar carry-forward state. Holds the post-guardrail withdrawal
  // expressed in today's dollars. Nominal each year = gk_real_withdrawal ×
  // eff_inflation_index. Rule 1 is baked in because eff_inflation_index doesn't
  // advance in loss years. Bucket transitions scale this real value directly.
  let gk_real_withdrawal = 0;
  const gkEventsForSim = (distributionStrategy === 'guyton_klinger') ? [] : null;
  // VDS real-dollar carry-forward state. Holds last year's actual withdrawal in
  // today's $. Ceiling/floor are applied to the real value so the year-over-year
  // caps remain inflation-adjusted (Vanguard's published methodology).
  let vds_real_withdrawal = 0;
  const vdsEventsForSim = (distributionStrategy === 'vanguard_dynamic') ? [] : null;

  // Helper: get the annual gross expense for year t from the bucket schedule (today's dollars)
  const bucketExpenseForYear = (t) => {
    const bucketIdx = Math.min(((t - 1) / 5) | 0, inputs.buckets.length - 1);
    let e = inputs.buckets[bucketIdx].expense || 0;
    if (inputs.expense_mode === 'monthly') e *= 12;
    return e;
  };

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

    // 1. Record THIS year's bootstrap inflation rate, and the START-of-year cumulative
    //    inflation index (which is the cumulative inflation through year t-1; equals 1.0
    //    at year 1). All expense/income/floor calcs below use this start-of-year value.
    //    Year 1 expense therefore equals bucket × 1.0 = today's dollars — matching
    //    Bengen's convention. Inflation accumulates at END of year for use in year t+1.
    inflationsPct[annBase + (t - 1)]   = row.inflation;
    cumInflationIdx[annBase + (t - 1)] = inflationIndex;

    // 2. Guaranteed income (SS / pension / annuity). All amounts in today's $.
    //    Computed first because G-K's guardrail rate uses NET portfolio draw
    //    (gross expense − income) / portfolio.
    const age = inputs.current_age + t;
    const ss      = inputs.ss      || { amount: 0, start_age: 67 };
    const pension = inputs.pension || { amount: 0, start_age: 65, cola: false };
    const annuity = inputs.annuity || { amount: 0, start_age: 65, cola: false };

    let income = 0;
    if (ss.amount > 0 && age >= ss.start_age) {
      income += ss.amount * inflationIndex; // SS always COLA = inflation
    }
    if (pension.amount > 0 && age >= pension.start_age) {
      income += pension.cola ? pension.amount * inflationIndex : pension.amount;
    }
    if (annuity.amount > 0 && age >= annuity.start_age) {
      income += annuity.cola ? annuity.amount * inflationIndex : annuity.amount;
    }

    // 3. Strategy-aware gross expense / withdrawal target.
    //    Updated model (post-Phase-3 user revision):
    //      • constant_dollar  — locked to bucket 1 only: bucket[1] × inflation_index every year.
    //                           Buckets 2-N ignored entirely (UI disables them).
    //      • forgo_inflation  — bucket-driven: bucket[t] × eff_inflation_index.
    //                           eff_inflation_index advances each year EXCEPT after a loss year.
    //                           Skipped raises are permanent (index never catches up).
    //                           Bucket transitions honored.
    //      • actual_spending  — carry-forward: previous × (1 + (inflation − real_decline)).
    //                           Floor / ceiling = 50% / 150% of current bucket's inflated target.
    //      • guyton_klinger   — classic carry-forward with bucket-transition rebasing.
    //                           Year 1 anchor = bucket[1] in today's $. Year t ≥ 2: start from
    //                           prior year's real withdrawal, rebase at bucket transitions by
    //                           (new_bucket / old_bucket), apply Rule 1 inflation via
    //                           eff_inflation_index (no advance after a loss year), then apply
    //                           Rule 2 guardrails. Post-guardrail value carries forward.
    //                           Upper cut suspended when years_remaining ≤ 15. Lower raise
    //                           always active.
    //      • vanguard_dynamic — Vanguard Dynamic Spending. Year 1 anchor = bucket[1]; implies
    //                           target_rate = bucket[1] / initial_balance. Year t ≥ 2 (all in REAL,
    //                           today's $):
    //                             target_real_t  = (current_balance × target_rate) / inflation_index
    //                             ceiling_real_t = prior_real × (1 + vds_ceiling / 100)
    //                             floor_real_t   = prior_real × (1 − vds_floor / 100)
    //                             actual_real_t  = clamp(target_real_t, floor_real_t, ceiling_real_t)
    //                             actual_nominal_t = actual_real_t × inflation_index, carries forward.
    //                           Year-over-year caps operate on REAL spending (Vanguard's published
    //                           methodology), so the nominal ceiling/floor automatically scales with
    //                           inflation. Buckets 2-N are locked (the strategy is purely
    //                           portfolio-driven after the year-1 anchor).

    // eff_inflation_index is the cumulative inflation through year t-1 with skipped
    // years deducted (Rule 1). At year 1 it equals 1.0 (today's $). End-of-year update
    // below advances it by this year's inflation IF this year's return was not a loss.

    if (distributionStrategy === 'none') {
      // Pure bucket-driven — honor the user's expense schedule literally.
      // Year t expense = bucket[t] (today's $) × cumulative inflation, no strategy logic.
      // This is the v1.0 behavior preserved as an explicit option.
      const bucketAnnual = bucketExpenseForYear(t);
      current_withdrawal_nominal = inputs.inflation_adjust ? bucketAnnual * inflationIndex : bucketAnnual;
    } else if (distributionStrategy === 'constant_dollar') {
      // Always use bucket 1 — buckets 2+ locked in UI for this strategy.
      const bucket1 = bucketExpenseForYear(1);
      current_withdrawal_nominal = inputs.inflation_adjust ? bucket1 * inflationIndex : bucket1;
    } else if (distributionStrategy === 'forgo_inflation') {
      // Bucket-driven baseline with Rule 1 skip (eff_inflation_index already updated above).
      const bucketAnnual = bucketExpenseForYear(t);
      current_withdrawal_nominal = inputs.inflation_adjust ? bucketAnnual * eff_inflation_index : bucketAnnual;
    } else if (distributionStrategy === 'actual_spending') {
      if (t === 1) {
        // Year-1 anchor for carry-forward.
        const bucket1 = bucketExpenseForYear(1);
        current_withdrawal_nominal = inputs.inflation_adjust ? bucket1 * inflationIndex : bucket1;
      } else {
        // Carry forward with net nominal growth = inflation − real decline.
        const netGrowthRate = (row.inflation - realSpendingDeclinePct) / 100;
        current_withdrawal_nominal *= 1 + netGrowthRate;
        // Floor / ceiling: 50% / 150% of BUCKET 1's inflated target.
        // (Buckets 2-N are locked in the UI for AS — only bucket 1 matters.)
        const bucket1 = bucketExpenseForYear(1);
        const inflatedBucket1Target = inputs.inflation_adjust ? bucket1 * inflationIndex : bucket1;
        const wdFloor   = inflatedBucket1Target * 0.50;
        const wdCeiling = inflatedBucket1Target * 1.50;
        if (current_withdrawal_nominal < wdFloor)   current_withdrawal_nominal = wdFloor;
        if (current_withdrawal_nominal > wdCeiling) current_withdrawal_nominal = wdCeiling;
      }
    } else if (distributionStrategy === 'guyton_klinger') {
      // Classic G-K with carry-forward. State is anchored in real (today's $)
      // dollars via gk_real_withdrawal; nominal each year is real × eff_inflation_index.
      // This automatically implements Rule 1 (no inflation after a loss year)
      // because eff_inflation_index doesn't advance in loss years.

      if (t === 1) {
        // Year-1 anchor: bucket[1] in today's $ (eff_inflation_index = 1.0 at year 1).
        const bucket1 = bucketExpenseForYear(1);
        gk_real_withdrawal = bucket1;
        current_withdrawal_nominal = inputs.inflation_adjust
          ? gk_real_withdrawal * eff_inflation_index   // = bucket1 × 1.0
          : gk_real_withdrawal;
        // Year 1 is the anchor — no guardrail check.
      } else {
        // (a) Bucket-transition rebase. Within a bucket, real value carries forward
        //     unchanged. At a transition year, scale by (new_bucket / old_bucket) so
        //     the user's revised real-dollar plan becomes the new baseline.
        const thisBucketIdx = Math.min(((t - 1) / 5) | 0, inputs.buckets.length - 1);
        const priorBucketIdx = Math.min(((t - 2) / 5) | 0, inputs.buckets.length - 1);
        if (thisBucketIdx !== priorBucketIdx) {
          const thisBucket = inputs.buckets[thisBucketIdx].expense || 0;
          const priorBucket = inputs.buckets[priorBucketIdx].expense || 0;
          if (priorBucket > 0) {
            gk_real_withdrawal *= thisBucket / priorBucket;
          }
        }

        // (b) Convert to nominal. eff_inflation_index already reflects Rule 1
        //     (no advance after loss years), so multiplying by it gives the
        //     correct "carry-forward × inflation OR carry-forward × 1.0" result
        //     depending on whether prior year was a loss.
        let proposed_nominal = inputs.inflation_adjust
          ? gk_real_withdrawal * eff_inflation_index
          : gk_real_withdrawal;

        // (c) Rule 2 guardrails — check effective rate on NET portfolio draw.
        const proposed_net = Math.max(0, proposed_nominal - income);
        const effectiveRatePct = balance > 0 ? (proposed_net / balance) * 100 : 0;
        const yearsRemaining = Y - t;
        const upperActive = yearsRemaining > 15; // final-15-year exception
        if (effectiveRatePct > upperGuardrailPct && upperActive) {
          const oldWd = proposed_nominal;
          proposed_nominal *= 1 - gkUpperAdjustmentPct / 100;
          gkEventsForSim.push({
            year: t, type: 'upper',
            old_withdrawal: oldWd, new_withdrawal: proposed_nominal,
            effective_rate_pct: effectiveRatePct,
          });
        } else if (effectiveRatePct < lowerGuardrailPct && proposed_net > 0) {
          const oldWd = proposed_nominal;
          proposed_nominal *= 1 + gkLowerAdjustmentPct / 100;
          gkEventsForSim.push({
            year: t, type: 'lower',
            old_withdrawal: oldWd, new_withdrawal: proposed_nominal,
            effective_rate_pct: effectiveRatePct,
          });
        }

        // (d) Persist for next year's carry-forward. Back-convert the
        //     post-guardrail nominal to real (today's $) so the guardrail
        //     effect compounds into future years' growth instead of resetting.
        current_withdrawal_nominal = proposed_nominal;
        if (inputs.inflation_adjust && eff_inflation_index > 0) {
          gk_real_withdrawal = proposed_nominal / eff_inflation_index;
        } else {
          gk_real_withdrawal = proposed_nominal;
        }
      }
    } else if (distributionStrategy === 'vanguard_dynamic') {
      // Vanguard Dynamic Spending. The tentative withdrawal each year is a
      // constant percentage of the *current* portfolio (target_rate is implied
      // by bucket[1] / initial_balance). The year-over-year caps are applied
      // in REAL (today's $) dollars per Vanguard's published methodology, so
      // the nominal caps automatically scale with inflation. Year 1 anchors
      // at bucket[1] in today's $.

      if (t === 1) {
        const bucket1 = bucketExpenseForYear(1);
        vds_real_withdrawal = bucket1;
        current_withdrawal_nominal = bucket1;  // inflationIndex == 1.0 at year 1
      } else {
        const bucket1 = bucketExpenseForYear(1);
        const targetRate = inputs.initial_balance > 0 ? bucket1 / inputs.initial_balance : 0;
        // target_nominal floats with the portfolio at the constant target rate.
        const target_nominal = balance * targetRate;
        // Convert to real (today's $) for the cap check.
        const target_real    = inputs.inflation_adjust && inflationIndex > 0
          ? target_nominal / inflationIndex
          : target_nominal;
        const ceiling_real = vds_real_withdrawal * (1 + vdsCeilingPct / 100);
        const floor_real   = vds_real_withdrawal * (1 - vdsFloorPct  / 100);
        let actual_real = target_real;
        let eventType = null;
        if (actual_real > ceiling_real) { actual_real = ceiling_real; eventType = 'ceiling'; }
        if (actual_real < floor_real)   { actual_real = floor_real;   eventType = 'floor';   }
        // Convert back to nominal.
        const actual_nominal = inputs.inflation_adjust ? actual_real * inflationIndex : actual_real;
        if (eventType && vdsEventsForSim) {
          vdsEventsForSim.push({
            year: t, type: eventType,
            target_real, actual_real,
          });
        }
        vds_real_withdrawal = actual_real;
        current_withdrawal_nominal = actual_nominal;
      }
    }

    // Year-1 initial withdrawal rate (for diagnostics — applies to all strategies).
    if (t === 1) {
      initialWithdrawalRates[simIndex] = balance > 0 ? (current_withdrawal_nominal / balance) * 100 : 0;
    }

    // 4. Minimum annual withdrawal floor (v1.2). Applies AFTER strategy logic so
    //    a strategy cut can be backstopped by the user's non-negotiable floor.
    if (minimumWithdrawalAnnual > 0) {
      const minNominal = inputs.inflation_adjust
        ? minimumWithdrawalAnnual * inflationIndex
        : minimumWithdrawalAnnual;
      if (current_withdrawal_nominal < minNominal) {
        current_withdrawal_nominal = minNominal;
        sim_floor_binding_count++;
      }
    }

    // 5. Record the final gross withdrawal for this year (for income paths).
    withdrawalByYear[annBase + (t - 1)] = current_withdrawal_nominal;

    // 6. Net portfolio draw — surplus rolls into portfolio.
    const net = current_withdrawal_nominal - income;
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

    // 7. Apply weighted portfolio return (annual rebalancing implicit via fixed weights)
    let weightedReturnPct = 0;
    for (let i = 0; i < allocCount; i++) {
      const a = inputs.allocations[i];
      weightedReturnPct += a.pct * row[a.key] / 100;
    }
    balance = postWithdraw * (1 + weightedReturnPct / 100);

    // 8. End-of-year inflation updates. Year t's inflation now applies to year t+1's
    //    calcs (cumulative through year t). eff advances only on non-loss years (Rule 1).
    inflationIndex *= 1 + row.inflation / 100;
    if (weightedReturnPct >= 0) {
      eff_inflation_index *= 1 + row.inflation / 100;
    }

    // 9. Record balances. Real balance uses END-of-year inflation (this year's
    //    nominal balance deflated by the cumulative inflation through year t).
    nominalBalances[balanceBase + t] = balance;
    realBalances[balanceBase + t]    = balance / inflationIndex;
    annualReturnsPct[annBase + (t - 1)] = weightedReturnPct;
    tbillReturnsPct[annBase + (t - 1)]  = row.st_tbills;

    // 10. Carry portfolio return to next year (still used by some legacy reference paths).
    prior_year_portfolio_return = weightedReturnPct;
  }

  depletedFlags[simIndex] = depleted ? 1 : 0;
  depletionYears[simIndex] = depletionYear;
  if (allGkEvents)         allGkEvents[simIndex]  = gkEventsForSim;
  if (allVdsEvents)        allVdsEvents[simIndex] = vdsEventsForSim;
  if (floorBindingCounts)  floorBindingCounts[simIndex] = sim_floor_binding_count;
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
    cumInflationIdx, withdrawalByYear,
    depletedFlags, depletionYears,
    initialWithdrawalRates,
    distributionStrategy, minimumWithdrawalAnnual,
    allGkEvents, allVdsEvents, floorBindingCounts,
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

  // Nominal-ranked representatives — used by the table's depleted? and
  // depletion_year rows (those metrics meaningfully belong to a specific
  // representative sim, not an independent percentile, since "depleted at the
  // 10th percentile" only makes sense if it's a single coherent outcome).
  const pickFrom = (arr) => (pct) =>
    arr[Math.min(N - 1, Math.max(0, Math.floor((pct / 100) * (N - 1))))];
  const pickSimNom = pickFrom(sims);
  const chosen = {
    p10: pickSimNom(10),
    p25: pickSimNom(25),
    p50: pickSimNom(50),
    p75: pickSimNom(75),
    p90: pickSimNom(90),
  };

  // Per-year percentile bands for the portfolio fan chart.
  //
  // For each year y, sort the balances of all N sims at that year and pick
  // p10/p25/p50/p75/p90. This is the standard Monte Carlo presentation:
  //
  //   • Monotonic by construction every year (p10 ≤ p25 ≤ p50 ≤ p75 ≤ p90),
  //     so the median can never plot below the 10th-percentile line.
  //   • Smooth — each band's year-to-year movement reflects the underlying
  //     stochastic process averaged across 10K sims, not the volatility of a
  //     single bootstrap path.
  //   • The endpoint at year Y still matches the table's ending-balance rows:
  //     balances at year Y equal endingNominal / endingReal exactly (depleted
  //     sims are zero-filled), so percentileOf(year-Y slice) ≡ percentileOf(endings).
  //
  // Replaces an earlier model that extracted full paths from single
  // representative sims, which caused lines to cross mid-period because the
  // p10-by-ending sim and the p50-by-ending sim each had their own bootstrap
  // sequence and could cross year-by-year.
  const percentile_paths = {
    p10: new Array(Y + 1), p25: new Array(Y + 1), p50: new Array(Y + 1),
    p75: new Array(Y + 1), p90: new Array(Y + 1),
    real_p10: new Array(Y + 1), real_p25: new Array(Y + 1), real_p50: new Array(Y + 1),
    real_p75: new Array(Y + 1), real_p90: new Array(Y + 1),
  };
  const yearSliceNom  = new Float64Array(N);
  const yearSliceReal = new Float64Array(N);
  const pctIdx10 = Math.min(N - 1, Math.max(0, Math.floor(0.10 * (N - 1))));
  const pctIdx25 = Math.min(N - 1, Math.max(0, Math.floor(0.25 * (N - 1))));
  const pctIdx50 = Math.min(N - 1, Math.max(0, Math.floor(0.50 * (N - 1))));
  const pctIdx75 = Math.min(N - 1, Math.max(0, Math.floor(0.75 * (N - 1))));
  const pctIdx90 = Math.min(N - 1, Math.max(0, Math.floor(0.90 * (N - 1))));
  for (let y = 0; y <= Y; y++) {
    for (let s = 0; s < N; s++) {
      yearSliceNom[s]  = nominalBalances[s * (Y + 1) + y];
      yearSliceReal[s] = realBalances[s * (Y + 1) + y];
    }
    // Float64Array.sort() defaults to numeric ascending — no comparator needed.
    const sortedNom  = yearSliceNom.slice().sort();
    const sortedReal = yearSliceReal.slice().sort();
    percentile_paths.p10[y]      = sortedNom[pctIdx10];
    percentile_paths.p25[y]      = sortedNom[pctIdx25];
    percentile_paths.p50[y]      = sortedNom[pctIdx50];
    percentile_paths.p75[y]      = sortedNom[pctIdx75];
    percentile_paths.p90[y]      = sortedNom[pctIdx90];
    percentile_paths.real_p10[y] = sortedReal[pctIdx10];
    percentile_paths.real_p25[y] = sortedReal[pctIdx25];
    percentile_paths.real_p50[y] = sortedReal[pctIdx50];
    percentile_paths.real_p75[y] = sortedReal[pctIdx75];
    percentile_paths.real_p90[y] = sortedReal[pctIdx90];
  }

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

  // --- Distribution Strategy v1.1/v1.2 — income paths, G-K stats, floor binding.

  // Median cumulative inflation index per year — used to convert nominal income paths to real.
  const medianInflationIndex = computeMedianInflationIndexPath(cumInflationIdx, N, Y);

  // Income percentile paths — per-year independent percentiles across all simulations.
  const incomeNominalPaths = computeIncomePercentilePaths(withdrawalByYear, N, Y);
  const incomeRealPaths = {};
  for (const key of Object.keys(incomeNominalPaths)) {
    incomeRealPaths[key] = incomeNominalPaths[key].map((v, y) => {
      const idx = medianInflationIndex[y] || 1;
      return v / idx;
    });
  }

  // G-K aggregate statistics (only when strategy is guyton_klinger).
  const gkStatistics = distributionStrategy === 'guyton_klinger'
    ? computeGKStatistics(allGkEvents, N, Y)
    : null;

  // VDS aggregate statistics (only when strategy is vanguard_dynamic).
  const vdsStatistics = distributionStrategy === 'vanguard_dynamic'
    ? computeVDSStatistics(allVdsEvents, N, Y)
    : null;

  // Year-1 withdrawal — median nominal across sims (will all be very close since year 1 has minimal randomness beyond inflation).
  const year1Values = [];
  for (let s = 0; s < N; s++) year1Values.push(withdrawalByYear[s * Y]);
  const year1MedianNominal = percentileOf(year1Values, 50, 'asc');

  // Year-1 effective withdrawal rate — median across sims.
  const year1RatesArr = Array.from(initialWithdrawalRates);
  const year1MedianRate = percentileOf(year1RatesArr, 50, 'asc');

  // Floor-binding-year percentiles (only when minimum floor active).
  let floorBindingPercentiles = null;
  if (floorBindingCounts) {
    const counts = Array.from(floorBindingCounts);
    floorBindingPercentiles = {
      p10: percentileOf(counts, 10, 'asc'),
      p25: percentileOf(counts, 25, 'asc'),
      p50: percentileOf(counts, 50, 'asc'),
      p75: percentileOf(counts, 75, 'asc'),
      p90: percentileOf(counts, 90, 'asc'),
    };
  }

  return {
    inputs_summary,
    percentile_paths,
    statistics,
    success_metrics,
    results_table,
    diagnostics,
    // --- Distribution strategy outputs
    distribution_strategy: distributionStrategy,
    year1_withdrawal_nominal: year1MedianNominal,
    year1_withdrawal_rate_pct: year1MedianRate,
    minimum_withdrawal_annual: minimumWithdrawalAnnual,
    income_percentile_paths: {
      p10: incomeNominalPaths.p10, p25: incomeNominalPaths.p25, p50: incomeNominalPaths.p50,
      p75: incomeNominalPaths.p75, p90: incomeNominalPaths.p90,
      real_p10: incomeRealPaths.p10, real_p25: incomeRealPaths.p25, real_p50: incomeRealPaths.p50,
      real_p75: incomeRealPaths.p75, real_p90: incomeRealPaths.p90,
    },
    gk_statistics: gkStatistics,
    vds_statistics: vdsStatistics,
    floor_binding_percentiles: floorBindingPercentiles,
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

/* -----------------------------------------------------------
   Distribution Strategy helpers (v1.1 + v1.2)
   ----------------------------------------------------------- */
function computeMedianInflationIndexPath(cumInflationIdx, N, Y) {
  // For each year y, return the median (across sims) of the cumulative inflation
  // index at end of that year. Used to deflate nominal income paths.
  const out = new Array(Y).fill(1);
  for (let y = 0; y < Y; y++) {
    const col = new Array(N);
    for (let s = 0; s < N; s++) col[s] = cumInflationIdx[s * Y + y];
    col.sort((a, b) => a - b);
    out[y] = col[Math.floor(N / 2)] || 1;
  }
  return out;
}

function computeIncomePercentilePaths(withdrawalByYear, N, Y) {
  // Per-year independent percentiles: for each year y, sort all N withdrawal
  // values and pick at p10/p25/p50/p75/p90 indices. Matches the methodology used
  // for the income fan chart in the Income Variability Report.
  const result = { p10: new Array(Y), p25: new Array(Y), p50: new Array(Y), p75: new Array(Y), p90: new Array(Y) };
  const col = new Array(N);
  const percentiles = [10, 25, 50, 75, 90];
  const keys = ['p10', 'p25', 'p50', 'p75', 'p90'];
  for (let y = 0; y < Y; y++) {
    for (let s = 0; s < N; s++) col[s] = withdrawalByYear[s * Y + y];
    const sorted = col.slice().sort((a, b) => a - b);
    for (let i = 0; i < percentiles.length; i++) {
      const idx = Math.min(N - 1, Math.floor((percentiles[i] / 100) * N));
      result[keys[i]][y] = sorted[idx];
    }
  }
  return result;
}

function computeGKStatistics(allGkEvents, N, Y) {
  if (!allGkEvents || allGkEvents.length === 0) return null;
  let simsWithCut = 0;
  let simsWithRaise = 0;
  const cutsPerSim   = new Array(N);
  const raisesPerSim = new Array(N);
  const firstCutYears = [];
  const pctCutsByYear   = new Array(Y).fill(0);
  const pctRaisesByYear = new Array(Y).fill(0);

  for (let s = 0; s < N; s++) {
    const events = allGkEvents[s] || [];
    let cuts = 0, raises = 0, firstCut = null;
    const seenCutYears = new Set();
    const seenRaiseYears = new Set();
    for (const ev of events) {
      if (ev.type === 'upper') {
        cuts++;
        if (firstCut == null) firstCut = ev.year;
        if (!seenCutYears.has(ev.year)) { seenCutYears.add(ev.year); pctCutsByYear[ev.year - 1] += 1; }
      } else if (ev.type === 'lower') {
        raises++;
        if (!seenRaiseYears.has(ev.year)) { seenRaiseYears.add(ev.year); pctRaisesByYear[ev.year - 1] += 1; }
      }
    }
    cutsPerSim[s]   = cuts;
    raisesPerSim[s] = raises;
    if (cuts   > 0) simsWithCut++;
    if (raises > 0) simsWithRaise++;
    if (firstCut != null) firstCutYears.push(firstCut);
  }

  // Normalize per-year hits to percentages of all sims.
  for (let y = 0; y < Y; y++) {
    pctCutsByYear[y]   = (pctCutsByYear[y]   / N) * 100;
    pctRaisesByYear[y] = (pctRaisesByYear[y] / N) * 100;
  }

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const median = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  return {
    pct_sims_with_any_cut:   (simsWithCut   / N) * 100,
    pct_sims_with_any_raise: (simsWithRaise / N) * 100,
    avg_cuts_per_sim:        avg(Array.from(cutsPerSim)),
    avg_raises_per_sim:      avg(Array.from(raisesPerSim)),
    avg_year_of_first_cut:    firstCutYears.length ? avg(firstCutYears)    : null,
    median_year_of_first_cut: firstCutYears.length ? median(firstCutYears) : null,
    pct_cuts_by_year:   pctCutsByYear,
    pct_raises_by_year: pctRaisesByYear,
  };
}

function computeVDSStatistics(allVdsEvents, N, Y) {
  if (!allVdsEvents || allVdsEvents.length === 0) return null;
  let simsWithFloor   = 0;
  let simsWithCeiling = 0;
  const floorPerSim   = new Array(N);
  const ceilingPerSim = new Array(N);
  const pctFloorByYear   = new Array(Y).fill(0);
  const pctCeilingByYear = new Array(Y).fill(0);

  for (let s = 0; s < N; s++) {
    const events = allVdsEvents[s] || [];
    let floors = 0, ceilings = 0;
    const seenFloorYears   = new Set();
    const seenCeilingYears = new Set();
    for (const ev of events) {
      if (ev.type === 'floor') {
        floors++;
        if (!seenFloorYears.has(ev.year))   { seenFloorYears.add(ev.year);   pctFloorByYear[ev.year - 1]   += 1; }
      } else if (ev.type === 'ceiling') {
        ceilings++;
        if (!seenCeilingYears.has(ev.year)) { seenCeilingYears.add(ev.year); pctCeilingByYear[ev.year - 1] += 1; }
      }
    }
    floorPerSim[s]   = floors;
    ceilingPerSim[s] = ceilings;
    if (floors   > 0) simsWithFloor++;
    if (ceilings > 0) simsWithCeiling++;
  }

  for (let y = 0; y < Y; y++) {
    pctFloorByYear[y]   = (pctFloorByYear[y]   / N) * 100;
    pctCeilingByYear[y] = (pctCeilingByYear[y] / N) * 100;
  }

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  return {
    // "floor" = the year-over-year floor cap activated (proposed real fell below
    //           prior_real × (1 − floor%)), i.e. spending would have dropped
    //           more than the floor allows.
    // "ceiling" = the year-over-year ceiling cap activated (proposed real
    //             exceeded prior_real × (1 + ceiling%)), i.e. spending would
    //             have risen more than the ceiling allows.
    pct_sims_with_any_floor:   (simsWithFloor   / N) * 100,
    pct_sims_with_any_ceiling: (simsWithCeiling / N) * 100,
    avg_floors_per_sim:        avg(Array.from(floorPerSim)),
    avg_ceilings_per_sim:      avg(Array.from(ceilingPerSim)),
    pct_floor_by_year:   pctFloorByYear,
    pct_ceiling_by_year: pctCeilingByYear,
  };
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
