// netlify/functions/lib/owner-wealth-risk-sync.js
//
// Owner Wealth Risk Sync (Source D of Risk Review)
// ------------------------------------------------------------------
// Mirrors financial-risk-sync.js's delete-then-reinsert pattern, but for a
// different job: turning the Succession & estate planning card's
// already-computed flags (estate checklist gaps, succession readiness)
// into risk_items rows, so the same information — entered once on Owner
// Wealth → Input — is visible from Risk Review too, not just on that one
// card. "Enter once, feeds everywhere" is the principle; this is the
// wiring that makes it real for the first two things that needed it.
//
// Triggered from saveOwnerWealth (manual-entry.js) right after a save
// succeeds — not from a separate "Run analysis" step. Owner Wealth is
// annual-cadence-only and isn't part of the financial period-analysis
// cycle, so the save itself is the natural sync moment.
//
// Run migration_risk_items_v7.sql first (widens risk_items.source's CHECK
// constraint to allow 'owner_wealth').
//
// DB: this app's Supabase client, client_id (uuid) + period_end (date).

// Duplicated from index.html's OWNER_ESTATE_CHECKLIST_ITEMS rather than
// shared — same "per-file independence" convention business-risk-
// questionnaire.js already uses for BUSINESS_CATEGORY_LABEL. Only what
// this file needs: label/category/severity, not the fuller "why" copy the
// frontend shows.
const OWNER_ESTATE_CHECKLIST_ITEMS = {
  will: { label: 'Will up to date', category: 'legal', severity: 'High' },
  epoa: { label: 'Enduring Power of Attorney in place', category: 'legal', severity: 'High' },
  buy_sell_agreement: { label: 'Buy-sell agreement in place (funds the business succession)', category: 'legal', severity: 'Medium' },
  key_person_insurance: { label: 'Key-person insurance in place', category: 'insurance', severity: 'Medium' },
};

// Duplicated from index.html's OWNER_EXIT_READINESS_ITEMS, same convention
// as the estate checklist map above. All Medium severity — none of these
// is as immediately serious as a missing will/EPOA, but each genuinely
// reduces what a buyer would pay.
const OWNER_EXIT_READINESS_ITEMS = {
  recurring_revenue: { label: 'Meaningful recurring/contracted revenue', category: 'financial' },
  management_depth: { label: 'Management layer below the owner', category: 'people' },
  ip_protection: { label: 'Key IP/brand/systems legally protected', category: 'legal' },
  contracts: { label: 'Key relationships under written contract', category: 'legal' },
  lease_stability: { label: 'Premises situation stable and transferable', category: 'operations' },
};

// Same "soon" = within 3 years, "stale" = valuation older than 2 years
// thresholds as index.html's getOwnerSuccessionReadinessFlag — kept in
// sync by eye, not shared code (see file-header note above).
function buildSuccessionReadinessRow({ clientId, periodEnd, targetYear, latestValuation, today }) {
  const yearsAway = targetYear - new Date().getFullYear();
  if (yearsAway > 3) return null;
  const dueText = yearsAway <= 0 ? 'due now' : `${yearsAway} year${yearsAway === 1 ? '' : 's'} away`;

  let detail = null;
  if (!latestValuation) {
    detail = `Exit planned for ${targetYear} (${dueText}) but no business valuation has ever been saved — can't tell if the plan is financially realistic without a current number.`;
  } else {
    const ageYears = (Date.now() - new Date(latestValuation.period_end)) / (365.25 * 24 * 3600 * 1000);
    if (ageYears > 2) {
      detail = `Exit planned for ${targetYear} (${dueText}) but the last business valuation is from ${latestValuation.period_end} — worth refreshing before relying on it.`;
    }
  }
  if (!detail) return null;

  return {
    client_id: clientId, period_end: periodEnd, source: 'owner_wealth',
    category: 'financial', risk_name: 'Succession readiness',
    detail, status: 'Identified', severity: 'High', last_reviewed_date: today,
  };
}

const SUCCESSION_PATHWAY_LABELS = { family: 'Family', management: 'Existing management', partner: 'Business partner', external: 'External buyer', none: 'No identified successor' };

// A separate gap from valuation readiness — a client can have plenty of
// warning and a solid financial plan and still have no viable way to
// actually hand the business over. Kept in sync by eye with index.html's
// getOwnerSuccessionPathwayFlag (see file-header note above), same
// "developing is fine, missing/not-ready is the gap" logic.
function buildSuccessionPathwayRow({ clientId, periodEnd, items, today }) {
  const withPathway = items.filter((it) => it.succession_pathway);
  let detail = null;
  if (!withPathway.length) {
    detail = 'Exit planned but no succession pathway set — who takes over isn\'t identified yet.';
  } else if (withPathway.some((it) => it.succession_pathway === 'none')) {
    detail = 'No identified successor for the business.';
  } else {
    const notReady = withPathway.find((it) => it.successor_readiness === 'not_ready');
    if (notReady) detail = `${SUCCESSION_PATHWAY_LABELS[notReady.succession_pathway] || notReady.succession_pathway} identified as the succession pathway, but marked not ready to take over yet.`;
  }
  if (!detail) return null;
  return {
    client_id: clientId, period_end: periodEnd, source: 'owner_wealth',
    category: 'people', risk_name: 'Succession pathway',
    detail, status: 'Identified', severity: 'High', last_reviewed_date: today,
  };
}

// clientId/periodEnd only — estateChecklist and succession data are always
// fetched fresh here rather than passed in, so this can be triggered from
// EITHER save path (Owner Wealth's own save, or a Goals exit_succession
// save) without either one needing to know about the other's data. That's
// what makes editing a succession pathway in Goals show up in Risk
// immediately, not just the next time Owner Wealth happens to be saved.
async function syncOwnerWealthRiskItems(supabase, { clientId, periodEnd }) {
  // Delete this period's owner_wealth rows first — re-syncing for the same
  // period must not pile duplicates on top of the old ones, same guard
  // syncFinancialRiskItems uses for its own source.
  const { error: delError } = await supabase
    .from('risk_items').delete()
    .eq('client_id', clientId).eq('period_end', periodEnd).eq('source', 'owner_wealth');
  if (delError) throw delError;

  const [{ data: ctx }, { data: valuations }, { data: snapshot }] = await Promise.all([
    supabase.from('client_context').select('owner_goals, entity_type').eq('client_id', clientId).maybeSingle(),
    supabase.from('business_valuations').select('period_end, valuation_amount').eq('client_id', clientId).order('period_end', { ascending: false }).limit(1),
    supabase.from('owner_wealth_snapshots').select('estate_planning_checklist, exit_readiness_checklist').eq('client_id', clientId).eq('period_end', periodEnd).maybeSingle(),
  ]);
  const estateChecklist = snapshot?.estate_planning_checklist || [];
  const exitReadinessChecklist = snapshot?.exit_readiness_checklist || [];
  const entityType = ctx?.entity_type;

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  // Estate checklist gaps — one row per item marked "No". Buy-sell
  // agreement and key-person insurance are skipped for a sole trader —
  // mirrors index.html's ownerEstateItemApplicability: a sole trader has
  // no co-owner to buy out or insure against, so "No" there isn't a real
  // gap. Kept in sync by eye with that function (see file-header note).
  (estateChecklist || []).forEach((it) => {
    if (it.status !== 'no') return;
    if (entityType === 'Sole trader' && (it.key === 'buy_sell_agreement' || it.key === 'key_person_insurance')) return;
    const meta = OWNER_ESTATE_CHECKLIST_ITEMS[it.key];
    if (!meta) return; // unknown key — nothing to map it to, skip rather than write a garbled row
    rows.push({
      client_id: clientId, period_end: periodEnd, source: 'owner_wealth',
      category: meta.category, risk_name: meta.label,
      detail: it.notes || 'Marked not in place on Owner Wealth\'s estate planning checklist.',
      status: 'Identified', severity: meta.severity, last_reviewed_date: today,
    });
  });

  // Exit readiness gaps — one row per item marked "No" (not "Partial" —
  // that's a real, non-trivial answer, not the same as an outright gap).
  (exitReadinessChecklist || []).forEach((it) => {
    if (it.status !== 'no') return;
    const meta = OWNER_EXIT_READINESS_ITEMS[it.key];
    if (!meta) return;
    rows.push({
      client_id: clientId, period_end: periodEnd, source: 'owner_wealth',
      category: meta.category, risk_name: meta.label,
      detail: it.notes || 'Marked not in place on Owner Wealth\'s exit readiness checklist — reduces the business\'s attractiveness/value to a buyer.',
      status: 'Identified', severity: 'Medium', last_reviewed_date: today,
    });
  });

  // Succession readiness — target year within 3 years, valuation missing or stale.
  const allExitItems = (ctx?.owner_goals?.periods?.[periodEnd]?.cats?.['exit_succession']?.items || [])
    .filter((it) => !it.deleted && !it.done);
  const itemsWithTargetYear = allExitItems.filter((it) => it.target_year);
  if (itemsWithTargetYear.length) {
    const targetYear = Math.min(...itemsWithTargetYear.map((it) => Number(it.target_year)));
    const readinessRow = buildSuccessionReadinessRow({
      clientId, periodEnd, targetYear, latestValuation: valuations?.[0] || null, today,
    });
    if (readinessRow) rows.push(readinessRow);
  }

  // Succession pathway — who takes over, independent of whether a target
  // year has been set at all.
  if (allExitItems.length) {
    const pathwayRow = buildSuccessionPathwayRow({ clientId, periodEnd, items: allExitItems, today });
    if (pathwayRow) rows.push(pathwayRow);
  }

  if (!rows.length) return [];
  const { data, error } = await supabase.from('risk_items').insert(rows).select('id');
  if (error) throw error;
  return (data || []).map((r) => r.id);
}

module.exports = { syncOwnerWealthRiskItems, OWNER_ESTATE_CHECKLIST_ITEMS, OWNER_EXIT_READINESS_ITEMS };
