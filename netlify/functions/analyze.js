// netlify/functions/analyze.js
// Runs the deterministic rules engine (ratios, flags, pillar scoring) and then
// calls Claude for the diagnosis/advise narrative — matching the framework's
// separation of Analysis Engine (rules = your IP) from the AI narrative layer.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

// Simple 0-10 scoring off ratio thresholds — replace with your own bands over time.
function scorePillar(pillar, ratios) {
  const band = (val, good, ok) => (val == null ? null : val >= good ? 9 : val >= ok ? 6 : 3);
  switch (pillar) {
    case 'profitability': return band(ratios.gp_margin, 0.4, 0.25);
    case 'cash_flow': return band(ratios.current_ratio, 1.5, 1.0);
    case 'tax': return 8; // placeholder until BAS-variance logic is added
    default: return 6; // placeholder for pillars not yet ratio-driven
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

exports.handler = async (event) => {
  try {
    const { client_id, period_end } = JSON.parse(event.body || '{}');
    if (!client_id || !period_end) return { statusCode: 400, body: 'client_id and period_end required' };

    const [{ data: fs }, { data: context }, { data: priorFsList }, kpiLibResult] = await Promise.all([
      supabase.from('financial_snapshots').select('*').eq('client_id', client_id).eq('period_end', period_end).single(),
      supabase.from('client_context').select('*').eq('client_id', client_id).single(),
      supabase.from('financial_snapshots').select('*').eq('client_id', client_id).lt('period_end', period_end).order('period_end', { ascending: false }).limit(1),
      supabase.from('kpi_library').select('*').eq('active', true).order('sort_order'),
    ]);
    if (!fs) throw new Error('No financial snapshot found — run xero-pull first');

    const ratios = computeRatios(fs);
    const priorFs = priorFsList?.[0] || null;
    const priorRatios = priorFs ? computeRatios(priorFs) : null;
    const flags = runFlags(fs, priorFs, ratios, priorRatios);
    const activePillars = CADENCE_PILLARS[context?.cadence || 'quarterly'];
    const scores = activePillars.map((p) => ({ pillar: p, score: scorePillar(p, ratios), active: true }));
    const healthScore = Math.round(
      (scores.reduce((sum, s) => sum + (s.score || 0), 0) / (10 * scores.length)) * 100
    );

    // kpi_library may not exist yet on a fresh setup — degrade gracefully
    // rather than failing the whole analysis over an optional add-on table.
    const kpiLibrary = kpiLibResult.error ? [] : (kpiLibResult.data || []);
    const ocf = deriveOperatingCashFlow(fs, priorFs);
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
1. A diagnosis, UP TO 70 WORDS (use the budget well — this is the most important synthesis in the report — but a hard technical limit means it cannot run longer). Reference the specific ratios/flags, call out any meaningful gap between a KPI's current value and its target where one is set (see "targets" below), and bring in general industry context only where it genuinely adds insight.
2. Up to 2 "get better" items — efficiency/operational fixes tied to a CURRENT gap or underperforming metric (e.g. closing a margin gap, fixing cost classification, tightening a process) — each with a short title (≤6 words) and impact/difficulty/timeframe in ≤15 words total.
3. Up to 2 growth opportunities — NEW, additive ideas (new services, pricing changes, expansion, upsell) that are NOT about fixing something currently wrong — each with a short title (≤6 words) and impact/difficulty/timeframe in ≤15 words total. If "cash movement this period" below shows a real surplus with no clear use (no debt paydown, no reinvestment), that's a legitimate opportunity too (e.g. accelerate debt repayment, invest in equipment, build a buffer) — don't force one if the movement doesn't suggest it.
4. Up to 2 tax planning opportunities — things worth the adviser reviewing WITH the client, grounded in this client's actual entity structure, profit level, and numbers below (e.g. timing of income/expenses or asset purchases before year-end, depreciation, super contributions, structure fit for the current profit level, use of losses) — each with a short title (≤6 words) and impact/difficulty/timeframe in ≤15 words total. These are prompts for a conversation, NOT advice to act on: phrase each title/impact as something to review, never as an instruction (e.g. "Review pre-year-end asset timing", not "Buy equipment now"). Skip entirely if nothing genuinely stands out — don't invent one to fill the quota.
5. For each KPI listed below, ONE interpretation line under 12 words: state the given "value" EXACTLY AS WRITTEN — it's already formatted (e.g. "21.6%", "14d", "1.31x"), so copy it verbatim, never recalculate, reformat, or convert it yourself — and, if a trend is given, whether it's improving or worsening. If marked "estimated", add a 2-3 word reason in parentheses. Skip any KPI not listed — those are unavailable, don't invent a number for them.
6. Separately, for these six KPIs specifically — GP margin, Net profit margin, Wages/sales, Debtor days, Creditor days, Inventory days — add a benchmark line under 10 words each, e.g. "Typically 40-55% for auto repair shops" (general knowledge, NOT a verified data source, using the client's actual industry and description, not a generic category). These six are industry-driven enough that a benchmark is meaningful — the rest of the KPIs (revenue growth, ROE, debt/equity, current ratio, operating cash conversion, effective tax rate) are capital-structure or lifecycle-dependent rather than industry-dependent, so never benchmark those. Only omit one of the six if you genuinely have no reasonable basis for this specific industry — don't guess vaguely just to fill it in.

Respond ONLY as JSON, no markdown fences: {"diagnosis": "...", "get_better": [{"title":"","impact":"","difficulty":"","timeframe":""}], "opportunities": [{"title":"","impact":"","difficulty":"","timeframe":""}], "tax_planning": [{"title":"","impact":"","difficulty":"","timeframe":""}], "kpi_interpretations": {"<kpi_key>": "..."}, "kpi_benchmarks": {"<kpi_key>": "..."}}`;

    const clientData = `Client: ${context?.business_description || 'no description'} (${context?.industry}), entity structure: ${context?.entity_type || 'not set'}
Cadence: ${context?.cadence}
Ratios: ${JSON.stringify(ratios)}
Flags fired: ${JSON.stringify(flags)}
Pillar scores: ${JSON.stringify(scores)}
Targets set by the client (kpi_key: target value, same units as the KPI's own value): ${JSON.stringify(kpiTargets)}
Cash movement this period: ${cashSummary || 'not available'}
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
        max_tokens: 1500,
        system: [{ type: 'text', text: systemInstructions, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: clientData }],
      }),
    });
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    const kpiInterpretations = parsed.kpi_interpretations || {};
    const kpiBenchmarks = parsed.kpi_benchmarks || {};
    // Reuses the diagnostics table (pillar = kpi key, or 'benchmark_<kpi key>' for
    // the separate AI-estimated benchmark line) rather than new tables/columns —
    // one row per KPI per period, same shape as the existing pillar='overall' row.
    const kpiDiagnosticRows = [
      ...availableKpis.filter((k) => kpiInterpretations[k.key]).map((k) => ({ client_id, period_end, pillar: k.key, cause_text: kpiInterpretations[k.key] })),
      ...availableKpis.filter((k) => kpiBenchmarks[k.key]).map((k) => ({ client_id, period_end, pillar: `benchmark_${k.key}`, cause_text: kpiBenchmarks[k.key] })),
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
      supabase.from('pillar_scores').insert(scores.map((s) => ({ ...s, client_id, period_end }))),
      supabase.from('health_scores').upsert({ client_id, period_end, score: healthScore, active_pillar_count: scores.length }, { onConflict: 'client_id,period_end' }),
      supabase.from('diagnostics').insert({ client_id, period_end, pillar: 'overall', cause_text: parsed.diagnosis }),
      ...(kpiDiagnosticRows.length ? [supabase.from('diagnostics').insert(kpiDiagnosticRows)] : []),
      supabase.from('recommendations').insert([
        ...(parsed.get_better || []).map((o) => ({ client_id, period_end, type: 'get_better', title: o.title, impact: o.impact, difficulty: o.difficulty, timeframe: o.timeframe })),
        ...(parsed.opportunities || []).map((o) => ({ client_id, period_end, type: 'growth', title: o.title, impact: o.impact, difficulty: o.difficulty, timeframe: o.timeframe })),
        ...(parsed.tax_planning || []).map((o) => ({ client_id, period_end, type: 'tax_planning', title: o.title, impact: o.impact, difficulty: o.difficulty, timeframe: o.timeframe })),
      ]),
    ]);

    const kpisWithInterpretation = kpis.map((k) => ({ ...k, interpretation: kpiInterpretations[k.key] || null, benchmark: kpiBenchmarks[k.key] || null }));

    return { statusCode: 200, body: JSON.stringify({ ratios, flags, scores, healthScore, kpis: kpisWithInterpretation, ...parsed }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
