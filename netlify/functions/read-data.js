// netlify/functions/read-data.js
// With RLS on and no policies, the anon key can't read these tables from the
// browser — this function uses the service key server-side instead, same
// reasoning as xero-pull.js and analyze.js.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { getCategoriesForReview, getAllActiveQuestions } = require('./lib/business-risk-questionnaire');
const { getOrGenerateMultiple } = require('./lib/valuation-multiple');

exports.handler = async (event) => {
  try {
    const { action, client_id, period_end, view_cadence, periods_count } = JSON.parse(event.body || '{}');

    if (action === 'list_clients') {
      const { data, error } = await supabase.from('client_context').select('client_id, business_description, industry, cadence, profile_extra');
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (action === 'get_context') {
      const { data, error } = await supabase.from('client_context').select('*').eq('client_id', client_id).single();
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (action === 'get_overview') {
      let hs;
      if (period_end) {
        const { data } = await supabase.from('health_scores').select('*').eq('client_id', client_id).eq('period_end', period_end).maybeSingle();
        hs = data || null;
      } else {
        const { data: hsList } = await supabase.from('health_scores').select('*').eq('client_id', client_id).order('period_end', { ascending: false }).limit(1);
        hs = hsList?.[0] || null;
      }
      let pillarScores = [];
      let flags = [];
      let priorHealthScore = null;
      let priorPillarScores = [];
      if (hs) {
        const [{ data: ps }, { data: fl }, { data: priorHsList }] = await Promise.all([
          supabase.from('pillar_scores').select('*').eq('client_id', client_id).eq('period_end', hs.period_end),
          supabase.from('flags').select('*').eq('client_id', client_id).eq('period_end', hs.period_end),
          supabase.from('health_scores').select('*').eq('client_id', client_id).lt('period_end', hs.period_end).order('period_end', { ascending: false }).limit(1),
        ]);
        pillarScores = ps || [];
        flags = fl || [];
        priorHealthScore = priorHsList?.[0] || null;
        if (priorHealthScore) {
          const { data: priorPs } = await supabase.from('pillar_scores').select('*').eq('client_id', client_id).eq('period_end', priorHealthScore.period_end);
          priorPillarScores = priorPs || [];
        }
      }
      return { statusCode: 200, body: JSON.stringify({ healthScore: hs, pillarScores, flags, priorHealthScore, priorPillarScores }) };
    }

    if (action === 'list_periods') {
      const { data, error } = await supabase.from('financial_snapshots').select('period_end').eq('client_id', client_id).order('period_end', { ascending: false });
      if (error) throw error;
      const periods = [...new Set((data || []).map((r) => r.period_end))];
      return { statusCode: 200, body: JSON.stringify(periods) };
    }

    if (action === 'get_diagnosis') {
      let targetPeriod = period_end;
      if (!targetPeriod) {
        const { data: hsList } = await supabase.from('health_scores').select('period_end').eq('client_id', client_id).order('period_end', { ascending: false }).limit(1);
        targetPeriod = hsList?.[0]?.period_end || null;
      }
      if (!targetPeriod) return { statusCode: 200, body: JSON.stringify({ diagnosis: null, getBetter: [], opportunities: [], taxPlanning: [], risks: [], growthTrajectoryCommentary: null }) };

      const [{ data: diag }, { data: recs }, { data: riskFlags }, { data: growthDiag }] = await Promise.all([
        supabase.from('diagnostics').select('*').eq('client_id', client_id).eq('period_end', targetPeriod).eq('pillar', 'overall').limit(1).maybeSingle(),
        supabase.from('recommendations').select('*').eq('client_id', client_id).eq('period_end', targetPeriod),
        supabase.from('flags').select('*').eq('client_id', client_id).eq('period_end', targetPeriod).not('risk_category', 'is', null),
        supabase.from('diagnostics').select('cause_text').eq('client_id', client_id).eq('period_end', targetPeriod).eq('pillar', 'growth_trajectory').limit(1).maybeSingle(),
      ]);
      return {
        statusCode: 200,
        body: JSON.stringify({
          diagnosis: diag?.cause_text || null,
          getBetter: (recs || []).filter((r) => r.type === 'get_better'),
          opportunities: (recs || []).filter((r) => r.type === 'growth'),
          taxPlanning: (recs || []).filter((r) => r.type === 'tax_planning'),
          risks: riskFlags || [],
          growthTrajectoryCommentary: growthDiag?.cause_text || null,
          period_end: targetPeriod,
        }),
      };
    }

    // KPIs are recomputed fresh from the persisted financial_snapshot every time
    // (mirrors analyze.js's engine — duplicated rather than shared, matching this
    // codebase's per-function-independence pattern), driven off the kpi_library
    // table rather than hardcoded formulas so new KPIs can be added as data.
    // Interpretations are read back from diagnostics (pillar = kpi key), where
    // analyze.js persisted them the last time it ran for this period.
    if (action === 'get_kpi_report') {
      if (!period_end) return { statusCode: 400, body: 'period_end required' };

      const [{ data: fs, error: fsErr }, { data: priorFsList }, { data: kpiLibrary, error: libErr }, { data: interpRows }] = await Promise.all([
        supabase.from('financial_snapshots').select('*').eq('client_id', client_id).eq('period_end', period_end).maybeSingle(),
        // Fetches 2 periods back, not just 1 — the immediate prior is used
        // everywhere as usual, but the "Cash in vs cash out" glance card also
        // needs the PRIOR period's own reconciliation (which itself needs a
        // period before that) so it has something to compare against.
        supabase.from('financial_snapshots').select('*').eq('client_id', client_id).lt('period_end', period_end).order('period_end', { ascending: false }).limit(2),
        supabase.from('kpi_library').select('*').eq('active', true).order('sort_order'),
        supabase.from('diagnostics').select('pillar, cause_text').eq('client_id', client_id).eq('period_end', period_end).neq('pillar', 'overall'),
      ]);
      if (fsErr) throw fsErr;
      if (!fs) return { statusCode: 200, body: JSON.stringify({ kpis: [], snapshot: null }) };
      if (libErr) throw libErr;

      const priorFs = priorFsList?.[0] || null;
      const priorPriorFs = priorFsList?.[1] || null;
      // 'benchmark_<kpi key>' rows hold the separate AI-estimated benchmark line
      // (see analyze.js) — split back out from the plain interpretation rows.
      const interpretations = {};
      const benchmarks = {};
      (interpRows || []).forEach((r) => {
        if (r.pillar.startsWith('benchmark_')) benchmarks[r.pillar.slice('benchmark_'.length)] = r.cause_text;
        else interpretations[r.pillar] = r.cause_text;
      });

      const sumFields = (snapshot, fields) => {
        if (!snapshot || !fields) return null;
        let total = 0;
        for (const f of fields) {
          const v = snapshot[f];
          if (v === null || v === undefined) return null;
          total += Number(v);
        }
        return total;
      };

      const computeKpiValue = (snapshot, kpi, prior) => {
        if (kpi.kind === 'growth') {
          const cur = sumFields(snapshot, kpi.numerator);
          const priorVal = sumFields(prior, kpi.numerator);
          return (cur === null || priorVal === null || priorVal === 0) ? null : (cur - priorVal) / priorVal;
        }
        const num = sumFields(snapshot, kpi.numerator);
        const den = sumFields(snapshot, kpi.denominator);
        if (num === null || den === null || den === 0) return null;
        return kpi.kind === 'days' ? (num / den) * 365 : num / den;
      };

      // Standard indirect-method estimate, used only when operating_cash_flow is
      // blank. Deliberately excludes capex, debt repayments, owner drawings, and
      // private loans — those are investing/financing activities, not operating
      // ones, and including them would stop this from isolating what the core
      // business actually generates. net_profit is PRE-tax throughout this app
      // (see FINANCIAL_FIELD_DEFS), so adding back interest alone brings this in
      // line with EBITDA (op_cash_conversion's denominator = net_profit +
      // interest + D&A, also pre-tax) — same basis on both sides of the ratio.
      // Mirrors analyze.js's deriveOperatingCashFlow.
      function deriveOperatingCashFlow(snap, prior) {
        if (snap.operating_cash_flow != null) return { value: snap.operating_cash_flow, derived: false };
        if (!prior) return { value: null, derived: false };
        const required = [snap.net_profit, snap.interest_expense, snap.depreciation_amortisation, snap.debtors, snap.creditors, snap.inventory, prior.debtors, prior.creditors, prior.inventory];
        if (required.some((v) => v == null)) return { value: null, derived: false };
        const value = snap.net_profit + snap.interest_expense + snap.depreciation_amortisation
          - (snap.debtors - prior.debtors)
          + (snap.creditors - prior.creditors)
          - (snap.inventory - prior.inventory);
        return { value, derived: true };
      }
      const ocf = deriveOperatingCashFlow(fs, priorFs);
      const fsForKpis = ocf.derived ? { ...fs, operating_cash_flow: ocf.value } : fs;

      // Explains the REST of the change in the bank balance that operating
      // cash flow alone doesn't — deliberately kept separate from
      // deriveOperatingCashFlow above (that stays "operating activities
      // only" on purpose).
      //
      // Investing (capex): estimated from the movement in fixed_assets
      // SPECIFICALLY (PP&E net book value) plus depreciation charged —
      // deliberately not total_assets - current_assets, which can include
      // unrelated non-current items (a loan receivable from a director,
      // long-term investments) that would distort the estimate. Still
      // distorted by any asset disposal during the period (no
      // disposal-proceeds/gain-on-sale field to correct for that) — caveated
      // in the frontend note, not silently presented as exact. Overridden by
      // equipment_purchases when entered.
      //
      // Financing: total_debt is expected to EXCLUDE any director/shareholder
      // loan (see FINANCIAL_FIELD_DEFS / pdf-extract guidance) — that's
      // tracked separately via director_loan_balance so the two can't
      // double-count. Interest is only subtracted here when operating cash
      // flow was DERIVED by us — our formula adds interest back to match
      // EBITDA, which strips it out of "operating", so it has to land here or
      // it vanishes into the residual. A manually-entered operating cash flow
      // figure may already include interest paid, so it's left alone then.
      //
      // cash_recon_adjustments is a free-form list (bookkeeper-entered, e.g.
      // "Insurance payout $15,000") for whatever doesn't fit a fixed field.
      function buildCashReconciliation(snap, prior, ocfValue, ocfDerived) {
        if (!prior || snap.cash == null || prior.cash == null || ocfValue == null) return null;
        const deltaCash = snap.cash - prior.cash;
        const nonOperating = deltaCash - ocfValue;

        const deltaFixedAssets = (snap.fixed_assets != null && prior.fixed_assets != null) ? snap.fixed_assets - prior.fixed_assets : null;
        const capexEstimate = (deltaFixedAssets != null && snap.depreciation_amortisation != null) ? deltaFixedAssets + snap.depreciation_amortisation : null;
        const capexIsEstimate = snap.equipment_purchases == null && capexEstimate != null;
        const capex = snap.equipment_purchases != null ? snap.equipment_purchases : capexEstimate;

        const deltaDebt = (snap.total_debt != null && prior.total_debt != null) ? snap.total_debt - prior.total_debt : null;
        const loanRepayments = snap.loan_repayments != null ? snap.loan_repayments : null;
        const newBorrowing = (deltaDebt != null && loanRepayments != null) ? deltaDebt + loanRepayments : null;
        const interestPaid = (ocfDerived && snap.interest_expense != null) ? snap.interest_expense : null;
        const deltaDirectorLoan = (snap.director_loan_balance != null && prior.director_loan_balance != null) ? snap.director_loan_balance - prior.director_loan_balance : null;
        const fundsIntroduced = snap.funds_introduced != null ? snap.funds_introduced : null;
        const ownerDrawings = snap.owner_drawings != null ? snap.owner_drawings : null;

        const adjustments = Array.isArray(snap.cash_recon_adjustments) ? snap.cash_recon_adjustments : [];
        const adjustmentsTotal = adjustments.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);

        const knownParts = [
          deltaDebt, interestPaid != null ? -interestPaid : null, deltaDirectorLoan,
          fundsIntroduced, ownerDrawings != null ? -ownerDrawings : null,
          capex != null ? -capex : null,
          adjustments.length ? adjustmentsTotal : null,
        ];
        const hasFinancingData = knownParts.some((v) => v != null);
        const financingKnown = knownParts.reduce((sum, v) => sum + (v || 0), 0);

        return {
          delta_cash: deltaCash, operating_cf: ocfValue, non_operating: nonOperating,
          period_end: snap.period_end, prior_period_end: prior.period_end,
          cash_current: snap.cash, cash_prior: prior.cash,
          total_debt_current: snap.total_debt, total_debt_prior: prior.total_debt,
          delta_debt: deltaDebt, new_borrowing: newBorrowing, loan_repayments: loanRepayments,
          interest_paid: interestPaid, interest_applicable: ocfDerived,
          delta_director_loan: deltaDirectorLoan,
          director_loan_balance: snap.director_loan_balance != null ? snap.director_loan_balance : null,
          director_loan_balance_prior: prior.director_loan_balance != null ? prior.director_loan_balance : null,
          funds_introduced: fundsIntroduced, owner_drawings: ownerDrawings,
          capex, capex_is_estimate: capexIsEstimate, capex_estimate: capexEstimate, equipment_purchases: snap.equipment_purchases,
          adjustments, adjustments_total: adjustmentsTotal,
          residual: nonOperating - financingKnown, has_financing_data: hasFinancingData,
        };
      }

      const kpis = (kpiLibrary || []).map((kpi) => {
        const value = computeKpiValue(fsForKpis, kpi, priorFs);
        const priorValue = kpi.kind === 'growth' ? null : computeKpiValue(priorFs, kpi, null);
        let confidence = value === null ? 'red' : (kpi.estimation_note ? 'yellow' : 'green');
        let estimationNote = kpi.estimation_note;
        if (kpi.key === 'op_cash_conversion' && ocf.derived && value !== null) {
          confidence = 'yellow';
          estimationNote = 'Operating cash flow wasn\'t entered — estimated as net profit + interest + depreciation/amortisation, adjusted for the change in debtors, creditors, and inventory.';
        }
        const result = {
          key: kpi.key, name: kpi.name, format: kpi.format, kind: kpi.kind, category: kpi.category,
          numerator: kpi.numerator, denominator: kpi.denominator,
          value, priorValue, confidence, estimation_note: estimationNote,
          interpretation: interpretations[kpi.key] || null,
          benchmark: benchmarks[kpi.key] || null,
          improvement_tip: kpi.improvement_tip || null,
        };
        // Exposes the derivation's individual components so the frontend can
        // offer an "adjust" panel — editing any one of these and recalculating,
        // rather than accepting the formula's output as fixed.
        if (kpi.key === 'op_cash_conversion' && ocf.derived) {
          result.ocf_breakdown = {
            net_profit: fs.net_profit, interest_expense: fs.interest_expense, depreciation_amortisation: fs.depreciation_amortisation,
            delta_debtors: fs.debtors - priorFs.debtors, delta_creditors: fs.creditors - priorFs.creditors, delta_inventory: fs.inventory - priorFs.inventory,
          };
        }
        if (kpi.key === 'op_cash_conversion') {
          const recon = buildCashReconciliation(fs, priorFs, ocf.value, ocf.derived);
          if (recon) result.cash_reconciliation = recon;
          // For the "Cash in vs cash out" glance card's period-over-period
          // comparison — the prior period's OWN reconciliation, computed the
          // same way, needs a period before IT (priorPriorFs) for its deltas.
          if (priorFs) {
            const priorOcf = deriveOperatingCashFlow(priorFs, priorPriorFs);
            const priorRecon = buildCashReconciliation(priorFs, priorPriorFs, priorOcf.value, priorOcf.derived);
            if (priorRecon) result.prior_cash_reconciliation = priorRecon;
          }
        }
        return result;
      });

      return { statusCode: 200, body: JSON.stringify({ kpis, snapshot: fs }) };
    }

    // Trend view for the Analyse tab — same KPI math as get_kpi_report, just run
    // across a run of consecutive periods instead of one. Fetches one extra period
    // up front purely so the oldest displayed period still has a "prior" to diff
    // growth/trend against; that extra period itself is never shown as a column.
    if (action === 'get_kpi_history') {
      const HISTORY_LENGTH = 6;
      const [{ data: snapshots, error: snapErr }, { data: kpiLibrary, error: libErr }] = await Promise.all([
        supabase.from('financial_snapshots').select('*').eq('client_id', client_id).lte('period_end', period_end || '9999-12-31').order('period_end', { ascending: false }).limit(HISTORY_LENGTH + 1),
        supabase.from('kpi_library').select('*').eq('active', true).order('sort_order'),
      ]);
      if (snapErr) throw snapErr;
      if (libErr) throw libErr;
      if (!snapshots || !snapshots.length) return { statusCode: 200, body: JSON.stringify({ periods: [], kpis: [] }) };

      const chronological = [...snapshots].reverse();

      const sumFields = (snapshot, fields) => {
        if (!snapshot || !fields) return null;
        let total = 0;
        for (const f of fields) {
          const v = snapshot[f];
          if (v === null || v === undefined) return null;
          total += Number(v);
        }
        return total;
      };

      const computeKpiValue = (snapshot, kpi, prior) => {
        if (kpi.kind === 'growth') {
          const cur = sumFields(snapshot, kpi.numerator);
          const priorVal = sumFields(prior, kpi.numerator);
          return (cur === null || priorVal === null || priorVal === 0) ? null : (cur - priorVal) / priorVal;
        }
        const num = sumFields(snapshot, kpi.numerator);
        const den = sumFields(snapshot, kpi.denominator);
        if (num === null || den === null || den === 0) return null;
        return kpi.kind === 'days' ? (num / den) * 365 : num / den;
      };

      // The +1 fetch above is only "extra" padding when there were actually
      // more than HISTORY_LENGTH periods to draw from — in that case the
      // oldest one is dropped from display and used purely as a trend
      // reference for the next-oldest. With fewer periods on file (including
      // just one), nothing is extra: every fetched period gets shown, and the
      // very first one simply has no prior to diff against (ratio/days KPIs
      // still compute fine without one — only 'growth' kind needs it).
      const hasSpareTrendRef = chronological.length > HISTORY_LENGTH;
      const shown = hasSpareTrendRef ? chronological.slice(1) : chronological;
      const priorFor = (i) => hasSpareTrendRef ? chronological[i] : (i > 0 ? chronological[i - 1] : null);
      const periods = shown.map((s) => s.period_end);
      const kpis = (kpiLibrary || []).map((kpi) => ({
        key: kpi.key, name: kpi.name, format: kpi.format, kind: kpi.kind, category: kpi.category,
        values: shown.map((snap, i) => computeKpiValue(snap, kpi, priorFor(i))),
      }));

      return { statusCode: 200, body: JSON.stringify({ periods, kpis }) };
    }

    // Growth trajectory chart's own dedicated action — deliberately NOT
    // folded into get_kpi_history above. That action's `kpis` array mixes
    // flow ratios (safe to aggregate by summing numerator/denominator) with
    // stock ratios like current_ratio/debt_to_equity (aggregating those by
    // summing across periods would be wrong — you'd want the last balance in
    // the bucket, not a sum of four quarters' worth of the same balance).
    // Revenue and net profit are both flow measures, so summing across a
    // cadence rollup is the ONLY case here that's safe to build generically
    // — keeping it a separate action means get_kpi_history (and Pace-to-goal,
    // which reads its `kpis` array) is completely unaffected by any of this.
    if (action === 'get_growth_trajectory') {
      const PERIODS_PER_YEAR = { quarterly: 4, half_yearly: 2, annual: 1 };

      const { data: context } = await supabase.from('client_context').select('cadence').eq('client_id', client_id).single();
      const nativeCadence = PERIODS_PER_YEAR[context?.cadence] ? context.cadence : 'quarterly';
      // Can't view finer than what was actually entered — clamp up to
      // native rather than pretend quarterly detail exists for an
      // annual-cadence client.
      const viewCadence = (view_cadence && PERIODS_PER_YEAR[view_cadence] && PERIODS_PER_YEAR[view_cadence] <= PERIODS_PER_YEAR[nativeCadence])
        ? view_cadence : nativeCadence;
      const bucketSize = PERIODS_PER_YEAR[nativeCadence] / PERIODS_PER_YEAR[viewCadence];

      const requestedCount = Math.min(Math.max(parseInt(periods_count, 10) || 6, 2), 20);
      const nativePeriodsNeeded = requestedCount * bucketSize;

      const { data: snapshots, error: snapErr } = await supabase
        .from('financial_snapshots')
        .select('period_end, revenue, net_profit, interest_expense, depreciation_amortisation')
        .eq('client_id', client_id)
        .lte('period_end', period_end || '9999-12-31')
        .order('period_end', { ascending: false })
        .limit(nativePeriodsNeeded);
      if (snapErr) throw snapErr;
      if (!snapshots || !snapshots.length) return { statusCode: 200, body: JSON.stringify({ periods: [], revenue: [], netProfit: [], interestExpense: [], depreciationAmortisation: [], nativeCadence, viewCadence }) };

      const chronological = [...snapshots].reverse();

      // Bucket into groups of `bucketSize` consecutive native periods, from
      // the OLDEST end forward — an incomplete trailing group (fewer than
      // bucketSize periods, e.g. a quarterly client only 2 quarters into
      // their current year) is dropped rather than shown as a partial
      // "year" that would understate the true annual figure. Same
      // null-over-guess convention this app already follows elsewhere.
      const buckets = [];
      for (let i = 0; i + bucketSize <= chronological.length; i += bucketSize) {
        buckets.push(chronological.slice(i, i + bucketSize));
      }
      const sumField = (bucket, field) => {
        let total = 0;
        for (const snap of bucket) {
          const v = snap[field];
          if (v === null || v === undefined) return null;
          total += Number(v);
        }
        return total;
      };

      const periods = buckets.map((b) => b[b.length - 1].period_end);
      const revenue = buckets.map((b) => sumField(b, 'revenue'));
      const netProfit = buckets.map((b) => sumField(b, 'net_profit'));
      // interest_expense/depreciation_amortisation: both flow (P&L expense)
      // measures like revenue/net_profit, so summing across a rollup is the
      // same safe operation — feeds the valuation card's multi-year average
      // EBITDA, not just the trajectory chart.
      const interestExpense = buckets.map((b) => sumField(b, 'interest_expense'));
      const depreciationAmortisation = buckets.map((b) => sumField(b, 'depreciation_amortisation'));

      return { statusCode: 200, body: JSON.stringify({ periods, revenue, netProfit, interestExpense, depreciationAmortisation, nativeCadence, viewCadence }) };
    }

    if (action === 'get_valuation_history') {
      const { data: valuations, error: valErr } = await supabase
        .from('business_valuations')
        .select('*')
        .eq('client_id', client_id)
        .order('period_end');
      if (valErr) throw valErr;

      // Always try to surface a recommended multiple when the client has an
      // industry on file — not just pre-save. Cheap to do every time thanks
      // to the industry_valuation_multiple_cache: a repeat lookup for the
      // same industry is a cache read, not a fresh AI call, so there's no
      // real cost to keeping "Recommended" populated even on a period
      // that's already been saved.
      let suggestedMultiple = null;
      const { data: context } = await supabase.from('client_context').select('industry, business_description').eq('client_id', client_id).single();
      if (context?.industry) {
        try {
          suggestedMultiple = await getOrGenerateMultiple(supabase, context.industry, context.business_description);
        } catch (err) {
          console.error('Valuation multiple generation failed:', err.message);
        }
      }

      return { statusCode: 200, body: JSON.stringify({ valuations: valuations || [], suggestedMultiple }) };
    }

    if (action === 'get_owner_wealth') {
      // Run independently (Promise.all, and the wealth-snapshots error is
      // swallowed rather than thrown) so a missing/erroring
      // owner_wealth_snapshots table — e.g. before its migration has been
      // run — can never take down the business-equity cross-reference,
      // which reads a completely separate table. Same "degrade gracefully,
      // optional table" convention already used for kpi_library elsewhere.
      const [ownerWealthResult, valuationsResult] = await Promise.all([
        supabase.from('owner_wealth_snapshots').select('*').eq('client_id', client_id).order('period_end'),
        supabase.from('business_valuations').select('period_end, valuation_amount').eq('client_id', client_id).order('period_end', { ascending: false }).limit(1),
      ]);
      if (ownerWealthResult.error) console.error('owner_wealth_snapshots read failed:', ownerWealthResult.error.message);
      const snapshots = ownerWealthResult.data;
      const valuations = valuationsResult.data;

      return { statusCode: 200, body: JSON.stringify({ snapshots: snapshots || [], latestValuation: valuations?.[0] || null }) };
    }

    // Risk Review domain — rolls up all sources sharing risk_items. Financial
    // is period-scoped (re-synced every analyze.js run, see
    // lib/financial-risk-sync.js) so it's filtered to the period being viewed;
    // business and industry both don't change per period (business questions
    // are answered once and resurface adaptively, see
    // business-risk-questionnaire.js; industry is generated once per client),
    // so both are fetched for the client regardless of which period is
    // selected.
    if (action === 'get_risk_items') {
      // .order('id') as a tiebreaker on every query here: industry's rows
      // are all written in one bulk insert (see generateIndustryRiskItems),
      // so they share the exact same created_at down to the microsecond —
      // Postgres has no defined order for ties on created_at alone, and an
      // UPDATE (e.g. a review action changing status) can shuffle which
      // row comes back first for those ties. id is random but permanent,
      // so adding it as a secondary sort makes the order deterministic and
      // stable across reads regardless of what's been updated. Same risk
      // exists for financial's severity ties, so it gets the tiebreaker too.
      const [{ data: financial }, { data: industry }, { data: business }] = await Promise.all([
        period_end
          ? supabase.from('risk_items').select('*').eq('client_id', client_id).eq('period_end', period_end).eq('source', 'financial').order('severity', { ascending: false }).order('id')
          : Promise.resolve({ data: [] }),
        supabase.from('risk_items').select('*').eq('client_id', client_id).eq('source', 'industry').order('created_at').order('id'),
        supabase.from('risk_items').select('*').eq('client_id', client_id).eq('source', 'business').order('created_at').order('id'),
      ]);

      // Isolated from the block above on purpose — until migration_risk_items_v3.sql
      // (risk_questions) is run, this throws, and it must not take down
      // financial/industry/business (which already work) along with it.
      // Client-level, not period-scoped — resurfacing depends on when a
      // category was last reviewed at all, not the period being viewed.
      // Each returned category already carries its full flat question
      // list (see business-risk-questionnaire.js) — no separate
      // per-category follow-up fetch needed now that there's no anchor/
      // follow-up split.
      // allQuestions is every active question regardless of due-for-review
      // status — the frontend needs each question's risk_if_yes to let an
      // accountant re-open and edit an already-answered question (e.g. a
      // "no risk identified" row) that isn't currently due, since due-for-
      // review only carries questions that need attention this cycle.
      let categoriesToReview = [];
      let allQuestions = [];
      try {
        [categoriesToReview, allQuestions] = await Promise.all([
          getCategoriesForReview(supabase, client_id),
          getAllActiveQuestions(supabase),
        ]);
      } catch (err) {
        console.error('getCategoriesForReview failed:', err.message);
      }

      return { statusCode: 200, body: JSON.stringify({ financial: financial || [], industry: industry || [], business: business || [], categoriesToReview, allQuestions }) };
    }

    if (action === 'get_report_data') {
      const [{ data: hs }, { data: recs }] = await Promise.all([
        supabase.from('health_scores').select('*').eq('client_id', client_id).order('period_end', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('recommendations').select('*').eq('client_id', client_id).order('period_end', { ascending: false }).limit(3),
      ]);
      return { statusCode: 200, body: JSON.stringify({ healthScore: hs, recommendations: recs }) };
    }

    return { statusCode: 400, body: 'Unknown action' };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
