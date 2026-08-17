// netlify/functions/lib/financial-risk-sync.js
//
// Financial Risk Sync (Source A of Risk Review)
// ------------------------------------------------------------------
// Takes the output of analyze.js's runFlags() and writes it into the
// shared risk_items table alongside business/industry risks, so the
// dashboard can roll up all three sources into one view.
//
// Also handles the thing a raw flag list can't do on its own:
//   - is_new       — this flag didn't exist last period
//   - is_changed   — severity changed since last period
//   - auto-resolve — a flag that existed last period but isn't firing
//                    this period gets marked Managed, not deleted, so
//                    the history isn't lost (e.g. "Cash-flow risk —
//                    resolved, last seen Q2 2026")
//
// Same lib/ placement as industry-risk-checklist.js — not a Netlify
// function itself, just required from analyze.js.
//
// DB: this app's Supabase client, client_id (uuid) + period_end (date)
// — not a raw pg pool with integer client/period ids. Run
// migration_risk_items_v2.sql before wiring this in (adds
// impact_estimate/is_new/is_changed to risk_items).

// Maps runFlags()'s actual risk_category strings (netlify/functions/analyze.js,
// runFlags()) onto the 8 business categories industry/business risks use, so
// financial risks slot into the same buckets on the dashboard. Extend this if
// runFlags() adds a new risk_category.
function mapCategoryFromRiskName(riskName) {
  const map = {
    'Cash-flow risk': 'financial',
    'Pricing/cost pressure': 'financial',
    'Leverage risk': 'financial',
    'Liquidity risk': 'financial',
    'Trading risk': 'financial',
    'Cost structure pressure': 'financial',
    'Debt servicing risk': 'financial',
    'Stock/cash risk': 'operations',
    'Tax rate shift': 'financial',
    'Tax affordability risk': 'financial',
  };
  return map[riskName] || 'financial';
}

// runFlags() only ever emits 'warning' or 'danger' (see analyze.js) — 'high'/
// 'low'/'red'/'green' are kept as a safety net in case that vocabulary
// changes or another flag source is added later.
function normalizeSeverity(rawSeverity) {
  const s = (rawSeverity || '').toLowerCase();
  if (s === 'danger' || s === 'high' || s === 'red') return 'High';
  if (s === 'low' || s === 'green') return 'Low';
  return 'Medium';
}

// Map one flag from runFlags() into the risk_items shape. runFlags()'s
// actual field names (risk_category/message/severity/impact_estimate)
// already match what was assumed here — nothing to rename.
function normalizeFlag(flag) {
  return {
    riskName: flag.risk_category,
    category: mapCategoryFromRiskName(flag.risk_category),
    detail: flag.message,
    severity: normalizeSeverity(flag.severity),
    impactEstimate: flag.impact_estimate ?? null, // already a formatted string or null — see runFlags()
  };
}

// Main entry point. Call this once per period, right after runFlags() has
// run for a client — see analyze.js's handler.
//
// previousPeriodEnd is optional — pass it if you have the prior period's
// period_end (analyze.js already fetches priorFs for the ratio comparisons,
// so priorFs?.period_end is free). If omitted, everything is written as
// is_new = true and nothing gets auto-resolved.
//
// Deletes and re-inserts THIS period's financial risk_items before writing
// — analyze.js's "Run analysis" can be re-run for the same period any time
// (see the flags/pillar_scores/etc. delete-then-insert a few lines up in
// the handler), and without this guard every re-run would pile up
// duplicate rows on top of the old ones.
async function syncFinancialRiskItems(supabase, { clientId, periodEnd, previousPeriodEnd, flags }) {
  const normalized = flags.map(normalizeFlag);

  let previousRows = [];
  if (previousPeriodEnd) {
    const { data } = await supabase
      .from('risk_items')
      .select('risk_name, severity, status')
      .eq('client_id', clientId)
      .eq('period_end', previousPeriodEnd)
      .eq('source', 'financial');
    previousRows = data || [];
  }
  const previousByName = Object.fromEntries(previousRows.map((r) => [r.risk_name, r]));

  const { error: delError } = await supabase
    .from('risk_items')
    .delete()
    .eq('client_id', clientId)
    .eq('period_end', periodEnd)
    .eq('source', 'financial');
  if (delError) throw delError;

  const today = new Date().toISOString().slice(0, 10);

  // This period's active flags.
  const activeRows = normalized.map((flag) => {
    const prevRow = previousByName[flag.riskName];
    return {
      client_id: clientId, period_end: periodEnd, source: 'financial',
      category: flag.category, risk_name: flag.riskName, detail: flag.detail,
      status: 'Detected', severity: flag.severity, impact_estimate: flag.impactEstimate,
      is_new: !prevRow, is_changed: !!prevRow && prevRow.severity !== flag.severity,
      last_reviewed_date: today,
    };
  });

  // Auto-resolve: anything flagged last period but not present this period
  // gets carried forward as Managed, not silently dropped. Skips rows
  // already Managed last period so a long-resolved risk doesn't keep
  // re-appearing every subsequent period.
  const activeNames = new Set(normalized.map((f) => f.riskName));
  const resolvedRows = previousRows
    .filter((r) => !activeNames.has(r.risk_name) && r.status !== 'Managed')
    .map((r) => ({
      client_id: clientId, period_end: periodEnd, source: 'financial',
      category: mapCategoryFromRiskName(r.risk_name), risk_name: r.risk_name,
      detail: 'Resolved — no longer detected as of this period',
      status: 'Managed', severity: r.severity, is_new: false, is_changed: true,
      last_reviewed_date: today,
    }));

  const rows = [...activeRows, ...resolvedRows];
  if (!rows.length) return [];

  const { data, error } = await supabase.from('risk_items').insert(rows).select('id');
  if (error) throw error;
  return (data || []).map((r) => r.id);
}

module.exports = {
  syncFinancialRiskItems,
  normalizeFlag, // exported for testing against real runFlags() output
};
