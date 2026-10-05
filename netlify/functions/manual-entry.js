// netlify/functions/manual-entry.js
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { generateIndustryRiskItems } = require('./lib/industry-risk-checklist');
const { submitQuestionAnswer, addQuestion, deleteQuestion, unanswerQuestion } = require('./lib/business-risk-questionnaire');
const { applyReviewAction } = require('./lib/risk-review-actions');
const { syncOwnerWealthRiskItems } = require('./lib/owner-wealth-risk-sync');

// fy_end is required (not just business_name) because the frontend derives every
// valid period-end date from cadence + fy_end — without it, Input has no dates to offer.
async function addClient(body) {
  const { business_name, industry, cadence, fy_end } = body;
  if (!business_name || !fy_end) throw new Error('business_name and fy_end required');

  const client_id = randomUUID();
  const row = {
    client_id,
    business_description: business_name,
    industry: industry || null,
    cadence: cadence || 'quarterly',
    fy_end,
    profile_extra: { business_name },
  };

  const { error } = await supabase.from('client_context').insert(row);
  if (error) throw error;
  return row;
}

// Deletes a period's snapshot plus everything analyze.js derived from it. Scoped
// to the financial/analysis tables only — deliberately leaves owner_goals (which
// nests goal items/check-ins under the same period_end inside client_context)
// untouched, since goals aren't "analysis" and a user deleting a bad snapshot
// shouldn't lose unrelated goal-setting work recorded against that period.
async function deletePeriod(body) {
  const { client_id, period_end } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');

  const tables = ['flags', 'pillar_scores', 'health_scores', 'diagnostics', 'recommendations', 'financial_snapshots'];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq('client_id', client_id).eq('period_end', period_end);
    if (error) throw error;
  }
  return { deleted: true, period_end };
}

// Soft-delete: hides a client from the default list without touching any of
// their data. Reversible via unarchiveClient — this is the everyday "remove
// a client" action; deleteClient below is a separate, deliberate hard-delete.
async function archiveClient(body) {
  const { client_id } = body;
  if (!client_id) throw new Error('client_id required');
  const { error } = await supabase.from('client_context').update({ is_archived: true }).eq('client_id', client_id);
  if (error) throw error;
  return { archived: true };
}

async function unarchiveClient(body) {
  const { client_id } = body;
  if (!client_id) throw new Error('client_id required');
  const { error } = await supabase.from('client_context').update({ is_archived: false }).eq('client_id', client_id);
  if (error) throw error;
  return { archived: false };
}

// Permanent, irreversible — every row this client_id touches across every
// client-scoped table, then the client_context row itself last (owner_goals
// lives nested inside that row's JSONB, so no separate delete needed for
// it). kpi_library/risk_questions/industry_*_cache are shared reference
// tables, not client-scoped, and are untouched. Only reachable from an
// already-archived client in the UI, as a last-resort cleanup rather than
// the everyday "remove a client" action (see archiveClient above).
async function deleteClient(body) {
  const { client_id } = body;
  if (!client_id) throw new Error('client_id required');

  const tables = [
    'flags', 'pillar_scores', 'health_scores', 'diagnostics', 'recommendations',
    'financial_snapshots', 'business_valuations', 'owner_wealth_snapshots',
    'action_items', 'risk_items', 'xero_connections',
  ];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq('client_id', client_id);
    if (error) throw error;
  }
  const { error } = await supabase.from('client_context').delete().eq('client_id', client_id);
  if (error) throw error;
  return { deleted: true };
}

const FINANCIAL_FIELDS = [
  'revenue', 'cogs', 'operating_expenses', 'net_profit', 'wages',
  'debtors', 'creditors', 'cash', 'current_assets', 'current_liabilities',
  'total_debt', 'equity', 'inventory', 'operating_cash_flow', 'tax_expense',
  'interest_expense', 'depreciation_amortisation', 'other_income', 'other_expenses',
  'total_assets', 'total_liabilities', 'fixed_assets',
  'owner_drawings', 'funds_introduced', 'director_loan_balance',
  'loan_repayments', 'equipment_purchases', 'capital_works_deduction', 'nbv_assets_sold', 'one_off_loan_repayment',
  'new_borrowing', 'interest_capitalised',
];

// Trading divisions — the P&L/working-capital fields a typical multi-division
// business (shared bank account, one tax return, one balance sheet) can
// actually report separately per division. inventory is included alongside
// debtors/creditors despite being a balance-sheet line, same reasoning as
// those two: it's generated/held by each division's own trading (separate
// premises, separate stock), not a shared entity-level financing resource
// like cash/equity/total debt — same test that put debtors/creditors here
// rather than with those. Everything else on financial_snapshots stays
// entity-level only, entered once regardless of divisions.
const DIVISION_TRADING_FIELDS = ['revenue', 'cogs', 'wages', 'operating_expenses', 'debtors', 'creditors', 'inventory'];

// Cleans this period's per-division figures against the client's own
// defined division ids (client_context.divisions) — any incoming row whose
// division_id isn't one of THIS client's real divisions is dropped rather
// than saved, same "don't trust the client's shape" posture the rest of
// this file already takes. gross_profit is server-derived per division,
// exactly mirroring how the entity-level row derives its own gross_profit
// below — never trusted from the client.
function cleanDivisionBreakdown(breakdown, validDivisionIds) {
  if (!Array.isArray(breakdown) || !validDivisionIds.size) return [];
  return breakdown
    .filter((d) => d && validDivisionIds.has(d.division_id))
    .map((d) => {
      const entry = { division_id: d.division_id };
      for (const field of DIVISION_TRADING_FIELDS) {
        const val = d[field];
        entry[field] = (val === '' || val === undefined || val === null) ? null : Number(val);
      }
      entry.gross_profit = (entry.revenue == null || entry.cogs == null) ? null : entry.revenue - entry.cogs;
      return entry;
    });
}

// Null-safe sum across divisions for one field — mirrors sumOwnerWealthItems'
// spirit but must stay null (not 0) when EVERY division left a field blank,
// so a KPI needing it still honestly reports Unavailable rather than
// silently computing off a fabricated zero total.
function sumDivisionField(breakdown, field) {
  const values = breakdown.map((d) => d[field]).filter((v) => v != null);
  return values.length ? values.reduce((sum, v) => sum + v, 0) : null;
}

async function saveFinancials(body) {
  const { client_id, period_end } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');

  const { data: context } = await supabase.from('client_context').select('cadence, industry, divisions').eq('client_id', client_id).single();

  const row = {
    client_id, period_end, source: 'manual', synced_at: new Date().toISOString(),
    cadence: context?.cadence || 'quarterly',
  };
  // NULL for "left blank" vs a real 0 — a KPI needing this field can then
  // honestly show Unavailable instead of silently calculating off a fake zero.
  for (const field of FINANCIAL_FIELDS) {
    const val = body[field];
    row[field] = (val === '' || val === undefined || val === null) ? null : Number(val);
  }
  row.gross_profit = (row.revenue == null || row.cogs == null) ? null : row.revenue - row.cogs;

  // Splitting by division is a PER-PERIOD choice, not a permanent switch a
  // client gets locked into once any division is defined — real history
  // mixes years where the source document broke figures out by division
  // with years it didn't (or where the accountant just doesn't have that
  // breakdown for that year). So this only engages when the caller actually
  // sends a non-empty division_breakdown for THIS save; the six trading
  // fields above are then never trusted from whatever was sent directly for
  // them — always overwritten with the server-computed sum, so the two can
  // never drift out of sync. A period saved without a division_breakdown
  // (blended, or a client with no divisions at all) keeps its directly-sent
  // field values untouched, exactly as before divisions existed — and
  // row.division_breakdown is explicitly nulled so re-saving a period that
  // previously WAS split, now blended, actually clears the stale split data
  // rather than leaving it orphaned.
  // "Has real data" means at least one division has at least one non-null
  // trading field — not just a non-empty array. A caller can send one row
  // per configured division with every field blank (e.g. a review screen
  // that always renders a row per division regardless of whether this
  // particular document had a split) — that's still "nothing to split",
  // not a signal to zero out the entity totals below.
  const validDivisionIds = new Set((context?.divisions || []).map((d) => d.id));
  const divisionBreakdown = validDivisionIds.size ? cleanDivisionBreakdown(body.division_breakdown, validDivisionIds) : [];
  const hasRealDivisionData = divisionBreakdown.some((d) => DIVISION_TRADING_FIELDS.some((f) => d[f] != null));
  if (hasRealDivisionData) {
    row.division_breakdown = divisionBreakdown;
    for (const field of DIVISION_TRADING_FIELDS) {
      row[field] = sumDivisionField(divisionBreakdown, field);
    }
    row.gross_profit = sumDivisionField(divisionBreakdown, 'gross_profit');
  } else {
    row.division_breakdown = null;
  }

  // Ad-hoc named items for the cash reconciliation panel (e.g. "Insurance
  // payout $15,000") — free-form, since we can't anticipate every one-off
  // that might explain a period's residual. Only set when the caller
  // actually sends this (the recon panel's own save button does; other save
  // paths, like Manual Entry's main form, don't touch it and leave it as-is).
  // section tags which category (capex/borrowings/owner/other) the item was
  // added under — defaults to 'other' for anything missing/invalid so it
  // still lands somewhere sensible rather than being silently dropped.
  // Only the AMOUNT decides whether a row is real — a filled-in amount with
  // no description used to get silently dropped here for lacking a label
  // (while the save still reported success), which is exactly the kind of
  // silent data loss this app's null-vs-zero philosophy exists to avoid.
  // A blank label now gets a generic placeholder instead of losing the row.
  const CASH_RECON_SECTIONS = ['capex', 'borrowings', 'owner', 'other'];
  if (Array.isArray(body.cash_recon_adjustments)) {
    row.cash_recon_adjustments = body.cash_recon_adjustments
      .filter((a) => a && a.amount !== '' && a.amount != null)
      .map((a) => ({
        label: String(a.label || '').trim().slice(0, 80) || 'Other item',
        amount: Number(a.amount),
        section: CASH_RECON_SECTIONS.includes(a.section) ? a.section : 'other',
      }));
  }

  const { error } = await supabase.from('financial_snapshots').upsert(row, { onConflict: 'client_id,period_end' });
  if (error) throw error;

  // Industry Risk Checklist (Source C of Risk Review) — generated once per
  // client, on whichever period first has both an industry on file and no
  // industry risk_items yet. Not re-run on every save (see the count check)
  // — that's what industry_risk_checklist_cache is for across CLIENTS, this
  // guard is for not repeating it for the SAME client every period. Failures
  // here are logged, not thrown — an AI hiccup must never block a financials
  // save. See netlify/functions/lib/industry-risk-checklist.js.
  if (context?.industry) {
    const { count } = await supabase
      .from('risk_items')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client_id)
      .eq('source', 'industry');
    if (!count) {
      try {
        await generateIndustryRiskItems(supabase, { clientId: client_id, periodEnd: period_end, industryText: context.industry });
      } catch (err) {
        console.error('Industry risk checklist generation failed:', err.message);
      }
    }
  }

  return row;
}

// Business valuation (Growth domain) — upserts one row per client/period,
// same shape as saveFinancials: server computes the derived field
// (valuation_amount) rather than trusting a client-sent total. See
// netlify/functions/lib/valuation-multiple.js for how ai_suggested_multiple
// gets suggested in the first place.
async function saveValuation(body) {
  const { client_id, period_end, ebitda, ai_suggested_multiple, multiple_used } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');
  if (ebitda == null || multiple_used == null) throw new Error('ebitda and multiple_used required');

  const row = {
    client_id, period_end,
    ebitda: Number(ebitda),
    ai_suggested_multiple: ai_suggested_multiple != null ? Number(ai_suggested_multiple) : null,
    multiple_used: Number(multiple_used),
    valuation_amount: Number(ebitda) * Number(multiple_used),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('business_valuations').upsert(row, { onConflict: 'client_id,period_end' });
  if (error) throw error;
  return row;
}

// Owner Wealth domain — personal net worth tiles, upserted one row per
// client/year. No server-computed derived field this time (unlike
// saveValuation's valuation_amount) — just the raw tiles; the net worth
// total is computed client-side from these (see computeNetWorthTotal,
// index.html) since it needs no data this function doesn't already have.
// Each bucket is now a list of named items (e.g. multiple super funds,
// multiple properties) rather than one lump-sum number — mirrors
// financial_snapshots.cash_recon_adjustments' shape. The plain numeric
// columns (super_balance etc.) are kept and still drive everything else
// that reads this table (computeNetWorthTotal, the Retirement Outlook, the
// trend chart) — they're just server-computed as the sum of each bucket's
// items now, instead of trusted from a client-typed lump sum, same
// "derived, not trusted" pattern saveValuation already uses for
// valuation_amount.
function cleanOwnerWealthItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && it.value !== '' && it.value != null && !isNaN(Number(it.value)))
    .map((it) => ({ label: String(it.label || '').trim() || 'Item', value: Number(it.value) }));
}
function sumOwnerWealthItems(items) {
  return items.reduce((sum, it) => sum + it.value, 0);
}

// User-named boxes beyond the fixed five — each picks asset or liability so
// the client knows which way to net it, same as the built-in buckets do
// implicitly (debt subtracts, everything else adds).
function cleanOwnerCustomBuckets(buckets) {
  if (!Array.isArray(buckets)) return [];
  return buckets.map((b) => ({
    id: String(b?.id || '').trim() || `custom-${Math.random().toString(36).slice(2, 10)}`,
    label: String(b?.label || '').trim() || 'Untitled box',
    type: b?.type === 'liability' ? 'liability' : 'asset',
    items: cleanOwnerWealthItems(b?.items),
  }));
}

// A small fixed checklist (Will/EPOA/buy-sell/key-person insurance,
// defined client-side in index.html's OWNER_ESTATE_CHECKLIST_ITEMS) — no
// server-side key validation, same reasoning as custom_buckets not
// validating labels: keeps the two in sync without a backend change if the
// item list ever grows.
function cleanEstateChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((it) => it && it.key)
    .map((it) => ({
      key: String(it.key),
      status: ['yes', 'no', 'unknown'].includes(it.status) ? it.status : 'unknown',
      notes: String(it.notes || '').trim() || null,
    }));
}

// Same shape as the estate checklist, but yes/partial/no/unknown (not just
// yes/no) — these are genuinely gradient questions (recurring revenue,
// management depth) where "partial" is a real, common answer, not a cop-out.
function cleanExitReadinessChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((it) => it && it.key)
    .map((it) => ({
      key: String(it.key),
      status: ['yes', 'partial', 'no', 'unknown'].includes(it.status) ? it.status : 'unknown',
      notes: String(it.notes || '').trim() || null,
    }));
}

async function saveOwnerWealth(body) {
  const { client_id, period_end, super_items, investments_items, property_items, other_assets_items, debt_items, custom_buckets, estate_planning_checklist, exit_readiness_checklist, notes } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');

  const superItems = cleanOwnerWealthItems(super_items);
  const investmentsItems = cleanOwnerWealthItems(investments_items);
  const propertyItems = cleanOwnerWealthItems(property_items);
  const otherItems = cleanOwnerWealthItems(other_assets_items);
  const debtItems = cleanOwnerWealthItems(debt_items);
  const customBuckets = cleanOwnerCustomBuckets(custom_buckets);
  const estateChecklist = cleanEstateChecklist(estate_planning_checklist);
  const exitReadinessChecklist = cleanExitReadinessChecklist(exit_readiness_checklist);

  // NULL for "no items entered" vs a real 0 — same null-vs-zero convention
  // saveFinancials uses, so an unset bucket can honestly show as "not
  // entered" rather than silently counting as zero net worth in that bucket.
  const row = {
    client_id, period_end,
    super_items: superItems, super_balance: superItems.length ? sumOwnerWealthItems(superItems) : null,
    investments_items: investmentsItems, investments: investmentsItems.length ? sumOwnerWealthItems(investmentsItems) : null,
    property_items: propertyItems, property: propertyItems.length ? sumOwnerWealthItems(propertyItems) : null,
    other_assets_items: otherItems, other_assets: otherItems.length ? sumOwnerWealthItems(otherItems) : null,
    debt_items: debtItems, debt: debtItems.length ? sumOwnerWealthItems(debtItems) : null,
    custom_buckets: customBuckets,
    estate_planning_checklist: estateChecklist,
    exit_readiness_checklist: exitReadinessChecklist,
    notes: notes || null, updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('owner_wealth_snapshots').upsert(row, { onConflict: 'client_id,period_end' });
  if (error) throw error;

  // Risk Review, Source D — mirrors estate checklist gaps and succession
  // readiness into risk_items so they're visible from Risk, not just on
  // Owner Wealth's own card. Non-fatal: an issue here must never take down
  // the save itself, same guard Source A (financial) uses.
  try {
    await syncOwnerWealthRiskItems(supabase, { clientId: client_id, periodEnd: period_end });
  } catch (err) {
    console.error('Owner wealth risk sync failed:', err.message);
  }

  return row;
}

// Saves the partner/beneficiary split (or single Sole trader/Company income
// adjustment) from the Current tax position card's estimate panel — a
// narrow, single-column update rather than routing through saveFinancials'
// full-row upsert, so clicking "Save this split" can never touch the
// actual financial fields on this snapshot. The row must already exist
// (the card only renders once a snapshot with net_profit is on file), so
// this is always an update, never an insert. null clears a previously
// saved split back to nothing, same "goes back to nil" affordance as the
// card's own toggle.
async function saveTaxStructureSplit(body) {
  const { client_id, period_end, tax_structure_split } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');
  const { error } = await supabase
    .from('financial_snapshots')
    .update({ tax_structure_split: tax_structure_split || null })
    .eq('client_id', client_id).eq('period_end', period_end);
  if (error) throw error;
  return { ok: true };
}

// Saves the Growth outlook "model a scenario" card's assumptions — same
// narrow single-column update as saveTaxStructureSplit above, and same
// "null clears it back to nil" convention. Unlike that split, this is
// called on every keystroke (debounced client-side, see scheduleGrowthOutlookSave
// in index.html) rather than behind an explicit Save button — this never
// feeds the Tax pillar score or AI diagnosis, it's a pure what-if display,
// so there's no real-vs-scenario ambiguity to protect against by waiting
// for a deliberate click the way tax_structure_split does.
async function saveGrowthOutlookScenario(body) {
  const { client_id, period_end, growth_outlook_scenario } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');
  const { error } = await supabase
    .from('financial_snapshots')
    .update({ growth_outlook_scenario: growth_outlook_scenario || null })
    .eq('client_id', client_id).eq('period_end', period_end);
  if (error) throw error;
  return { ok: true };
}

// Not client-scoped, deliberately — see migration_tax_rates_by_fy.sql's own
// comment. One row per FY; saving the same fy again overwrites just that
// row (a genuine correction to that year's own figures), never any other
// year's already-saved numbers.
async function saveTaxRatesByFY(body) {
  const { fy, rates } = body;
  if (!fy || !rates) throw new Error('fy and rates required');
  const { error } = await supabase.from('tax_rates_by_fy').upsert({ fy, rates, updated_at: new Date().toISOString() });
  if (error) throw error;
  return { ok: true };
}

// Deletes one saved year. The client refuses to call this for the LAST
// remaining year (see index.html's delete handler) — taxRatesForFY needs at
// least one entry to fall back to, so an empty table would break every tax
// estimate app-wide, not just for whoever deleted it.
async function deleteTaxRatesByFY(body) {
  const { fy } = body;
  if (!fy) throw new Error('fy required');
  const { error } = await supabase.from('tax_rates_by_fy').delete().eq('fy', fy);
  if (error) throw error;
  return { ok: true };
}

// Trading divisions are managed here (Profile), not re-typed each period —
// a client's fixed list of {id, name}. No server-side id generation on a
// missing id (same posture as cleanOwnerCustomBuckets): the frontend
// generates a stable id when a division is first added, this just guards
// against one somehow arriving without one.
function cleanDivisions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((d) => ({
      id: String(d?.id || '').trim() || `div-${Math.random().toString(36).slice(2, 10)}`,
      name: String(d?.name || '').trim(),
    }))
    .filter((d) => d.name);
}

async function saveContext(body) {
  const { client_id } = body;
  if (!client_id) throw new Error('client_id required');

  const updatable = ['business_description', 'industry', 'key_contact', 'adviser', 'cadence', 'entity_type', 'structure_notes', 'fy_end'];
  const update = {};
  for (const field of updatable) {
    if (body[field] !== undefined) update[field] = body[field] === '' ? null : body[field];
  }
  if (body.profile_extra !== undefined) update.profile_extra = body.profile_extra;
  if (body.divisions !== undefined) update.divisions = cleanDivisions(body.divisions);

  const { error } = await supabase.from('client_context').update(update).eq('client_id', client_id);
  if (error) throw error;
  return update;
}

// Risk Review, Source B — each question in a category is submitted
// separately (anchor's no-risk answer is its own call; each follow-up
// answered is its own call), not bundled into one category-wide save. See
// lib/business-risk-questionnaire.js for the anchor/follow-up/resurfacing
// logic; these just unpack the request body.
// Every question in a category is independent — this handles exactly one,
// whether or not the answer indicates a risk. `question` carries its own
// risk_if_yes, since not all questions are phrased the same direction.
async function saveBusinessQuestionAnswer(body) {
  const { client_id, period_end, category, question, answer, notes } = body;
  if (!client_id || !period_end || !category || !question) throw new Error('client_id, period_end, category and question required');
  if (typeof answer !== 'boolean') throw new Error('answer (boolean) required');
  return submitQuestionAnswer(supabase, {
    clientId: client_id, periodEnd: period_end, category, question, answer, notes: notes || '',
  });
}

async function saveAddBusinessQuestion(body) {
  const { category, question_text, risk_if_yes } = body;
  if (!category || !question_text) throw new Error('category and question_text required');
  return addQuestion(supabase, { category, questionText: question_text, riskIfYes: risk_if_yes !== false });
}

async function saveDeleteBusinessQuestion(body) {
  const { question_id } = body;
  if (!question_id) throw new Error('question_id required');
  return deleteQuestion(supabase, { questionId: question_id });
}

async function saveUnanswerBusinessQuestion(body) {
  const { client_id, risk_item_id } = body;
  if (!client_id || !risk_item_id) throw new Error('client_id and risk_item_id required');
  return unanswerQuestion(supabase, { clientId: client_id, riskItemId: risk_item_id });
}

// Risk Review actions (Confirm / Investigate / Not applicable / No longer
// a risk) — what gives status meaning after a risk_items row is created.
// See lib/risk-review-actions.js. Works on any row regardless of source
// (financial/business/industry), since the same four actions apply to all.
async function saveRiskReviewAction(body) {
  const { risk_item_id, action, note } = body;
  if (!risk_item_id || !action) throw new Error('risk_item_id and action required');
  return applyReviewAction(supabase, { riskItemId: risk_item_id, action, note });
}

// Permanent delete — until this, the only way to remove a risk_items row at
// all was "Unanswer" on a Business-sourced item (which resets a question,
// see saveUnanswerBusinessQuestion above), so Financial/Industry/Owner
// Wealth items had no removal path whatsoever. Works on any source. No
// separate confirmation server-side — the button that calls this already
// confirms with the user first (see the .risk-delete-btn handler).
async function deleteRiskItem(body) {
  const { risk_item_id, client_id } = body;
  if (!risk_item_id || !client_id) throw new Error('risk_item_id and client_id required');
  const { error } = await supabase.from('risk_items').delete().eq('id', risk_item_id).eq('client_id', client_id);
  if (error) throw error;
  return { deleted: true };
}

// Goals are period-scoped, like financial_snapshots: each period_end gets its own
// copy of each category's items, inside owner_goals.periods[period_end].cats[category].
// Still no schema change — owner_goals stays one jsonb column, just nested one level
// deeper. The frontend resolves "carry forward from a prior period" itself (it already
// has the whole owner_goals blob from get_context) and always sends the full items
// array for the period it's currently viewing.
async function saveGoalItems(body) {
  const { client_id, period_end, category, items } = body;
  if (!client_id || !period_end || !category || !Array.isArray(items)) throw new Error('client_id, period_end, category and items[] required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  const periods = goals.periods || {};
  const period = periods[period_end] || {};
  const cats = period.cats || {};
  cats[category] = { items };
  periods[period_end] = { ...period, cats };
  goals.periods = periods;

  const { error } = await supabase.from('client_context').update({ owner_goals: goals }).eq('client_id', client_id);
  if (error) throw error;

  // exit_succession is the one goal category Owner Wealth's risk sync also
  // reads (target_year, succession_pathway, successor_readiness) — re-sync
  // on save here too, not just on Owner Wealth's own save, so editing a
  // succession pathway in Goals shows up in Risk right away rather than
  // waiting for the next unrelated Owner Wealth save. Non-fatal, same
  // guard the sync's other call site uses.
  if (category === 'exit_succession') {
    try {
      await syncOwnerWealthRiskItems(supabase, { clientId: client_id, periodEnd: period_end });
    } catch (err) {
      console.error('Owner wealth risk sync failed:', err.message);
    }
  }

  return cats[category];
}

// One check-in per period (overwrites if re-saved same period) rather than an
// ever-growing log — mirrors financial_snapshots' one-row-per-period shape.
async function savePulse(body) {
  const { client_id, period_end, answers } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  const periods = goals.periods || {};
  const period = periods[period_end] || {};
  periods[period_end] = { ...period, pulse: { date: new Date().toISOString().slice(0, 10), ...answers } };
  goals.periods = periods;

  const { error } = await supabase.from('client_context').update({ owner_goals: goals }).eq('client_id', client_id);
  if (error) throw error;
  return periods[period_end].pulse;
}

// The durable copy of a meeting's brief — one entry per period_end, same
// shape localStorage already used (created_at, currentStep, priorities[],
// currentIndex, completed, actionsPushedCount, prioritiesPushed). Called on
// every meeting save (not just at the end), so Supabase — not the browser —
// is the actual source of truth: resuming works from any device, and a
// cleared cache no longer loses an in-progress or even a finished meeting.
// record: null clears that period's entry (used when starting a fresh
// meeting discards the old one).
async function saveMeetingRecord(body) {
  const { client_id, period_end, record } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');

  const { data: existing } = await supabase.from('client_context').select('meeting_records').eq('client_id', client_id).single();
  const records = existing?.meeting_records || {};
  if (record === null) {
    delete records[period_end];
  } else {
    records[period_end] = record;
  }

  const { error } = await supabase.from('client_context').update({ meeting_records: records }).eq('client_id', client_id);
  if (error) throw error;
  // Always a truthy value — the outer dispatcher treats a falsy result as
  // "no handler matched" and returns a generic 400, which a clear (record:
  // null, correctly resulting in nothing left at that key) would otherwise
  // trigger even though it succeeded.
  return { ok: true, record: records[period_end] || null };
}

// Dismiss/suggested-target state for the various "recommendation" surfaces
// (Financial flags, KPI improvement tips, Diagnose/Growth recommendations) —
// same reuse-a-jsonb-column-keyed-by-period_end shape as owner_goals.periods
// and meeting_records above. None of these have a real database id of their
// own (they're derived fresh from that period's diagnostics/kpi_report each
// time), so rec_id is an opaque string the caller builds from whatever IS
// stable about that item — a flag's own message text, a KPI's key, a
// recommendation's title.
async function saveRecommendationState(body) {
  const { client_id, period_end, rec_id, dismissed, suggested_target, decision, action_id } = body;
  if (!client_id || !period_end || !rec_id) throw new Error('client_id, period_end and rec_id required');

  const { data: existing } = await supabase.from('client_context').select('recommendation_state').eq('client_id', client_id).single();
  const state = existing?.recommendation_state || {};
  const period = state[period_end] || { dismissed: {}, suggestedTargets: {} };
  // Accept / Discuss / Reject on a recommendation (same rec_id keying as
  // dismissed), plus the action_items id an Accept created — so accepting
  // twice, or un-accepting and re-accepting, never spawns a duplicate action.
  if (!period.decisions) period.decisions = {};
  if (!period.actionIds) period.actionIds = {};
  if (decision !== undefined) {
    if (decision === null) delete period.decisions[rec_id];
    else if (['accepted', 'discuss', 'rejected'].includes(decision)) period.decisions[rec_id] = decision;
    else throw new Error('decision must be accepted, discuss, rejected or null');
  }
  if (action_id !== undefined) {
    if (action_id === null) delete period.actionIds[rec_id];
    else period.actionIds[rec_id] = action_id;
  }
  if (dismissed !== undefined) {
    if (dismissed) period.dismissed[rec_id] = true;
    else delete period.dismissed[rec_id];
  }
  if (suggested_target !== undefined) {
    if (suggested_target === null) delete period.suggestedTargets[rec_id];
    else period.suggestedTargets[rec_id] = suggested_target;
  }
  state[period_end] = period;

  const { error } = await supabase.from('client_context').update({ recommendation_state: state }).eq('client_id', client_id);
  if (error) throw error;
  return { ok: true, period_state: period };
}

const CUSTOM_CATEGORY_COLORS = ['#5C7A63', '#9C7A3C', '#8A9A6D', '#C08A5E', '#9C4B3C', '#B27358'];

function slugify(label) {
  return (label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'goal';
}

// Custom goal categories a client-facing user adds beyond the 5 built-in ones —
// stored the same way (owner_goals.custom_categories), no schema change needed.
async function addGoalCategory(body) {
  const { client_id, label } = body;
  if (!client_id || !label) throw new Error('client_id and label required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  const categories = goals.custom_categories || [];

  let key = slugify(label);
  let n = 2;
  while (categories.some((c) => c.key === key)) { key = `${slugify(label)}_${n}`; n += 1; }

  const category = { key, label, color: CUSTOM_CATEGORY_COLORS[categories.length % CUSTOM_CATEGORY_COLORS.length] };
  categories.push(category);
  goals.custom_categories = categories;

  const { error } = await supabase.from('client_context').update({ owner_goals: goals }).eq('client_id', client_id);
  if (error) throw error;
  return category;
}

// Custom check-in questions — the question itself persists and reappears every
// visit (unlike answers, which are always blank), stored in owner_goals.custom_questions.
async function addGoalQuestion(body) {
  const { client_id, prompt, phase } = body;
  if (!client_id || !prompt) throw new Error('client_id and prompt required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  const questions = goals.custom_questions || [];

  // phase drives which Meeting Mode wizard step this question appears in
  // (see FIXED_QUESTIONS/renderMeetingQuestionsStep in index.html) — 'open'
  // is the fallback both here and everywhere phase is read, so an older
  // client sending no phase at all still behaves exactly as before.
  const question = { id: 'q_' + Date.now(), prompt, phase: phase === 'close' ? 'close' : 'open' };
  questions.push(question);
  goals.custom_questions = questions;

  const { error } = await supabase.from('client_context').update({ owner_goals: goals }).eq('client_id', client_id);
  if (error) throw error;
  return question;
}

// Custom categories get fully deleted (definition + any recorded items). The 5
// built-in ones aren't deletable outright — they're the app's own framework, not
// user data — so this just hides them per-client instead, and they can be restored.
async function deleteGoalCategory(body) {
  const { client_id, key } = body;
  if (!client_id || !key) throw new Error('client_id and key required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  const isCustom = (goals.custom_categories || []).some((c) => c.key === key);
  if (isCustom) {
    goals.custom_categories = goals.custom_categories.filter((c) => c.key !== key);
    delete goals[key];
  } else {
    goals.hidden_categories = [...new Set([...(goals.hidden_categories || []), key])];
  }

  const { error } = await supabase.from('client_context').update({ owner_goals: goals }).eq('client_id', client_id);
  if (error) throw error;
  return { deleted: true };
}

async function restoreGoalCategory(body) {
  const { client_id, key } = body;
  if (!client_id || !key) throw new Error('client_id and key required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  goals.hidden_categories = (goals.hidden_categories || []).filter((k) => k !== key);

  const { error } = await supabase.from('client_context').update({ owner_goals: goals }).eq('client_id', client_id);
  if (error) throw error;
  return { restored: true };
}

async function deleteGoalQuestion(body) {
  const { client_id, id } = body;
  if (!client_id || !id) throw new Error('client_id and id required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  goals.custom_questions = (goals.custom_questions || []).filter((q) => q.id !== id);

  const { error } = await supabase.from('client_context').update({ owner_goals: goals }).eq('client_id', client_id);
  if (error) throw error;
  return { deleted: true };
}

// Edits a question's wording — custom questions get their stored prompt updated
// directly; the 4 fixed ones (whose text lives in frontend JS, not the DB) get an
// override recorded so the app knows to show different text for that id.
async function editGoalQuestion(body) {
  const { client_id, id, prompt } = body;
  if (!client_id || !id || !prompt) throw new Error('client_id, id and prompt required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  const customIdx = (goals.custom_questions || []).findIndex((q) => q.id === id);
  if (customIdx >= 0) {
    goals.custom_questions[customIdx] = { ...goals.custom_questions[customIdx], prompt };
  } else {
    goals.question_overrides = { ...(goals.question_overrides || {}), [id]: prompt };
  }

  const { error } = await supabase.from('client_context').update({ owner_goals: goals }).eq('client_id', client_id);
  if (error) throw error;
  return { id, prompt };
}

const ACTION_ITEM_STATUSES = ['not_started', 'in_progress', 'done'];
const ACTION_ITEM_OWNERS = ['Client', 'Adviser'];

// Create when no id is given, update when one is — same single-endpoint
// shape as risk_review_action rather than a separate create/update pair,
// since every field (text/status/priority/owner/due_date) is editable
// either way and the caller already knows whether it has an id.
async function saveActionItem(body) {
  const { id, client_id, text, source, priority, status, owner, due_date, why } = body;
  if (!client_id) throw new Error('client_id required');
  const cleanStatus = ACTION_ITEM_STATUSES.includes(status) ? status : 'not_started';
  const row = {
    text: String(text || '').trim(),
    status: cleanStatus,
    priority: priority || null,
    owner: ACTION_ITEM_OWNERS.includes(owner) ? owner : null,
    due_date: due_date || null,
    why: why || null,
    updated_at: new Date().toISOString(),
    completed_at: cleanStatus === 'done' ? new Date().toISOString() : null,
  };
  if (!row.text) throw new Error('text required');

  if (id) {
    // Keep the ORIGINAL completion time when an already-done item is edited
    // (text, owner, etc.) — re-stamping it "now" made "done since last
    // meeting" (index.html's computeActionProgress) count old work as new.
    if (cleanStatus === 'done') {
      const { data: prev } = await supabase.from('action_items').select('status, completed_at').eq('id', id).eq('client_id', client_id).maybeSingle();
      if (prev?.status === 'done' && prev.completed_at) row.completed_at = prev.completed_at;
    }
    const { data, error } = await supabase.from('action_items').update(row).eq('id', id).eq('client_id', client_id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('action_items')
    .insert({ ...row, client_id, source: source || 'manual' }).select().single();
  if (error) throw error;
  return data;
}

async function deleteActionItem(body) {
  const { id, client_id } = body;
  if (!id || !client_id) throw new Error('id and client_id required');
  const { error } = await supabase.from('action_items').delete().eq('id', id).eq('client_id', client_id);
  if (error) throw error;
  return { deleted: true };
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    if (!body.type) return { statusCode: 400, body: 'type required' };

    const result = body.type === 'financials' ? await saveFinancials(body)
      : body.type === 'add_client' ? await addClient(body)
      : body.type === 'delete_period' ? await deletePeriod(body)
      : body.type === 'context' ? await saveContext(body)
      : body.type === 'save_tax_structure_split' ? await saveTaxStructureSplit(body)
      : body.type === 'save_growth_outlook_scenario' ? await saveGrowthOutlookScenario(body)
      : body.type === 'save_tax_rates_by_fy' ? await saveTaxRatesByFY(body)
      : body.type === 'delete_tax_rates_by_fy' ? await deleteTaxRatesByFY(body)
      : body.type === 'business_risk_question_answer' ? await saveBusinessQuestionAnswer(body)
      : body.type === 'business_risk_question_add' ? await saveAddBusinessQuestion(body)
      : body.type === 'business_risk_question_delete' ? await saveDeleteBusinessQuestion(body)
      : body.type === 'business_risk_question_unanswer' ? await saveUnanswerBusinessQuestion(body)
      : body.type === 'risk_review_action' ? await saveRiskReviewAction(body)
      : body.type === 'delete_risk_item' ? await deleteRiskItem(body)
      : body.type === 'goal_items' ? await saveGoalItems(body)
      : body.type === 'pulse' ? await savePulse(body)
      : body.type === 'save_meeting_record' ? await saveMeetingRecord(body)
      : body.type === 'save_recommendation_state' ? await saveRecommendationState(body)
      : body.type === 'goal_category' ? await addGoalCategory(body)
      : body.type === 'goal_question' ? await addGoalQuestion(body)
      : body.type === 'delete_goal_category' ? await deleteGoalCategory(body)
      : body.type === 'restore_goal_category' ? await restoreGoalCategory(body)
      : body.type === 'delete_goal_question' ? await deleteGoalQuestion(body)
      : body.type === 'edit_goal_question' ? await editGoalQuestion(body)
      : body.type === 'save_valuation' ? await saveValuation(body)
      : body.type === 'save_owner_wealth' ? await saveOwnerWealth(body)
      : body.type === 'save_action_item' ? await saveActionItem(body)
      : body.type === 'delete_action_item' ? await deleteActionItem(body)
      : body.type === 'archive_client' ? await archiveClient(body)
      : body.type === 'unarchive_client' ? await unarchiveClient(body)
      : body.type === 'delete_client' ? await deleteClient(body)
      : null;

    if (!result) return { statusCode: 400, body: 'Unknown type' };

    return { statusCode: 200, body: JSON.stringify({ ok: true, saved: result }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
