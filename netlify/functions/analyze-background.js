// netlify/functions/analyze-background.js
// Runs the deterministic rules engine (ratios, flags, pillar scoring) and then
// calls Claude for the diagnosis/advise narrative — matching the framework's
// separation of Analysis Engine (rules = your IP) from the AI narrative layer.
// Background function (see the exports.handler comment below) — the Claude
// call alone routinely takes ~20s, which left too little margin under a
// synchronous function's 10-30s limit.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { syncFinancialRiskItems } = require('./lib/financial-risk-sync');
const { getAllActiveQuestions } = require('./lib/business-risk-questionnaire');
const { OWNER_EXIT_READINESS_ITEMS, OWNER_ESTATE_CHECKLIST_ITEMS } = require('./lib/owner-wealth-risk-sync');
const { getOrGenerateGpMarginBenchmark } = require('./lib/gp-margin-benchmark');

// Which pillars are active at each cadence — mirrors the framework's cadence map.
const CADENCE_PILLARS = {
  quarterly: ['profitability', 'cash_flow', 'tax'],
  half_yearly: ['profitability', 'cash_flow', 'tax', 'growth', 'risk', 'systems_team'],
  annual: ['profitability', 'cash_flow', 'tax', 'growth', 'risk', 'systems_team', 'owner_wealth', 'owner_goals'],
};

function computeRatios(fs) {
  return {
    gp_margin: fs.revenue ? fs.gross_profit / fs.revenue : null,
    np_margin: fs.revenue ? fs.net_profit / fs.revenue : null,
    wages_pct: fs.revenue ? fs.wages / fs.revenue : null,
    debtor_days: fs.revenue ? (fs.debtors / fs.revenue) * 365 : null,
    creditor_days: fs.cogs ? (fs.creditors / fs.cogs) * 365 : null,
    current_ratio: fs.current_liabilities ? fs.current_assets / fs.current_liabilities : null,
    debt_to_equity: fs.equity ? fs.total_debt / fs.equity : null,
  };
}

function computeInventoryDays(fs) {
  return fs.cogs ? (fs.inventory / fs.cogs) * 365 : null;
}

const money = (n) => '$' + Math.round(n).toLocaleString('en-AU');

// Mirrors index.html's formatKpi. Sending Claude a raw ratio (e.g. 0.2156,
// with no unit) and asking it to "state the value plainly" leaves it to guess
// whether/how to convert — multiply by 100? round to what? days or a ratio's
// "x" suffix? That guesswork is exactly how a KPI's interpretation text ends
// up quoting a different number than the card itself shows. Pre-formatting
// here removes the arithmetic from the model's job entirely — it only ever
// echoes a string we've already computed exactly.
function formatKpiValue(value, format) {
  if (value == null || !isFinite(value)) return null;
  if (format === 'percent') return (value * 100).toFixed(1) + '%';
  if (format === 'days') return value.toFixed(0) + 'd';
  if (format === 'ratio') return value.toFixed(2) + 'x';
  if (format === 'money') return money(value);
  return value.toFixed(2);
}

// Phase 1 of the financial risk framework: deterministic, signal -> risk-category
// detection (no AI judgment involved — these are the "🔴 Detected" risks, the
// ones the numbers themselves can prove). Business risks (people/customers/
// suppliers/ops/legal/tech) and industry-specific checklists are a separate,
// later phase — the numbers alone can't answer those, they need a human asking
// questions. Customer concentration is skipped entirely: nothing in this app
// captures per-customer revenue, so there's no signal to detect it from.
function runFlags(fs, priorFs, ratios, priorRatios) {
  const flags = [];

  if (ratios.debtor_days != null && priorRatios?.debtor_days != null && ratios.debtor_days > priorRatios.debtor_days + 5) {
    const extraDays = ratios.debtor_days - priorRatios.debtor_days;
    const dailyRevenue = fs.revenue ? fs.revenue / 365 : null;
    flags.push({
      pillar: 'cash_flow', severity: 'warning', risk_category: 'Cash-flow risk',
      message: `Debtor days increased from ${priorRatios.debtor_days.toFixed(0)} to ${ratios.debtor_days.toFixed(0)}.`,
      impact_estimate: dailyRevenue != null ? `Estimated additional cash tied up: ${money(extraDays * dailyRevenue)}` : null,
    });
  }

  if (ratios.gp_margin != null && priorRatios?.gp_margin != null && ratios.gp_margin < priorRatios.gp_margin - 0.03) {
    flags.push({ pillar: 'profitability', severity: 'warning', risk_category: 'Pricing/cost pressure', message: 'Gross margin dropped 3+ points — check pricing, labour, materials, waste.', impact_estimate: null });
  }

  if (ratios.debt_to_equity != null && priorRatios?.debt_to_equity != null && ratios.debt_to_equity > priorRatios.debt_to_equity * 1.2) {
    flags.push({ pillar: 'cash_flow', severity: 'warning', risk_category: 'Leverage risk', message: `Debt/equity rose from ${priorRatios.debt_to_equity.toFixed(2)}x to ${ratios.debt_to_equity.toFixed(2)}x.`, impact_estimate: null });
  }

  if (ratios.current_ratio != null && ratios.current_ratio < 1) {
    flags.push({ pillar: 'cash_flow', severity: 'danger', risk_category: 'Liquidity risk', message: 'Current ratio below 1 — short-term liabilities exceed short-term assets.', impact_estimate: null });
  }
  if (fs.cash != null && priorFs?.cash != null && fs.cash < priorFs.cash * 0.8) {
    flags.push({ pillar: 'cash_flow', severity: 'warning', risk_category: 'Liquidity risk', message: `Cash balance fell from ${money(priorFs.cash)} to ${money(fs.cash)}.`, impact_estimate: null });
  }

  if (fs.revenue != null && priorFs?.revenue != null && fs.revenue < priorFs.revenue * 0.9) {
    flags.push({ pillar: 'growth', severity: 'warning', risk_category: 'Trading risk', message: `Revenue down ${Math.round((1 - fs.revenue / priorFs.revenue) * 100)}% versus prior period.`, impact_estimate: null });
  }

  if (ratios.wages_pct != null && priorRatios?.wages_pct != null && ratios.wages_pct > priorRatios.wages_pct + 0.03) {
    flags.push({ pillar: 'profitability', severity: 'warning', risk_category: 'Cost structure pressure', message: 'Wages as % of sales rose 3+ points.', impact_estimate: null });
  }

  if (fs.interest_expense != null && priorFs?.interest_expense != null && fs.interest_expense > priorFs.interest_expense * 1.2) {
    flags.push({ pillar: 'cash_flow', severity: 'warning', risk_category: 'Debt servicing risk', message: `Interest expense rose from ${money(priorFs.interest_expense)} to ${money(fs.interest_expense)}.`, impact_estimate: null });
  }

  const invDays = computeInventoryDays(fs);
  const priorInvDays = priorFs ? computeInventoryDays(priorFs) : null;
  if (invDays != null && priorInvDays != null && invDays > priorInvDays + 5) {
    flags.push({ pillar: 'cash_flow', severity: 'warning', risk_category: 'Stock/cash risk', message: `Inventory days rose from ${priorInvDays.toFixed(0)} to ${invDays.toFixed(0)}.`, impact_estimate: null });
  }

  // Rate-based, not dollar-based — a dollar rise can just mean profit grew.
  // What actually signals something worth asking about is the RATE moving,
  // independent of how much profit changed.
  const etr = (fs.net_profit > 0 && fs.tax_expense != null) ? fs.tax_expense / fs.net_profit : null;
  const priorEtr = (priorFs?.net_profit > 0 && priorFs?.tax_expense != null) ? priorFs.tax_expense / priorFs.net_profit : null;
  if (etr != null && priorEtr != null && Math.abs(etr - priorEtr) > 0.08) {
    const direction = etr > priorEtr ? 'rose' : 'fell';
    flags.push({
      pillar: 'tax', severity: 'warning', risk_category: 'Tax rate shift',
      message: `Effective tax rate ${direction} from ${(priorEtr * 100).toFixed(0)}% to ${(etr * 100).toFixed(0)}% (profit ${money(priorFs.net_profit)} → ${money(fs.net_profit)}, tax ${money(priorFs.tax_expense)} → ${money(fs.tax_expense)}).`,
      impact_estimate: null,
    });
  }

  // Simple affordability check — deliberately just income tax vs cash on hand,
  // not a full GST/PAYG/super/FBT obligations forecast (out of scope for now).
  if (fs.tax_expense > 0 && fs.cash != null) {
    if (fs.tax_expense > fs.cash) {
      flags.push({ pillar: 'tax', severity: 'danger', risk_category: 'Tax affordability risk', message: `Tax expense (${money(fs.tax_expense)}) exceeds cash on hand (${money(fs.cash)}) — funding this may be a stretch.`, impact_estimate: null });
    } else if (fs.tax_expense > fs.cash * 0.5) {
      flags.push({ pillar: 'tax', severity: 'warning', risk_category: 'Tax affordability risk', message: `Tax expense (${money(fs.tax_expense)}) is over half of cash on hand (${money(fs.cash)}) — worth planning for the outflow.`, impact_estimate: null });
    }
  }

  return flags;
}

// Risk pillar score — starts at 10, docked per open risk, weighted by
// severity. Two sources, since risk_items isn't fully populated yet at
// this point in the handler: financial's flags come straight from
// runFlags() (in-memory, this period's fresh signals — risk_items'
// financial rows haven't been written yet, see syncFinancialRiskItems
// below), business/industry come from a risk_items query the caller
// fetches up front. Only ACTIVE-status business/industry rows count —
// Managed/Not applicable are resolved, they shouldn't keep dragging the
// score down. -2 for a high-severity open risk, -1 for medium, floored at
// 0 rather than allowed to go negative for a client with a long risk list.
// Deliberately not saved anywhere new — same 0-10 range the other pillars
// already use, read straight off risk_items/flags each time analysis runs
// so it can't drift out of sync with what Risk Review is actually showing.
const RISK_ACTIVE_STATUSES_FOR_SCORE = new Set(['Detected', 'Identified', 'Watch', 'Unknown']);

// Mirrors index.html's dedupeBusinessToLatestPerCategory — a business
// category answered in 2025 and reviewed again in 2026 leaves BOTH years'
// rows on file as history (submitQuestionAnswer only clears the period
// being saved), so counting every row without this would double-count a
// risk that's since been re-reviewed and resolved. Industry doesn't need
// it — those rows are written once and never re-generated per period.
function dedupeBusinessToLatestPerCategory(rows) {
  const latestPeriodByCategory = {};
  rows.forEach((r) => {
    if (!latestPeriodByCategory[r.category] || r.period_end > latestPeriodByCategory[r.category]) {
      latestPeriodByCategory[r.category] = r.period_end;
    }
  });
  return rows.filter((r) => r.period_end === latestPeriodByCategory[r.category]);
}

function scoreRiskPillar(flags, riskItems) {
  const business = dedupeBusinessToLatestPerCategory((riskItems || []).filter((r) => r.source === 'business'));
  const industry = (riskItems || []).filter((r) => r.source === 'industry');

  let score = 10;
  (flags || []).forEach((f) => {
    score -= (f.severity || '').toLowerCase() === 'danger' ? 2 : 1;
  });
  [...business, ...industry]
    .filter((r) => RISK_ACTIVE_STATUSES_FOR_SCORE.has(r.status))
    .forEach((r) => {
      score -= r.severity === 'High' ? 2 : r.severity === 'Medium' ? 1 : 0.5;
    });
  return Math.max(0, Math.round(score * 10) / 10);
}

// posture (Goals → Profile → CLIENT_POSTURES in index.html) is genuinely
// used here, not decorative — a client on "Consolidate" or "Hold wealth"
// has explicitly said flat revenue IS the goal, so the default
// growth-maximizing bands (which score flat as merely neutral, and only
// reward active growth) would be scoring this business against an
// objective the owner never asked for. Shrinking is still scored down
// either way — "hold steady" isn't the same as "any decline is fine."
function scoreGrowthPillar(fs, priorFs, posture) {
  if (!priorFs?.revenue) return null; // not scored — no prior period to compare against
  const growthRate = (fs.revenue - priorFs.revenue) / priorFs.revenue;
  const wantsSteady = posture === 'consolidate' || posture === 'hold_wealth';
  let score;
  if (wantsSteady) {
    if (growthRate >= -0.05 && growthRate <= 0.05) score = 9; // flat is the actual goal here
    else if (growthRate < -0.05 && growthRate >= -0.15) score = 6;
    else if (growthRate < -0.15) score = 3; // still bad — "hold steady" isn't "any decline is fine"
    else score = 6; // growing faster than intended isn't bad, just not the point — neutral rather than penalized
  } else {
    if (growthRate >= 0.10) score = 9;
    else if (growthRate >= 0.03) score = 7;
    else if (growthRate >= -0.03) score = 6;
    else if (growthRate >= -0.10) score = 4;
    else score = 2;
  }
  return Math.max(0, Math.min(10, score));
}

// Same question-matching logic as index.html's findBusinessQuestionAnswer
// and owner-wealth-risk-sync.js's applicability checks — duplicated here
// rather than shared, same "per-file independence" convention this domain
// already uses, since this runs server-side in the analysis engine, not
// the browser.
function findBusinessAnswer(questionText, businessRows, allQuestions) {
  const question = (allQuestions || []).find((q) => q.question_text === questionText);
  if (!question) return { answered: false };
  const rows = (businessRows || [])
    .filter((r) => r.question_id === question.id)
    .sort((a, b) => (b.last_reviewed_date || '').localeCompare(a.last_reviewed_date || ''));
  if (!rows.length) return { answered: false };
  return { answered: true, riskPresent: rows[0].status === 'Identified' || rows[0].status === 'Watch' };
}

function exitReadinessSignalScore(questionText, businessRows, allQuestions) {
  const { answered, riskPresent } = findBusinessAnswer(questionText, businessRows, allQuestions);
  if (!answered) return null;
  return riskPresent ? 0 : 10;
}

function exitReadinessChecklistScore(status) {
  if (status === 'yes') return 10;
  if (status === 'partial') return 5;
  if (status === 'no') return 0;
  return null;
}

// Mirrors index.html's computeExitReadinessScore (10 factors: 4 reused
// Business Risk Q answers + profitability + the 5 exit readiness
// checklist items) but only needs the overall number here, not the
// per-factor breakdown the card shows — kept in sync by eye, same
// duplication convention as findBusinessAnswer above.
function computeExitReadinessOverall(exitReadinessChecklist, businessRows, allQuestions, profitabilityScore) {
  const byKey = Object.fromEntries((exitReadinessChecklist || []).map((it) => [it.key, it]));
  const scores = [
    exitReadinessSignalScore('Is the business heavily dependent on the owner?', businessRows, allQuestions),
    exitReadinessSignalScore('Is there a key employee the business couldn\'t easily replace?', businessRows, allQuestions),
    exitReadinessSignalScore('Is a significant amount of revenue dependent on one customer?', businessRows, allQuestions),
    exitReadinessSignalScore('Are critical processes documented?', businessRows, allQuestions),
    profitabilityScore != null ? profitabilityScore : null,
    ...Object.keys(OWNER_EXIT_READINESS_ITEMS).map((key) => exitReadinessChecklistScore(byKey[key]?.status)),
  ];
  const assessed = scores.filter((s) => s != null);
  return assessed.length ? Math.round((assessed.reduce((sum, s) => sum + s, 0) / assessed.length) * 10) : null;
}

// Mirrors index.html's ownerEstateItemApplicability — buy-sell agreement
// and key-person insurance only count as a real gap when there's actually
// a co-owner for them to apply to.
function ownerEstateItemApplicable(key, entityType) {
  if (key !== 'buy_sell_agreement' && key !== 'key_person_insurance') return true;
  if (entityType === 'Sole trader') return false;
  return true; // Partnership, or ambiguous (Company/Trust/Other/unset) — same "don't guess it away" treatment as the frontend's gap-counting
}

// A single 0-10 number for the Business Health wheel, not a narrative —
// Exit Readiness's own /100 score is the base (already the most complete
// signal this domain produces), with up to 2 points off for estate
// document gaps (will/EPOA/etc — a personal-protection risk Exit
// Readiness's factor set doesn't cover, since that's about business value
// specifically). Retirement Outlook is deliberately NOT folded in — its
// inputs (desired income, growth assumptions) are session-only UI state on
// the Owner & Succession card, never persisted, so there's nothing here to
// read. Nothing assessed yet returns null (not scored — see scorePillar)
// rather than treating silence as either a penalty or a pass.
function scoreOwnerWealthPillar(ownerWealth) {
  const { exitReadinessOverall, estateGapCount, estateApplicableCount } = ownerWealth || {};
  if (exitReadinessOverall == null) return null;
  let score = exitReadinessOverall / 10;
  if (estateApplicableCount > 0) score -= (estateGapCount / estateApplicableCount) * 2;
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

// ---- Tax pillar scoring ----
// Compares the client's actual effective tax rate (tax_expense / net_profit,
// both self-reported per snapshot) against what's standard for their entity
// type, rather than the flat 8 this used to return unconditionally. Two
// things a naive rate comparison would get wrong on its own:
//
// 1. A loss year produces a low/zero rate too, for an entirely different
//    reason (no taxable income, not good planning) — Profitability already
//    scores the loss itself, so Tax stays neutral rather than double-
//    counting or misreading the loss as tax efficiency.
// 2. tax_expense/net_profit are captured PER SNAPSHOT — only meaningful as
//    an annual rate, not a lone quarter's (one quarter can carry a lumpy
//    one-off tax item). So this only computes a fresh score once a full
//    financial year's worth of periods is on file for a quarterly/half-
//    yearly client — at the period landing on the fy_end anniversary — and
//    simply carries the last completed year's score forward for the
//    quarters in between. Same "tax is fundamentally annual" spirit
//    CADENCE_PILLARS already applies to owner_wealth/owner_goals, just as
//    carry-forward instead of exclusion, since Tax is meant to be visible
//    at every cadence per that same map.
//
// Flow-through entities (Sole trader/Partnership/Trust) pay no tax at the
// ENTITY level by design — profit is taxed in the owners'/partners'/
// beneficiaries' own hands, so entity-level tax_expense being null or $0 is
// the CORRECT, expected outcome, not a data gap and not remarkable either
// way. Comparing it against a standard rate (as this used to for Sole
// trader, and not at all for Partnership/Trust, which just returned a flat
// 8) was answering the wrong question. What's actually worth surfacing for
// these three is structural: how much marginal-rate exposure this profit
// level would carry if it landed in ONE individual's hands. That's a
// conservative, worst-case proxy — the real partner/beneficiary count and
// their other income isn't tracked anywhere server-side, only ephemeral,
// adviser-typed browser state on the Current tax position card (see
// index.html's taxPositionCompareState) — but high concentrated exposure is
// exactly what makes income-splitting or a different structure worth a
// conversation, and low exposure means the current one is already fine.
const PERIODS_PER_YEAR = { quarterly: 4, half_yearly: 2, annual: 1 };
const COMPANY_TAX_RATE = 0.25; // base rate entity default — overridden per-client by profile_extra.company_tax_rate when set (see index.html's matching Profile field)
// FY2026-27 resident individual brackets + flat 2% Medicare levy — same
// figures and same "starting point, not a guarantee" caveat as index.html's
// DEFAULT_TAX_RATES/estimateIndividualTax. Duplicated here rather than
// shared, per this codebase's established per-file-independence convention
// (see findKpiTarget's own comment above) — this runs server-side with no
// access to the client-side, session-editable taxRatesState anyway, and an
// objective score needs a fixed baseline rather than whatever an adviser
// happens to have typed into a scenario tool mid-meeting.
const INDIVIDUAL_TAX_BANDS = [[18200, 0], [45000, 15], [135000, 30], [190000, 37], [Infinity, 45]];
const MEDICARE_RATE = 0.02;
const MEDICARE_THRESHOLD = 24276;

function estimateIndividualEffectiveRate(income) {
  if (income <= 0) return 0;
  let tax = 0, lower = 0;
  for (const [upper, ratePct] of INDIVIDUAL_TAX_BANDS) {
    if (income <= lower) break;
    tax += (Math.min(income, upper) - lower) * (ratePct / 100);
    lower = upper;
  }
  if (income > MEDICARE_THRESHOLD) tax += income * MEDICARE_RATE;
  return tax / income;
}

// Combined tax across however many partners/beneficiaries were actually
// entered and SAVED on the Current tax position card (financial_snapshots.
// tax_structure_split — see migration_tax_structure_split.sql), instead of
// scoreTaxFromAnnualFigures' own "assume one taxpayer" fallback. Mirrors
// index.html's estimateTaxForEntity/renderTaxPositionEstimateTiles math
// (duplicated rather than shared, per this file's own established per-file-
// independence convention above) — share is a literal % of the pool (5
// means 5%, not "100% of whatever else was entered"), otherIncome stacks on
// top of that person's share via the same incremental-tax-effect formula,
// profitAdjustment shifts the whole pool before it's split. Returns null
// when there's nothing usable saved (Sole trader always has an implicit
// 100% share; Partnership/Trust need at least one real share entered).
function computeTaxFromSavedSplit(entityType, pool, split) {
  if (!split) return null;
  const isSolo = entityType === 'Sole trader';
  const rawShares = isSolo ? [100] : (split.shares || []).map(Number);
  const validIdx = rawShares.map((v, i) => (!isNaN(v) && v > 0 ? i : -1)).filter((i) => i >= 0);
  if (!validIdx.length) return null;
  const rawOther = split.otherIncome || [];
  const adjustedPool = pool + (Number(split.profitAdjustment) || 0);
  let total = 0;
  validIdx.forEach((i) => {
    const amt = adjustedPool * (rawShares[i] / 100);
    const other = Number(rawOther[i]) || 0;
    total += other !== 0
      ? (amt + other) * estimateIndividualEffectiveRate(amt + other) - other * estimateIndividualEffectiveRate(other)
      : amt * estimateIndividualEffectiveRate(amt);
  });
  return total;
}

// Quarterly/half-yearly periods walk in fixed steps from fy_end's month/day
// (see index.html's generatePeriodOptions) — always landing on the same
// month+day each cycle — so comparing just month+day (ignoring year)
// reliably identifies the one period per year that completes a financial
// year, without needing to know every other period the client has.
function isFyEndPeriod(periodEnd, fyEnd, cadence) {
  if (cadence === 'annual') return true; // one period IS one year already
  if (!fyEnd) return true; // can't place the year boundary — compute fresh rather than never
  const p = new Date(periodEnd + 'T00:00:00Z');
  const f = new Date(fyEnd + 'T00:00:00Z');
  return p.getUTCMonth() === f.getUTCMonth() && p.getUTCDate() === f.getUTCDate();
}

function scoreTaxFromAnnualFigures(entityType, annualNetProfit, annualTaxExpense, companyTaxRate, taxStructureSplit) {
  if (annualNetProfit == null) return null;
  if (annualNetProfit <= 0) return 6; // loss year — not a tax-planning signal either way

  if (entityType === 'Sole trader' || entityType === 'Partnership' || entityType === 'Trust') {
    // No entity-level tax to compare against for these (see the block
    // comment above). If the adviser has actually SAVED a split on the
    // Current tax position card, use the real combined rate across however
    // many people it describes — otherwise fall back to the concentrated-
    // in-one-person rate as a conservative, worst-case reference point.
    const savedTax = computeTaxFromSavedSplit(entityType, annualNetProfit, taxStructureSplit);
    const effectiveRate = savedTax != null ? savedTax / annualNetProfit : estimateIndividualEffectiveRate(annualNetProfit);
    if (effectiveRate <= 0.19) return 9; // in/near the lowest brackets — plenty of headroom, no pressure to change structure
    if (effectiveRate <= 0.30) return 7; // moderate — roughly company-rate territory, worth a periodic check
    if (effectiveRate <= 0.37) return 5; // meaningfully above company rate if concentrated — splitting income or a different structure may help
    return 3; // high marginal exposure — worth a real conversation about structure/splitting
  }

  if (annualTaxExpense == null) return null;
  const standardRate = (typeof companyTaxRate === 'number' && companyTaxRate > 0) ? companyTaxRate : COMPANY_TAX_RATE;
  const diff = (annualTaxExpense / annualNetProfit) - standardRate;
  if (diff <= -0.05) return 9; // comfortably below standard — efficient (e.g. genuine deductions like super contributions)
  if (diff <= 0.03) return 7; // roughly in line
  if (diff <= 0.08) return 5; // somewhat above standard — worth a look
  return 3; // notably above standard — real inefficiency or a data/timing issue
}

async function computeTaxPillarScore(supabase, { clientId, periodEnd, cadence, fyEnd, entityType, fs, companyTaxRate }) {
  const periodsPerYear = PERIODS_PER_YEAR[cadence] || 4;

  if (!isFyEndPeriod(periodEnd, fyEnd, cadence)) {
    // Mid-year — carry forward the immediately prior period's tax score
    // rather than reading a lone quarter's rate as this year's verdict.
    // Chains correctly across quarters since each one just inherits what
    // the last one held (itself either freshly computed at the prior
    // fy-end or also carried forward).
    const { data: priorScore } = await supabase
      .from('pillar_scores').select('score')
      .eq('client_id', clientId).eq('pillar', 'tax').lt('period_end', periodEnd)
      .order('period_end', { ascending: false }).limit(1).maybeSingle();
    if (priorScore?.score != null) return priorScore.score;
    // No tax score on file at all yet (this client's very first analysis
    // run) — fall through and score off just this one period, best-effort,
    // rather than showing nothing until a full year exists.
  }

  // fs.tax_structure_split is THIS period's saved split, used either way
  // below as the best available (and only) one on file — a quarterly/half-
  // yearly client's split is assumed roughly stable across the year rather
  // than tracked per-quarter, same simplification as most of this scoring
  // already makes.
  if (periodsPerYear === 1) return scoreTaxFromAnnualFigures(entityType, fs.net_profit, fs.tax_expense, companyTaxRate, fs.tax_structure_split);

  const { data: trailing } = await supabase
    .from('financial_snapshots').select('net_profit, tax_expense')
    .eq('client_id', clientId).lte('period_end', periodEnd)
    .order('period_end', { ascending: false }).limit(periodsPerYear);
  const rows = trailing || [];
  if (rows.length < periodsPerYear) {
    // This IS the fy-end-aligned date, but a full year isn't on file yet
    // (e.g. the client's very first period happens to land on it) — score
    // off what's actually here rather than pretend a full year exists.
    return scoreTaxFromAnnualFigures(entityType, fs.net_profit, fs.tax_expense, companyTaxRate, fs.tax_structure_split);
  }
  const sum = (field) => {
    let total = 0;
    for (const r of rows) {
      if (r[field] == null) return null;
      total += Number(r[field]);
    }
    return total;
  };
  return scoreTaxFromAnnualFigures(entityType, sum('net_profit'), sum('tax_expense'), companyTaxRate, fs.tax_structure_split);
}

// Clamped linear interpolation between a "poor" reference point and a
// "good" one — replaces the old hard 3-band cliffs (a value one hair below
// a threshold used to read wildly differently from one hair above it) with
// a smooth score that actually reflects how far into good/bad territory a
// number sits. Works in either direction: pass badPoint > goodPoint for a
// "lower is better" metric (e.g. debtor days) and the interpolation still
// comes out the right way round.
function interpolateScore(value, badPoint, goodPoint, badScore = 1, goodScore = 9.5) {
  if (value == null) return null;
  const t = Math.max(0, Math.min(1, (value - badPoint) / (goodPoint - badPoint)));
  return Math.round((badScore + t * (goodScore - badScore)) * 10) / 10;
}

// Shared qualitative label for any 0-10 pillar/KPI-style score — purely for
// display (index.html mirrors this), so "6.2" reads as "OK" and "8.7" reads
// as "Very good" consistently everywhere a score shows, rather than a bare
// number the reader has to calibrate for themselves each time.
function scoreLabel(score) {
  if (score == null) return null;
  if (score >= 8.5) return 'Very good';
  if (score >= 7) return 'Good';
  if (score >= 5) return 'OK';
  if (score >= 3) return 'Watch';
  return 'Poor';
}

// Net profit margin is the actual "is this business profitable" answer —
// weighted most heavily (0.7). GP margin is a real secondary factor (it's
// where a margin problem usually originates), scored against a "good"
// reference point picked in priority order: the client's own target when
// one is set (findKpiTarget) — "58% target, sitting at 25.7%" is a much
// sharper story than a flat threshold could tell — else the AI-suggested,
// per-industry typical-range benchmark (getOrGenerateGpMarginBenchmark,
// same cache-per-industry pattern as the Growth domain's valuation
// multiple), else a generic 15-45% range as the last resort when the
// client has no industry on file at all for the benchmark call to use.
function scoreProfitabilityPillar(ratios, gpMarginTarget, gpBenchmark) {
  const npScore = interpolateScore(ratios.np_margin, -0.10, 0.20);
  const gpBad = gpBenchmark?.typical_low != null ? gpBenchmark.typical_low : 0.15;
  const gpGood = gpMarginTarget != null ? gpMarginTarget
    : gpBenchmark?.typical_high != null ? gpBenchmark.typical_high
    : 0.45;
  const gpScore = interpolateScore(ratios.gp_margin, gpBad, Math.max(gpGood, gpBad + 0.01));
  if (npScore == null && gpScore == null) return null;
  if (npScore == null) return gpScore;
  if (gpScore == null) return npScore;
  return Math.round((npScore * 0.7 + gpScore * 0.3) * 10) / 10;
}

// Operating cash conversion (this period's actual profit-to-cash
// conversion) is the real "cash flow" answer — current ratio is a
// balance-sheet LIQUIDITY snapshot, not a flow measure, and used to be the
// whole score on its own (a business could be actively bleeding cash every
// period and still score 9/10 here purely on liquidity, which is exactly
// what was happening before this change). ~40% conversion reads as poor,
// ~100% (all profit becoming real cash) as very good. Current ratio
// demotes to a real but secondary liquidity check (0.4 weight) — a
// business converting profit to cash fine period-to-period can still be in
// genuine short-term trouble if current liabilities dwarf current assets.
function scoreCashFlowPillar(ratios, ocfConversion) {
  const conversionScore = interpolateScore(ocfConversion, 0.40, 1.00);
  const liquidityScore = interpolateScore(ratios.current_ratio, 0.8, 2.0);
  if (conversionScore == null && liquidityScore == null) return null;
  if (conversionScore == null) return liquidityScore;
  if (liquidityScore == null) return conversionScore;
  return Math.round((conversionScore * 0.6 + liquidityScore * 0.4) * 10) / 10;
}

// null means "not scored" — no data to score from, or (systems_team,
// owner_goals) no scoring logic yet. Unscored pillars are left out of the
// health score and never persisted, rather than counted as a made-up
// neutral 6: a 6 printed in a client report reads as a real assessment.
function scorePillar(pillar, ratios, riskContext) {
  switch (pillar) {
    case 'profitability': return scoreProfitabilityPillar(ratios, riskContext?.gpMarginTarget, riskContext?.gpBenchmark);
    case 'cash_flow': return scoreCashFlowPillar(ratios, riskContext?.ocfConversion);
    case 'tax': return riskContext?.taxScore ?? null;
    case 'risk': return scoreRiskPillar(riskContext?.flags, riskContext?.riskItems);
    case 'growth': return scoreGrowthPillar(riskContext?.fs, riskContext?.priorFs, riskContext?.posture);
    case 'owner_wealth': return scoreOwnerWealthPillar(riskContext?.ownerWealth);
    default: return null; // systems_team, owner_goals — no scoring logic built yet
  }
}

// ---- KPI engine (mirrors read-data.js's get_kpi_report — kept in sync by
// both reading the same kpi_library data rather than hardcoded formulas) ----
function sumFields(snapshot, fields) {
  if (!snapshot || !fields) return null;
  let total = 0;
  for (const f of fields) {
    const v = snapshot[f];
    if (v === null || v === undefined) return null;
    total += Number(v);
  }
  return total;
}

function computeKpiValue(snapshot, kpi, priorSnapshot) {
  if (kpi.kind === 'growth') {
    const cur = sumFields(snapshot, kpi.numerator);
    const prior = sumFields(priorSnapshot, kpi.numerator);
    return (cur === null || prior === null || prior === 0) ? null : (cur - prior) / prior;
  }
  const num = sumFields(snapshot, kpi.numerator);
  const den = sumFields(snapshot, kpi.denominator);
  if (num === null || den === null || den === 0) return null;
  return kpi.kind === 'days' ? (num / den) * 365 : num / den;
}

// Mirrors index.html's findKpiTarget — searches every period up to the one
// being analyzed, most recent first, across every goal category, for the
// nearest non-done goal item carrying this KPI's target. Duplicated here
// (not shared) per this codebase's per-function-independence pattern.
const BUILTIN_GOAL_CATEGORIES = ['personal', 'business', 'income', 'lifestyle', 'exit_succession'];
function findKpiTarget(ownerGoals, periodEnd, kpiKey) {
  if (!ownerGoals || !periodEnd) return null;
  const periods = ownerGoals.periods || {};
  const categoryKeys = [...BUILTIN_GOAL_CATEGORIES, ...(ownerGoals.custom_categories || []).map((c) => c.key)];
  const candidatePeriods = Object.keys(periods).filter((p) => p <= periodEnd).sort().reverse();
  for (const p of candidatePeriods) {
    for (const catKey of categoryKeys) {
      const items = (periods[p]?.cats?.[catKey]?.items || []).filter((it) => !it.deleted);
      const match = items.find((it) => !it.done && it.kpi_key === kpiKey && it.target != null);
      if (match) return match.target;
    }
  }
  return null;
}

// Standard indirect-method estimate for operating cash flow, used only when
// the field is left blank. Deliberately does NOT include capex, debt
// repayments, owner drawings, or private loans — those are investing/financing
// activities, not operating ones, and folding them in would make this LESS
// accurate, not more (it would stop isolating what the core business
// generates). Needs a prior snapshot for the working-capital deltas.
//
// net_profit is treated as PRE-tax profit throughout this app (see
// FINANCIAL_FIELD_DEFS), so this already excludes tax without any extra term —
// adding back interest brings it in line with EBITDA (kpi_library's
// op_cash_conversion denominator = net_profit + interest + D&A, also pre-tax),
// so numerator and denominator are on the same basis.
function deriveOperatingCashFlow(fs, priorFs) {
  if (fs.operating_cash_flow != null) return { value: fs.operating_cash_flow, derived: false };
  if (!priorFs) return { value: null, derived: false };
  const required = [fs.net_profit, fs.interest_expense, fs.depreciation_amortisation, fs.debtors, fs.creditors, fs.inventory, priorFs.debtors, priorFs.creditors, priorFs.inventory];
  if (required.some((v) => v == null)) return { value: null, derived: false };
  const value = fs.net_profit + fs.interest_expense + fs.depreciation_amortisation
    - (fs.debtors - priorFs.debtors)
    + (fs.creditors - priorFs.creditors)
    - (fs.inventory - priorFs.inventory);
  return { value, derived: true };
}

// Mirrors read-data.js's buildCashReconciliation — see that file for the
// full reasoning (fixed_assets not total_assets-current_assets for capex,
// director_loan_balance kept separate from total_debt, interest only
// subtracted when OCF is derived). Only the pieces the Diagnosis prompt
// actually needs are kept: a plain-text summary of where the period's cash
// came from and went, so Claude can comment on it (e.g. "cash is building up
// with no debt paydown") without a second AI call computing its own version.
function buildCashReconciliation(snap, prior, ocfValue, ocfDerived) {
  if (!prior || snap.cash == null || prior.cash == null || ocfValue == null) return null;
  const deltaCash = snap.cash - prior.cash;
  const deltaFixedAssets = (snap.fixed_assets != null && prior.fixed_assets != null) ? snap.fixed_assets - prior.fixed_assets : null;
  const capexEstimate = (deltaFixedAssets != null && snap.depreciation_amortisation != null) ? deltaFixedAssets + snap.depreciation_amortisation : null;
  const capex = snap.equipment_purchases != null ? snap.equipment_purchases : capexEstimate;
  const deltaDebt = (snap.total_debt != null && prior.total_debt != null) ? snap.total_debt - prior.total_debt : null;
  const interestPaid = (ocfDerived && snap.interest_expense != null) ? snap.interest_expense : null;
  const deltaDirectorLoan = (snap.director_loan_balance != null && prior.director_loan_balance != null) ? snap.director_loan_balance - prior.director_loan_balance : null;
  const fundsIntroduced = snap.funds_introduced != null ? snap.funds_introduced : null;
  const ownerDrawings = snap.owner_drawings != null ? snap.owner_drawings : null;
  const adjustments = Array.isArray(snap.cash_recon_adjustments) ? snap.cash_recon_adjustments : [];
  return { delta_cash: deltaCash, operating_cf: ocfValue, capex, delta_debt: deltaDebt, interest_paid: interestPaid, delta_director_loan: deltaDirectorLoan, funds_introduced: fundsIntroduced, owner_drawings: ownerDrawings, adjustments };
}

// Plain-text, template-driven summary for the Claude prompt — same clause
// selection as index.html's cashStorySentence (skip zero/unentered items),
// just rendered as prose instead of HTML.
function cashStorySummary(r) {
  if (!r) return null;
  const parts = [];
  if (r.operating_cf != null) parts.push(r.operating_cf >= 0 ? `generated ${money(r.operating_cf)} from operations` : `used ${money(Math.abs(r.operating_cf))} in operations`);
  if (r.capex) parts.push(`spent ${money(r.capex)} on equipment/assets`);
  if (r.delta_debt) parts.push(r.delta_debt > 0 ? `borrowed ${money(r.delta_debt)}` : `paid down ${money(Math.abs(r.delta_debt))} of debt`);
  if (r.interest_paid) parts.push(`paid ${money(r.interest_paid)} in interest`);
  if (r.delta_director_loan) parts.push(r.delta_director_loan > 0 ? `director lent ${money(r.delta_director_loan)} to the business` : `repaid ${money(Math.abs(r.delta_director_loan))} to the director`);
  if (r.funds_introduced) parts.push(`owner introduced ${money(r.funds_introduced)}`);
  if (r.owner_drawings) parts.push(`owner drew ${money(r.owner_drawings)}`);
  (r.adjustments || []).forEach((a) => { const amt = Number(a.amount) || 0; if (amt) parts.push(`${a.label || 'item'} ${amt > 0 ? '+' : '-'}${money(Math.abs(amt))}`); });
  if (!parts.length) return null;
  const tail = r.delta_cash > 0 ? `cash grew ${money(r.delta_cash)}` : r.delta_cash < 0 ? `cash fell ${money(Math.abs(r.delta_cash))}` : 'cash flat';
  return parts.join('; ') + '; ' + tail;
}

function computeAllKpis(fs, priorFs, kpiLibrary) {
  return (kpiLibrary || []).map((kpi) => {
    const value = computeKpiValue(fs, kpi, priorFs);
    const priorValue = kpi.kind === 'growth' ? null : computeKpiValue(priorFs, kpi, null);
    const confidence = value === null ? 'red' : (kpi.estimation_note ? 'yellow' : 'green');
    return {
      key: kpi.key, name: kpi.name, format: kpi.format, kind: kpi.kind, category: kpi.category,
      numerator: kpi.numerator, denominator: kpi.denominator,
      value, priorValue, confidence, estimation_note: kpi.estimation_note,
      improvement_tip: kpi.improvement_tip || null,
    };
  });
}

// Background function (the -background filename suffix is what Netlify
// keys off — no config needed): the Claude call alone routinely takes
// ~20s, which left almost no margin under the 10-30s synchronous function
// limit once the surrounding Supabase reads/writes and risk sync are
// added on top — a real, observed failure mode, not a theoretical one.
// Background functions get up to 15 minutes, but the tradeoff is the
// caller gets an immediate empty 202 response with no body — so the
// frontend (index.html's run-analysis-btn handler) can't await a direct
// result the way it used to. It instead polls get_diagnosis until this
// run's 'overall' diagnostics row id changes from the pre-trigger
// baseline, or until this row appears (see 'analysis_error' below).
exports.handler = async (event) => {
  const { client_id, period_end } = JSON.parse(event.body || '{}');
  if (!client_id || !period_end) return { statusCode: 400, body: 'client_id and period_end required' };
  // Clears any stale error marker from a PRIOR failed run before this run
  // starts, so a fresh attempt's poll doesn't misread old failure state as
  // this run's result. Best-effort — if this fails, the worst case is a
  // stale error banner briefly outliving a successful re-run.
  try {
    await supabase.from('diagnostics').delete().eq('client_id', client_id).eq('period_end', period_end).eq('pillar', 'analysis_error');
  } catch (err) {
    console.error('Failed to clear stale analysis_error marker:', err.message);
  }
  try {

    const [{ data: fs }, { data: context }, { data: priorFsList }, kpiLibResult, riskItemsResult, trendHistoryResult, ownerWealthSnapshotResult] = await Promise.all([
      supabase.from('financial_snapshots').select('*').eq('client_id', client_id).eq('period_end', period_end).single(),
      supabase.from('client_context').select('*').eq('client_id', client_id).single(),
      supabase.from('financial_snapshots').select('*').eq('client_id', client_id).lt('period_end', period_end).order('period_end', { ascending: false }).limit(1),
      supabase.from('kpi_library').select('*').eq('active', true).order('sort_order'),
      // Business/industry only — financial's risk_items rows haven't been
      // written for THIS period yet (see syncFinancialRiskItems below), so
      // scoreRiskPillar reads financial straight off the in-memory `flags`
      // computed a few lines down instead of querying for it here.
      // question_id/last_reviewed_date are only needed for the owner_wealth
      // pillar's exit-readiness scoring below (matching a business row back
      // to its question) — scoreRiskPillar itself ignores both.
      supabase.from('risk_items').select('source, category, period_end, status, severity, question_id, last_reviewed_date').eq('client_id', client_id).in('source', ['business', 'industry']),
      // Feeds the growth trajectory commentary below — raw per-period figures
      // at whatever cadence the client actually reports, not aggregated (the
      // AI has the cadence in clientData already and can read the trend
      // itself; no need to duplicate get_growth_trajectory's rollup logic
      // here just for a qualitative read).
      supabase.from('financial_snapshots').select('period_end, revenue, net_profit').eq('client_id', client_id).lte('period_end', period_end).order('period_end', { ascending: false }).limit(6),
      // Owner & Succession's own checklists for THIS period — feeds the
      // owner_wealth pillar score below. Fetched unconditionally rather than
      // gated on cadence, same as risk_items above; the cost of one extra
      // small query on a quarterly/half-yearly run is negligible next to
      // gating this whole block on `context.cadence`, which isn't known
      // until this same Promise.all resolves.
      supabase.from('owner_wealth_snapshots').select('estate_planning_checklist, exit_readiness_checklist').eq('client_id', client_id).eq('period_end', period_end).maybeSingle(),
    ]);
    if (!fs) throw new Error('No financial snapshot found — run xero-pull first');
    // A period row can exist with nothing entered ("+ New period" creates
    // it) — analysing that produced a diagnosis and scores from nothing.
    if (fs.revenue == null && fs.net_profit == null) throw new Error('No figures entered for this period yet — add revenue and profit on the Input tab first.');

    // Isolated the same way read-data.js isolates it — until
    // migration_risk_items_v3.sql (risk_questions) is run, this throws, and
    // it must not take down the whole analysis (diagnosis, flags, KPIs)
    // just because the owner_wealth pillar's exit-readiness scoring below
    // couldn't match a business answer to its question.
    let allQuestions = [];
    try {
      allQuestions = await getAllActiveQuestions(supabase);
    } catch (err) {
      console.error('getAllActiveQuestions failed:', err.message);
    }

    const trendHistory = [...(trendHistoryResult?.data || [])].reverse(); // oldest -> newest

    const ratios = computeRatios(fs);
    const priorFs = priorFsList?.[0] || null;
    const priorRatios = priorFs ? computeRatios(priorFs) : null;
    const flags = runFlags(fs, priorFs, ratios, priorRatios);
    const businessRows = (riskItemsResult?.data || []).filter((r) => r.source === 'business');
    const estateChecklist = ownerWealthSnapshotResult?.data?.estate_planning_checklist || [];
    const exitReadinessChecklist = ownerWealthSnapshotResult?.data?.exit_readiness_checklist || [];
    const profitabilityScoreForOwner = scorePillar('profitability', ratios, {});
    const exitReadinessOverall = computeExitReadinessOverall(exitReadinessChecklist, businessRows, allQuestions, profitabilityScoreForOwner);
    const estateByKey = Object.fromEntries(estateChecklist.map((it) => [it.key, it]));
    const applicableEstateItems = Object.keys(OWNER_ESTATE_CHECKLIST_ITEMS).filter((key) => ownerEstateItemApplicable(key, context?.entity_type));
    const ownerWealth = {
      exitReadinessOverall,
      estateApplicableCount: applicableEstateItems.length,
      estateGapCount: applicableEstateItems.filter((key) => estateByKey[key]?.status === 'no').length,
    };
    const taxScore = await computeTaxPillarScore(supabase, {
      clientId: client_id, periodEnd: period_end, cadence: context?.cadence, fyEnd: context?.fy_end, entityType: context?.entity_type, fs,
      companyTaxRate: context?.profile_extra?.company_tax_rate,
    });
    // Gives the AI something concrete to say about tax structure for Sole
    // trader/Partnership/Trust instead of guessing — same computation the
    // pillar score itself now uses (see computeTaxFromSavedSplit), just
    // phrased as a sentence rather than a 0-10 number.
    let taxSplitSummary = null;
    if (fs.net_profit != null && fs.tax_structure_split) {
      const combinedTax = computeTaxFromSavedSplit(context?.entity_type, fs.net_profit, fs.tax_structure_split);
      if (combinedTax != null) {
        const rate = fs.net_profit > 0 ? ((combinedTax / fs.net_profit) * 100).toFixed(1) : '0.0';
        const peopleCount = (fs.tax_structure_split.shares || []).filter((v) => Number(v) > 0).length || 1;
        taxSplitSummary = `Saved split across ${peopleCount} ${peopleCount === 1 ? 'person' : 'people'} — estimated combined effective rate ~${rate}% on ${money(fs.net_profit)} profit.`;
      }
    }
    // Moved ahead of pillar scoring (used to run after) so the Cash flow
    // pillar can use the real operating-cash-conversion figure instead of
    // current ratio alone — see scoreCashFlowPillar. Same formula
    // deriveOperatingCashFlow's own comment already documents: EBITDA basis
    // (net profit + interest + D&A), both pre-tax, same as kpi_library's
    // op_cash_conversion denominator, so this reads identically to what the
    // KPI card itself shows.
    const ocf = deriveOperatingCashFlow(fs, priorFs);
    const ebitdaApprox = (fs.net_profit || 0) + (fs.interest_expense || 0) + (fs.depreciation_amortisation || 0);
    const ocfConversion = (ocf.value != null && ebitdaApprox) ? ocf.value / ebitdaApprox : null;
    const gpMarginTarget = findKpiTarget(context?.owner_goals, period_end, 'gp_margin');
    // Only worth the lookup (a cache read, or on a cache miss an AI call —
    // see gp-margin-benchmark.js) when there's no client-set target to use
    // instead and an industry is actually on file to ask about. Non-fatal:
    // a benchmark failure must not take down the whole analysis, same
    // pattern as syncFinancialRiskItems/getAllActiveQuestions below.
    let gpBenchmark = null;
    if (gpMarginTarget == null && context?.industry) {
      try {
        gpBenchmark = await getOrGenerateGpMarginBenchmark(supabase, context.industry, context.business_description);
      } catch (err) {
        console.error('GP margin benchmark lookup failed:', err.message);
      }
    }
    const riskContext = {
      flags, riskItems: riskItemsResult?.data || [], fs, priorFs, ownerWealth, taxScore, ocfConversion, gpMarginTarget, gpBenchmark,
      posture: context?.profile_extra?.posture,
    };
    const activePillars = CADENCE_PILLARS[context?.cadence || 'quarterly'];
    // Only pillars that actually got a score — an unscored one (null) used
    // to count as 0 here (dragging health down) or arrive as a placeholder 6
    // (propping it up). Health is the average of what was really assessed;
    // null when nothing could be scored at all.
    const scores = activePillars
      .map((p) => ({ pillar: p, score: scorePillar(p, ratios, riskContext), active: true }))
      .filter((s) => s.score != null);
    const healthScore = scores.length
      ? Math.round((scores.reduce((sum, s) => sum + s.score, 0) / (10 * scores.length)) * 100)
      : null;

    // kpi_library may not exist yet on a fresh setup — degrade gracefully
    // rather than failing the whole analysis over an optional add-on table.
    const kpiLibrary = kpiLibResult.error ? [] : (kpiLibResult.data || []);
    const fsForKpis = ocf.derived ? { ...fs, operating_cash_flow: ocf.value } : fs;
    const kpis = computeAllKpis(fsForKpis, priorFs, kpiLibrary);
    if (ocf.derived) {
      const ocfKpi = kpis.find((k) => k.key === 'op_cash_conversion');
      if (ocfKpi && ocfKpi.value !== null) {
        ocfKpi.confidence = 'yellow';
        ocfKpi.estimation_note = 'Operating cash flow wasn\'t entered — estimated as net profit + interest + depreciation/amortisation, adjusted for the change in debtors, creditors, and inventory.';
      }
    }
    const availableKpis = kpis.filter((k) => k.confidence !== 'red');
    const cashSummary = cashStorySummary(buildCashReconciliation(fs, priorFs, ocf.value, ocf.derived));

    // Ask Claude for the diagnosis/advise narrative, grounded in the computed facts.
    // Netlify's synchronous function invocation has a hard timeout (30s in local
    // dev, as low as 10s on some production plans) — so brevity here isn't a style
    // choice, it's what keeps this call from timing out with 12 KPIs in scope.
    // Every instruction below caps length explicitly for that reason.
    // Targets aren't fetched via kpi_library/financial_snapshots — they live as
    // structured fields on Goals items (see index.html's findKpiTarget) — so
    // pull them in here too, otherwise the diagnosis has no way to know one
    // was ever set, let alone how far off it the client currently is.
    const kpiTargets = Object.fromEntries(
      availableKpis.map((k) => [k.key, findKpiTarget(context?.owner_goals, period_end, k.key)]).filter(([, t]) => t != null)
    );

    // Split into a STATIC instruction block (identical on every call to this
    // function, regardless of client) and a DYNAMIC per-client data block.
    // The static half goes in `system` with cache_control so repeated calls
    // in the same adviser session (running analysis for several clients/
    // periods back to back) reuse the cached prefix instead of paying full
    // input-token price for the same instructions every time. Caveat: Claude
    // only actually caches a block once it's at least ~1024 tokens (Sonnet)
    // — this block is close to that but isn't guaranteed to clear it, so
    // treat this as "correctly wired for when it applies" rather than a
    // guaranteed saving on every call.
    const systemInstructions = `You are the analysis engine for an accounting advisory app. Given this client's data, write, using SHORT, DIRECT language throughout (this is a strict length budget, not a preference):
1. A diagnosis, UP TO 70 WORDS (use the budget well — this is the most important synthesis in the report — but a hard technical limit means it cannot run longer). Reference the specific ratios/flags, call out any meaningful gap between a KPI's current value and its target where one is set (see "targets" below), and bring in general industry context only where it genuinely adds insight. Where years trading, employee count, or notable context below would change how a number should read (e.g. a ratio that's normal for a 1-year-old business but not a 20-year-old one, or a recent ownership change explaining a dip), factor it in — don't just restate it.
2. Up to 2 "get better" items — efficiency/operational fixes tied to a CURRENT gap or underperforming metric (e.g. closing a margin gap, fixing cost classification, tightening a process) — each with a short title (≤6 words) and impact/difficulty/timeframe in ≤15 words total.
3. Up to 2 growth opportunities — NEW, additive ideas (new services, pricing changes, marketing/customer acquisition, expansion, upsell) that are NOT about fixing something currently wrong — each with a short title (≤6 words) and impact/difficulty/timeframe in ≤15 words total. If "cash movement this period" below shows a real surplus with no clear use (no debt paydown, no reinvestment), that's a legitimate opportunity too (e.g. accelerate debt repayment, invest in equipment, build a buffer) — don't force one if the movement doesn't suggest it. Check "What the owner wants" below first: if posture is Consolidate or Hold wealth, don't suggest business-expansion ideas — reframe this slot toward efficiency, distributions, or tax/wealth extraction instead, since growing bigger isn't what this owner is asking for. For each, also give: "takes" — what actually doing this would require (≤12 words, e.g. "Two new hires and a 90-day ramp"); "risk" — the real downside if it doesn't work out (≤12 words, e.g. "Upfront hiring cost with no guaranteed pickup"); "decision" — the concrete choice facing the client, phrased as a question or a fork, not a restatement of the title (≤12 words, e.g. "Hire ahead of demand, or wait for signed contracts first?").
4. Up to 2 tax planning opportunities — things worth the adviser reviewing WITH the client, grounded in this client's actual entity structure, profit level, and numbers below (e.g. timing of income/expenses or asset purchases before year-end, depreciation, super contributions, structure fit for the current profit level, use of losses) — each with a short title (≤6 words) and impact/difficulty/timeframe in ≤15 words total. These are prompts for a conversation, NOT advice to act on: phrase each title/impact as something to review, never as an instruction (e.g. "Review pre-year-end asset timing", not "Buy equipment now"). Skip entirely if nothing genuinely stands out — don't invent one to fill the quota.
5. For each KPI listed below, ONE interpretation line under 12 words: state the given "value" EXACTLY AS WRITTEN — it's already formatted (e.g. "21.6%", "14d", "1.31x"), so copy it verbatim, never recalculate, reformat, or convert it yourself — and, if a trend is given, whether it's improving or worsening. If marked "estimated", add a 2-3 word reason in parentheses. Skip any KPI not listed — those are unavailable, don't invent a number for them.
6. Separately, for these six KPIs specifically — GP margin, Net profit margin, Wages/sales, Debtor days, Creditor days, Inventory days — add a benchmark line under 10 words each, e.g. "Typically 40-55% for auto repair shops" (general knowledge, NOT a verified data source, using the client's actual industry and description, not a generic category). These six are industry-driven enough that a benchmark is meaningful — the rest of the KPIs (revenue growth, ROE, debt/equity, current ratio, operating cash conversion, effective tax rate) are capital-structure or lifecycle-dependent rather than industry-dependent, so never benchmark those. Only omit one of the six if you genuinely have no reasonable basis for this specific industry — don't guess vaguely just to fill it in.
7. A growth trajectory commentary, UP TO 40 WORDS — given "Revenue/net profit history" below (oldest to newest), say plainly whether growth looks like it's accelerating, flattening, lumpy, or declining. If something is genuinely holding it back, give ONE concrete recommendation for improving it, grounded in these actual numbers (not generic advice). If the trend is genuinely healthy and there's no real fix to push, say so plainly and name what's working — don't invent an improvement just to fill the slot; "keep doing what's working" is a legitimate answer, not a fallback. If there's only one period of history, say there isn't enough history yet rather than inventing a trend from a single data point.
8. For EVERY KPI listed below (not just the six benchmarked ones), one plain verdict word — "good", "ok", or "bad" — on how favourably THIS value reads for THIS business. If a target is set for that KPI (see "targets" below), judge against how close the value is to it, not a blunt pass/fail (narrowly missing a tough target is "ok", not "bad"). For the six benchmarked KPIs (point 6): if no target is set, this verdict MUST be derived from the SAME benchmark range you wrote in point 6 for that KPI — "good" if the value sits at or beyond the healthy end of that range, "bad" if it sits meaningfully outside it, "ok" in between — never a separately-reasoned judgment that could disagree with your own stated range, since both are shown on the same card and a mismatch reads as a contradiction to the accountant. For every other KPI with no target, judge against realistic typical/industry expectations for this business's type and life stage — the same judgment call you're already making for the interpretation line in point 5. Reserve "bad" for a genuine concern, not merely below-average. If you have no defensible basis to judge a KPI at all (e.g. debt/equity or effective tax rate for a business with no clear norm to compare against), use "ok" rather than guessing at "good" or "bad".
9. A "brief_summary" for each of financial, growth, owner — ONE sentence, UNDER 25 WORDS, the single thing an adviser would actually say out loud to open that part of a client meeting. This is a distinct, shorter synthesis from the main diagnosis in point 1 — not a truncation of it. "financial" covers profit/cash/tax together (lead with cash or tax specifically if either is the more pressing story this period, not just margin). "growth" names the most promising live opportunity, if any, or says plainly there isn't one worth raising. "owner" connects the business's trajectory to the owner's stated goal/posture (see "What the owner wants" below) — e.g. progress toward or away from their target, not a restatement of the valuation number alone. (Risk gets its own summary elsewhere, from the actual risk register — not asked for here, since this call has no visibility into individual risk items, only financial flags.)

Respond ONLY as JSON, no markdown fences: {"diagnosis": "...", "get_better": [{"title":"","impact":"","difficulty":"","timeframe":""}], "opportunities": [{"title":"","impact":"","difficulty":"","timeframe":"","takes":"","risk":"","decision":""}], "tax_planning": [{"title":"","impact":"","difficulty":"","timeframe":""}], "kpi_interpretations": {"<kpi_key>": "..."}, "kpi_benchmarks": {"<kpi_key>": "..."}, "kpi_verdicts": {"<kpi_key>": "good|ok|bad"}, "growth_trajectory_commentary": "...", "brief_summary": {"financial":"","growth":"","owner":""}}`;

    const clientData = `Client: ${context?.business_description || 'no description'} (${context?.industry}), entity structure: ${context?.entity_type || 'not set'}
Years trading: ${context?.profile_extra?.years_trading ?? 'not set'}
Employees: ${context?.profile_extra?.employee_count ?? 'not set'}
Notable context (family situation, ownership history, anything else worth knowing): ${context?.structure_notes || 'none noted'}
Key contact's role: ${context?.profile_extra?.key_contact_role || 'not set'} — matters for tone: advice for the Owner reads differently than advice being relayed through a Manager who isn't one.
What the owner wants (major goal / current posture / stated horizon in years): ${context?.profile_extra?.major_goal || 'not set'} / ${context?.profile_extra?.posture || 'not set'} / ${context?.profile_extra?.goal_horizon_years ?? 'not set'}
Cadence: ${context?.cadence}
Tax structure split (only applies to Sole trader/Partnership/Trust, which pay no tax at the entity level themselves — for these entity types, tax_expense is normal/expected to be blank, not a data gap): ${taxSplitSummary || 'not saved — no per-partner/beneficiary breakdown available, so no combined personal tax estimate exists for this period'}
Ratios: ${JSON.stringify(ratios)}
Flags fired: ${JSON.stringify(flags)}
Pillar scores: ${JSON.stringify(scores)}
Targets set by the client (kpi_key: target value, same units as the KPI's own value): ${JSON.stringify(kpiTargets)}
Cash movement this period: ${cashSummary || 'not available'}
Revenue/net profit history, oldest to newest, at this client's own reporting cadence (may be fewer than 6 periods): ${JSON.stringify(trendHistory)}
KPIs available this period: ${JSON.stringify(availableKpis.map((k) => ({
  key: k.key, name: k.name, value: formatKpiValue(k.value, k.format), prior_value: formatKpiValue(k.priorValue, k.format),
  estimated: k.confidence === 'yellow', estimation_note: k.estimation_note,
})))}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1800,
        system: [{ type: 'text', text: systemInstructions, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: clientData }],
      }),
    });
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    const kpiInterpretations = parsed.kpi_interpretations || {};
    const kpiBenchmarks = parsed.kpi_benchmarks || {};
    const kpiVerdicts = parsed.kpi_verdicts || {};
    // Reuses the diagnostics table (pillar = kpi key, or 'benchmark_<kpi key>'/
    // 'verdict_<kpi key>' for the separate AI-estimated benchmark/verdict lines)
    // rather than new tables/columns — one row per KPI per period, same shape
    // as the existing pillar='overall' row.
    const kpiDiagnosticRows = [
      ...availableKpis.filter((k) => kpiInterpretations[k.key]).map((k) => ({ client_id, period_end, pillar: k.key, cause_text: kpiInterpretations[k.key] })),
      ...availableKpis.filter((k) => kpiBenchmarks[k.key]).map((k) => ({ client_id, period_end, pillar: `benchmark_${k.key}`, cause_text: kpiBenchmarks[k.key] })),
      ...availableKpis.filter((k) => ['good', 'ok', 'bad'].includes(kpiVerdicts[k.key])).map((k) => ({ client_id, period_end, pillar: `verdict_${k.key}`, cause_text: kpiVerdicts[k.key] })),
    ];

    // flags/pillar_scores/recommendations/diagnostics have no uniqueness constraint on
    // (client_id, period_end), so re-running analysis for the same period would otherwise
    // pile duplicate rows on top of the old ones — clear this period's rows first.
    await Promise.all([
      supabase.from('flags').delete().eq('client_id', client_id).eq('period_end', period_end),
      supabase.from('pillar_scores').delete().eq('client_id', client_id).eq('period_end', period_end),
      supabase.from('recommendations').delete().eq('client_id', client_id).eq('period_end', period_end),
      supabase.from('diagnostics').delete().eq('client_id', client_id).eq('period_end', period_end),
    ]);

    await Promise.all([
      supabase.from('flags').insert(flags.map((f) => ({ ...f, client_id, period_end }))),
      ...(scores.length ? [supabase.from('pillar_scores').insert(scores.map((s) => ({ ...s, client_id, period_end })))] : []),
      // Nothing scorable (e.g. an empty period) — drop any earlier health
      // score for this period rather than leave a stale one showing.
      healthScore != null
        ? supabase.from('health_scores').upsert({ client_id, period_end, score: healthScore, active_pillar_count: scores.length }, { onConflict: 'client_id,period_end' })
        : supabase.from('health_scores').delete().eq('client_id', client_id).eq('period_end', period_end),
      supabase.from('diagnostics').insert({ client_id, period_end, pillar: 'overall', cause_text: parsed.diagnosis }),
      ...(parsed.growth_trajectory_commentary ? [supabase.from('diagnostics').insert({ client_id, period_end, pillar: 'growth_trajectory', cause_text: parsed.growth_trajectory_commentary })] : []),
      ...(kpiDiagnosticRows.length ? [supabase.from('diagnostics').insert(kpiDiagnosticRows)] : []),
      // One-sentence "so what" per domain, distinct from the fuller diagnosis
      // above — feeds the Meeting brief cards and Overview's digest (see
      // meeting-intelligence-build-spec.md §3/§1). Reuses the diagnostics
      // table, pillar='brief_<domain>', same convention as benchmark_/verdict_.
      ...(parsed.brief_summary ? [supabase.from('diagnostics').insert(
        Object.entries(parsed.brief_summary).filter(([, text]) => text).map(([domain, text]) => ({ client_id, period_end, pillar: `brief_${domain}`, cause_text: text }))
      )] : []),
      supabase.from('recommendations').insert([
        ...(parsed.get_better || []).map((o) => ({ client_id, period_end, type: 'get_better', title: o.title, impact: o.impact, difficulty: o.difficulty, timeframe: o.timeframe })),
        ...(parsed.opportunities || []).map((o) => ({ client_id, period_end, type: 'growth', title: o.title, impact: o.impact, difficulty: o.difficulty, timeframe: o.timeframe, takes: o.takes || null, risk: o.risk || null, decision: o.decision || null })),
        ...(parsed.tax_planning || []).map((o) => ({ client_id, period_end, type: 'tax_planning', title: o.title, impact: o.impact, difficulty: o.difficulty, timeframe: o.timeframe })),
      ]),
    ]);

    // Risk Review, Source A — mirrors flags/pillar_scores/etc. into risk_items
    // so financial risk lives in the same table as business/industry risk,
    // with new/changed/resolved tracking (see lib/financial-risk-sync.js).
    // Non-fatal: an issue here must never take down analysis itself.
    try {
      await syncFinancialRiskItems(supabase, {
        clientId: client_id, periodEnd: period_end, flags,
      });
    } catch (err) {
      console.error('Financial risk sync failed:', err.message);
    }

    const kpisWithInterpretation = kpis.map((k) => ({ ...k, interpretation: kpiInterpretations[k.key] || null, benchmark: kpiBenchmarks[k.key] || null, verdict: ['good', 'ok', 'bad'].includes(kpiVerdicts[k.key]) ? kpiVerdicts[k.key] : null }));

    return { statusCode: 200, body: JSON.stringify({ ratios, flags, scores, healthScore, kpis: kpisWithInterpretation, ...parsed }) };
  } catch (err) {
    // This return body is never delivered anywhere — a background
    // function's caller already got its 202 the moment this invocation
    // started. The diagnostics row below is what actually reaches the
    // frontend: the run-analysis-btn poll checks for a fresh
    // 'analysis_error' row the same way it checks for a fresh 'overall'
    // one, so a genuine failure (bad API response, Supabase error, etc.)
    // still surfaces as an error instead of silently reading as "still
    // analyzing" forever.
    console.error('Analysis failed:', err.message);
    try {
      await supabase.from('diagnostics').insert({ client_id, period_end, pillar: 'analysis_error', cause_text: err.message });
    } catch (writeErr) {
      console.error('Failed to record analysis_error marker:', writeErr.message);
    }
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
