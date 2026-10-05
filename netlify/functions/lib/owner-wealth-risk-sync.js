// netlify/functions/lib/owner-wealth-risk-sync.js
//
// Owner Wealth Risk Sync (Source D of Risk Review)
// ------------------------------------------------------------------
// Turns the Succession & estate planning card's already-computed flags
// (estate checklist gaps, exit readiness gaps, succession readiness,
// succession pathway) into risk_items rows, so the same information —
// entered once on Owner Wealth → Input — is visible from Risk Review too,
// not just on that one card. "Enter once, feeds everywhere" is the
// principle; this is the wiring that makes it real for the first two
// things that needed it.
//
// PERSISTENT, not period-scoped — same model as business/industry (see
// read-data.js's get_risk_items), not financial's period-rebuilt model.
// This was originally built mirroring financial-risk-sync.js's
// delete-then-reinsert-every-sync pattern, which was the wrong model to
// copy: a will/EPOA/buy-sell/key-person-insurance gap is a static fact,
// not something that fluctuates period to period the way a financial
// ratio does, so treating it like Financial meant every unrelated Owner
// Wealth save (even just updating a super balance) wiped and rebuilt
// EVERY owner_wealth risk item, discarding any review status
// (Investigate/Not applicable) the accountant had set.
//
// At most one row per (client_id, risk_name) exists at a time for this
// source — an existing row is updated in place (review status preserved)
// rather than the whole set being deleted and reinserted. A risk that's no
// longer active gets auto-resolved to 'Managed' (kept for history, not
// deleted), same convention financial-risk-sync.js uses for a flag that
// stops firing. Succession readiness/pathway ARE still recalculated fresh
// every sync (target-year proximity genuinely changes as the calendar
// moves forward even if nothing else does) — the persistence model here
// is about STORAGE (one row, updated in place) not about freezing the
// content; only the review STATUS carries forward, not the detail text.
//
// Triggered from saveOwnerWealth (manual-entry.js) right after a save
// succeeds, and from Goals' exit_succession save — not from a separate
// "Run analysis" step. Owner Wealth is annual-cadence-only and isn't part
// of the financial period-analysis cycle, so the save itself is the
// natural sync moment.
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
    detail, severity: 'High', last_reviewed_date: today,
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
    detail, severity: 'High', last_reviewed_date: today,
  };
}

// Review status carries forward when an active row already exists —
// 'Identified' is excluded since it's every fresh row's own default
// (carrying it forward would be a no-op), and 'Managed' is excluded
// because if the same gap is active again despite being marked resolved,
// that past call was apparently wrong or temporary and deserves a fresh
// Identified look, not to stay silently hidden.
const OWNER_WEALTH_CARRY_FORWARD_STATUSES = new Set(['Watch', 'Not applicable']);

// clientId/periodEnd only — estateChecklist and succession data are always
// fetched fresh here rather than passed in, so this can be triggered from
// EITHER save path (Owner Wealth's own save, or a Goals exit_succession
// save) without either one needing to know about the other's data. That's
// what makes editing a succession pathway in Goals show up in Risk
// immediately, not just the next time Owner Wealth happens to be saved.
async function syncOwnerWealthRiskItems(supabase, { clientId, periodEnd }) {
  // Existing state for this client — read once, up front, so active items
  // can be diffed against it below (update-in-place vs insert vs
  // auto-resolve), instead of the old wipe-everything-then-rebuild.
  const { data: existingRows, error: fetchError } = await supabase
    .from('risk_items').select('id, risk_name, status')
    .eq('client_id', clientId).eq('source', 'owner_wealth');
  if (fetchError) throw fetchError;
  const existingByName = Object.fromEntries((existingRows || []).map((r) => [r.risk_name, r]));

  const [{ data: ctx }, { data: valuations }, { data: snapshot }] = await Promise.all([
    supabase.from('client_context').select('owner_goals, entity_type').eq('client_id', clientId).maybeSingle(),
    supabase.from('business_valuations').select('period_end, valuation_amount').eq('client_id', clientId).order('period_end', { ascending: false }).limit(1),
    supabase.from('owner_wealth_snapshots').select('estate_planning_checklist, exit_readiness_checklist').eq('client_id', clientId).eq('period_end', periodEnd).maybeSingle(),
  ]);
  const estateChecklist = snapshot?.estate_planning_checklist || [];
  const exitReadinessChecklist = snapshot?.exit_readiness_checklist || [];
  const entityType = ctx?.entity_type;

  const today = new Date().toISOString().slice(0, 10);
  // risk_name -> row payload (no status yet — resolved against existingByName below)
  const activeByName = {};

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
    activeByName[meta.label] = {
      client_id: clientId, period_end: periodEnd, source: 'owner_wealth',
      category: meta.category, risk_name: meta.label,
      detail: it.notes || 'Marked not in place on Owner Wealth\'s estate planning checklist.',
      severity: meta.severity, last_reviewed_date: today,
    };
  });

  // Exit readiness gaps — one row per item marked "No" (not "Partial" —
  // that's a real, non-trivial answer, not the same as an outright gap).
  (exitReadinessChecklist || []).forEach((it) => {
    if (it.status !== 'no') return;
    const meta = OWNER_EXIT_READINESS_ITEMS[it.key];
    if (!meta) return;
    activeByName[meta.label] = {
      client_id: clientId, period_end: periodEnd, source: 'owner_wealth',
      category: meta.category, risk_name: meta.label,
      detail: it.notes || 'Marked not in place on Owner Wealth\'s exit readiness checklist — reduces the business\'s attractiveness/value to a buyer.',
      severity: 'Medium', last_reviewed_date: today,
    };
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
    if (readinessRow) activeByName[readinessRow.risk_name] = readinessRow;
  }

  // Succession pathway — who takes over, independent of whether a target
  // year has been set at all.
  if (allExitItems.length) {
    const pathwayRow = buildSuccessionPathwayRow({ clientId, periodEnd, items: allExitItems, today });
    if (pathwayRow) activeByName[pathwayRow.risk_name] = pathwayRow;
  }

  const ids = [];

  // Active this sync: update the existing row in place (content refreshed,
  // review status preserved if it was Watch/Not applicable) or insert new
  // (fresh, so status defaults to Identified).
  for (const [riskName, payload] of Object.entries(activeByName)) {
    const existing = existingByName[riskName];
    if (existing) {
      const status = OWNER_WEALTH_CARRY_FORWARD_STATUSES.has(existing.status) ? existing.status : 'Identified';
      const { error } = await supabase.from('risk_items').update({ ...payload, status }).eq('id', existing.id);
      if (error) throw error;
      ids.push(existing.id);
    } else {
      const { data, error } = await supabase.from('risk_items').insert({ ...payload, status: 'Identified' }).select('id').single();
      if (error) throw error;
      ids.push(data.id);
    }
  }

  // No longer active (the gap closed, or the succession condition no
  // longer applies): auto-resolve rather than delete, so the history isn't
  // lost — same convention financial-risk-sync.js uses for a flag that
  // stops firing. Skipped once already Managed so a long-resolved item
  // doesn't get its last_reviewed_date bumped every single sync.
  for (const [riskName, existing] of Object.entries(existingByName)) {
    if (activeByName[riskName]) continue;
    if (existing.status === 'Managed') continue;
    const { error } = await supabase.from('risk_items')
      .update({ status: 'Managed', detail: 'Resolved — no longer applicable as of the latest Owner Wealth save.', last_reviewed_date: today })
      .eq('id', existing.id);
    if (error) throw error;
  }

  return ids;
}

module.exports = { syncOwnerWealthRiskItems, OWNER_ESTATE_CHECKLIST_ITEMS, OWNER_EXIT_READINESS_ITEMS };
