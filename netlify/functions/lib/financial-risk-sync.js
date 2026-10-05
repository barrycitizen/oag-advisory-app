// netlify/functions/lib/financial-risk-sync.js
//
// Financial Risk Sync (Source A of Risk Review)
// ------------------------------------------------------------------
// Takes the output of analyze.js's runFlags() and writes it into the
// shared risk_items table alongside business/industry/owner_wealth risks,
// so the dashboard can roll up all sources into one view.
//
// PERSISTENT, not period-scoped — same model as owner-wealth-risk-sync.js
// (which itself was converted from an earlier period-rebuilt design for
// the same reason). At most one row per (client_id, risk_name) exists at
// a time for this source: an existing row is updated in place (review
// status preserved) when the same risk_category keeps firing, a brand new
// risk_category gets a fresh row (still generated every run — persistence
// doesn't mean nothing new ever appears), and a risk_category that stops
// firing gets auto-resolved to 'Managed' rather than deleted, so the
// history isn't lost. Deleting a row via the UI (see index.html's
// .risk-delete-btn) removes the reviewable risk_items row, but NOT the
// underlying period-by-period record of when this actually fired — that
// lives separately in the `flags` table (period-scoped, untouched by any
// of this, rewritten fresh every analyze.js run), which is the genuine
// "was this true in period X" history. risk_items is the human-facing,
// currently-being-tracked layer on top of it, not the history itself.
//
// Also handles the thing a raw flag list can't do on its own:
//   - is_new       — this risk_category has never had a row before
//   - is_changed   — severity changed since the existing row was last written
//   - auto-resolve — a risk that was active but isn't firing this run gets
//                    marked Managed, not deleted (e.g. "Cash-flow risk —
//                    resolved")
//   - status carry-forward — Confirm/Investigate/Not applicable survives
//                    every re-run (same period, next period, whenever),
//                    instead of resetting back to Detected
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

// Review status carries forward when an active row already exists —
// 'Detected' is excluded since it's every fresh row's own default
// (carrying it forward would be a no-op), and 'Managed' is excluded
// because if the same risk_category is firing again despite being marked
// resolved, that past call was apparently wrong or temporary and deserves
// a fresh Detected look, not to stay silently hidden.
const CARRY_FORWARD_STATUSES = new Set(['Identified', 'Watch', 'Not applicable']);

// Main entry point. Call this once per analysis run, right after
// runFlags() has run for a client — see analyze.js's handler. periodEnd is
// recorded on each row as "last touched in this period" (informational —
// see read-data.js's get_risk_items, which no longer filters financial by
// period, same as business/industry/owner_wealth) but no longer drives
// which rows exist; risk_name does.
async function syncFinancialRiskItems(supabase, { clientId, periodEnd, flags }) {
  const normalized = flags.map(normalizeFlag);

  // Existing state for this client — read once, up front, so this run's
  // active flags can be diffed against it below (update-in-place vs
  // insert vs auto-resolve), instead of wiping everything and rebuilding.
  const { data: existingRows, error: fetchError } = await supabase
    .from('risk_items').select('id, risk_name, status, severity')
    .eq('client_id', clientId).eq('source', 'financial');
  if (fetchError) throw fetchError;
  const existingByName = Object.fromEntries((existingRows || []).map((r) => [r.risk_name, r]));

  const today = new Date().toISOString().slice(0, 10);
  const ids = [];

  // Active this run: update the existing row in place (content refreshed,
  // review status preserved if it was Identified/Watch/Not applicable) or
  // insert new (fresh, so status defaults to Detected).
  for (const flag of normalized) {
    const existing = existingByName[flag.riskName];
    const payload = {
      client_id: clientId, period_end: periodEnd, source: 'financial',
      category: flag.category, risk_name: flag.riskName, detail: flag.detail,
      severity: flag.severity, impact_estimate: flag.impactEstimate,
      is_new: !existing, is_changed: !!existing && existing.severity !== flag.severity,
      last_reviewed_date: today,
    };
    if (existing) {
      const status = CARRY_FORWARD_STATUSES.has(existing.status) ? existing.status : 'Detected';
      const { error } = await supabase.from('risk_items').update({ ...payload, status }).eq('id', existing.id);
      if (error) throw error;
      ids.push(existing.id);
    } else {
      const { data, error } = await supabase.from('risk_items').insert({ ...payload, status: 'Detected' }).select('id').single();
      if (error) throw error;
      ids.push(data.id);
    }
  }

  // No longer firing: auto-resolve rather than delete, so the history
  // isn't lost. Skipped once already Managed so a long-resolved risk
  // doesn't get its last_reviewed_date bumped every single run.
  const activeNames = new Set(normalized.map((f) => f.riskName));
  for (const [riskName, existing] of Object.entries(existingByName)) {
    if (activeNames.has(riskName)) continue;
    if (existing.status === 'Managed') continue;
    const { error } = await supabase.from('risk_items')
      .update({ status: 'Managed', detail: 'Resolved — no longer detected as of the latest analysis.', last_reviewed_date: today })
      .eq('id', existing.id);
    if (error) throw error;
  }

  return ids;
}

module.exports = {
  syncFinancialRiskItems,
  normalizeFlag, // exported for testing against real runFlags() output
};
