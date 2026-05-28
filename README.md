# Through the Noise — Monte Carlo Portfolio Simulator

A browser-based retirement portfolio simulator built for the
[Through the Noise](https://www.youtube.com/) personal-finance YouTube channel.
Runs 10,000 bootstrapped historical scenarios in a Web Worker, presents the
results as fan charts, success-rate cards, percentile tables, and an income
variability report.

**Live site**: <https://ttn-monte-carlo-simulator.onrender.com>

---

## What it does

Given a portfolio, an expense schedule, and a withdrawal strategy, the
simulator estimates the probability that your plan survives a 5–60-year
retirement horizon — without depleting the portfolio — using bootstrap
sampling from 1871–2025 historical returns and inflation.

**Inputs**
- Asset allocation across 22 asset classes (US equity, international,
  fixed income, alternatives)
- Starting balance, current age, simulation length
- Multi-bucket expense schedule (in today's dollars)
- Social Security, pension, and annuity income streams
- Sequence-of-returns stress mode (default-off, optional 2008 force)

**Withdrawal strategies**
- **None** — honor your expense schedule literally
- **Constant Dollar** — Bengen's 4% rule
- **Forgo Inflation Adjustment** — T. Rowe Price method
- **Actual Spending Decline** — EBRI / Blanchett research-backed declining curve
- **Guyton-Klinger Guardrails** — classic carry-forward with bucket-transition rebasing
- **Vanguard Dynamic Spending** — real-dollar year-over-year caps

**Outputs**
- Portfolio Success Rate (with depletion stats for failing sims)
- Projected Portfolio Balance fan chart (per-year percentile bands)
- Projected Annual Spending fan chart
- Income Variability Report (per-strategy callouts, guardrail/cap heatmap)
- Section 6.4 results table (per-metric independent percentile ranking)
- One-page PDF report and CSV export for any scenario

---

## Data

Historical returns and inflation pulled from the
[Bogleheads Simba Backtesting Spreadsheet](https://www.bogleheads.org/wiki/Simba%27s_backtesting_spreadsheet).
The repo's `simba_returns_data.json` is a derivative of that public dataset.

The Modern Era window (default) is 1972–2025 to match
[Portfolio Optimizer](https://www.portfoliooptimizer.io/)'s convention. The
full window covers 1871–2025 per the Simba dataset. Custom date ranges are
supported.

---

## Architecture

- **Static site, no build step.** Three source files plus the data JSON.
- **Web Worker** (`simulation.worker.js`) runs the bootstrap engine off the
  main thread. Posts progress messages and a final aggregated `results`
  payload back to the page.
- **Chart.js** for the fan charts and guardrail/cap heatmap.
- **jsPDF** for the client-side PDF export — no `window.print()` dependency,
  works in any browser without invoking the system print dialog.

### File layout

```
index.html              — markup + section structure
app.js                  — input panel, results rendering, export, modals
simulation.worker.js    — bootstrap simulation engine (pure JS)
styles.css              — brand-aligned styles (Editorial palette)
simba_returns_data.json — historical returns + inflation data
ttn-logo.svg            — channel mark
```

### Brand identity

The visual language follows the
[Through the Noise brand kit](https://github.com/) (Editorial palette by
default — paper, ink, navy, gold, teal, clay), using Instrument Serif for
display copy and IBM Plex Sans for body / data.

---

## Running locally

The site is fully static. Any HTTP server pointed at the project root works:

**Option A — PowerShell HttpListener** (Windows, included in this repo)
```
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/serve.ps1
```
Then open <http://localhost:8765/>.

**Option B — Python**
```
python -m http.server 8000
```

**Option C — Node**
```
npx serve .
```

> The Web Worker requires the site to be served over `http://` or `https://`,
> not `file://`. Opening `index.html` directly in a browser will fail to load
> the simulation worker.

---

## Disclaimer

This tool is provided for educational and informational purposes only and
does not constitute financial, investment, tax, legal, or accounting advice.
All results are hypothetical and based on user inputs, assumptions, and
historical data. Past performance is not indicative of future results. See
the in-app "Terms of Use" link for full text.

---

## License

MIT — see `LICENSE`.
