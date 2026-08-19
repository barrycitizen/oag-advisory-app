// netlify/functions/manual-entry.js
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { generateIndustryRiskItems } = require('./lib/industry-risk-checklist');
const { submitQuestionAnswer, addQuestion, deleteQuestion, unanswerQuestion } = require('./lib/business-risk-questionnaire');
const { applyReviewAction } = require('./lib/risk-review-actions');

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

const FINANCIAL_FIELDS = [
  'revenue', 'cogs', 'operating_expenses', 'net_profit', 'wages',
  'debtors', 'creditors', 'cash', 'current_assets', 'current_liabilities',
  'total_debt', 'equity', 'inventory', 'operating_cash_flow', 'tax_expense',
  'interest_expense', 'depreciation_amortisation', 'other_income', 'other_expenses',
  'total_assets', 'total_liabilities', 'fixed_assets',
  'owner_drawings', 'funds_introduced', 'director_loan_balance',
  'loan_repayments', 'equipment_purchases',
];

async function saveFinancials(body) {
  const { client_id, period_end } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');

  const { data: context } = await supabase.from('client_context').select('cadence, industry').eq('client_id', client_id).single();

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

async function saveOwnerWealth(body) {
  const { client_id, period_end, super_items, investments_items, property_items, other_assets_items, debt_items, custom_buckets, notes } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');

  const superItems = cleanOwnerWealthItems(super_items);
  const investmentsItems = cleanOwnerWealthItems(investments_items);
  const propertyItems = cleanOwnerWealthItems(property_items);
  const otherItems = cleanOwnerWealthItems(other_assets_items);
  const debtItems = cleanOwnerWealthItems(debt_items);
  const customBuckets = cleanOwnerCustomBuckets(custom_buckets);

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
    notes: notes || null, updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('owner_wealth_snapshots').upsert(row, { onConflict: 'client_id,period_end' });
  if (error) throw error;
  return row;
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
  const { client_id, prompt } = body;
  if (!client_id || !prompt) throw new Error('client_id and prompt required');

  const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
  const goals = existing?.owner_goals || {};
  const questions = goals.custom_questions || [];

  const question = { id: 'q_' + Date.now(), prompt };
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

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    if (!body.type) return { statusCode: 400, body: 'type required' };

    const result = body.type === 'financials' ? await saveFinancials(body)
      : body.type === 'add_client' ? await addClient(body)
      : body.type === 'delete_period' ? await deletePeriod(body)
      : body.type === 'context' ? await saveContext(body)
      : body.type === 'business_risk_question_answer' ? await saveBusinessQuestionAnswer(body)
      : body.type === 'business_risk_question_add' ? await saveAddBusinessQuestion(body)
      : body.type === 'business_risk_question_delete' ? await saveDeleteBusinessQuestion(body)
      : body.type === 'business_risk_question_unanswer' ? await saveUnanswerBusinessQuestion(body)
      : body.type === 'risk_review_action' ? await saveRiskReviewAction(body)
      : body.type === 'goal_items' ? await saveGoalItems(body)
      : body.type === 'pulse' ? await savePulse(body)
      : body.type === 'goal_category' ? await addGoalCategory(body)
      : body.type === 'goal_question' ? await addGoalQuestion(body)
      : body.type === 'delete_goal_category' ? await deleteGoalCategory(body)
      : body.type === 'restore_goal_category' ? await restoreGoalCategory(body)
      : body.type === 'delete_goal_question' ? await deleteGoalQuestion(body)
      : body.type === 'edit_goal_question' ? await editGoalQuestion(body)
      : body.type === 'save_valuation' ? await saveValuation(body)
      : body.type === 'save_owner_wealth' ? await saveOwnerWealth(body)
      : null;

    if (!result) return { statusCode: 400, body: 'Unknown type' };

    return { statusCode: 200, body: JSON.stringify({ ok: true, saved: result }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
