// netlify/functions/lib/business-risk-questionnaire.js
//
// Business Risk Questionnaire (Source B of Risk Review)
// ------------------------------------------------------------------
// 8 categories (people, customers, suppliers, operations, financial,
// legal, insurance, technology — same 8 buckets industry risk uses, see
// industry-risk-checklist.js's SYSTEM_PROMPT), each with one anchor
// question + follow-ups that only appear if the anchor indicates a risk
// is present. Anchor questions aren't all phrased the same direction
// ("Is the business dependent on the owner?" — yes = risk — vs "Is cash
// sufficient?" — yes = NOT a risk), so each anchor carries its own
// risk_if_yes flag and the branching logic reads that instead of
// assuming yes always means risk.
//
// Adaptive resurfacing: a category is only put in front of the
// accountant again if it's never been asked, was last reviewed over 12
// months ago, or is currently an active risk (Watch/Identified) that
// needs a status check. A clean Managed category reviewed 2 months ago
// doesn't resurface.
//
// Same lib/ placement as the other two Risk Review sources — not a
// Netlify function itself, required from manual-entry.js and
// read-data.js. Uses this app's Supabase client, client_id (uuid) +
// period_end (date) — not a raw pg pool with integer client/period ids.
// Run migration_risk_items_v3.sql (risk_questions + risk_items.notes),
// migration_risk_items_v4.sql (risk_items.recommendation), and
// migration_risk_items_v5.sql (risk_items.question_id) before wiring
// this in.
//
// Each question in a category (anchor + its follow-ups) is answered and
// synthesized ONE AT A TIME, not bundled into a single category-wide
// submit — see submitAnchorNoRisk / submitFollowUpAnswer below, and
// index.html's sequential follow-up rendering in the Risk -> Analyse tab.

const { synthesizeRiskItem } = require('./risk-item-synthesis');

const RESURFACE_AFTER_DAYS = 365; // 12 months

// Seed data — run seedQuestions() once (safe to re-run — it skips
// anything already there, matched on category + question_text, so
// adding a new question to this bank later and re-running only inserts
// what's new).
const QUESTION_BANK = [
  {
    category: 'people',
    anchor: { text: 'Is the business heavily dependent on the owner?', riskIfYes: true },
    followUps: [
      'Is there a key employee the business couldn\'t easily replace?',
      'Any recruitment/retention issues?',
    ],
  },
  {
    category: 'customers',
    anchor: { text: 'Is a significant amount of revenue dependent on one customer?', riskIfYes: true },
    followUps: [
      'Have you lost or potentially lost a major customer?',
    ],
  },
  {
    category: 'suppliers',
    anchor: { text: 'Is the business dependent on a key supplier?', riskIfYes: true },
    followUps: [
      'Any supply/pricing issues?',
    ],
  },
  {
    category: 'operations',
    anchor: { text: 'Could the business continue if the owner was unavailable for 3 months?', riskIfYes: false },
    followUps: [
      'Are critical processes documented?',
    ],
  },
  {
    category: 'financial',
    anchor: { text: 'Is cash sufficient?', riskIfYes: false },
    followUps: [
      'Is debt manageable?',
      'Any upcoming major funding requirements?',
    ],
  },
  {
    category: 'legal',
    anchor: { text: 'Any outstanding legal issues?', riskIfYes: true },
    followUps: [
      'Licences/compliance concerns?',
      'Employment issues?',
    ],
  },
  {
    category: 'insurance',
    anchor: { text: 'Is insurance current and adequate?', riskIfYes: false },
    followUps: [
      'Are key assets protected?',
    ],
  },
  {
    category: 'technology',
    anchor: { text: 'Are critical systems backed up?', riskIfYes: false },
    followUps: [
      'Any recent cyber/security concerns?',
    ],
  },
];

async function seedQuestions(supabase) {
  for (const block of QUESTION_BANK) {
    const { data: existingAnchor } = await supabase
      .from('risk_questions').select('id')
      .eq('category', block.category).eq('question_text', block.anchor.text)
      .maybeSingle();

    let anchorId = existingAnchor?.id;
    if (!anchorId) {
      const { data: inserted, error } = await supabase
        .from('risk_questions')
        .insert({ category: block.category, question_text: block.anchor.text, is_anchor: true, risk_if_yes: block.anchor.riskIfYes, sort_order: 0 })
        .select('id').single();
      if (error) throw error;
      anchorId = inserted.id;
    }

    for (let i = 0; i < block.followUps.length; i++) {
      const text = block.followUps[i];
      const { data: existingFollowUp } = await supabase
        .from('risk_questions').select('id')
        .eq('category', block.category).eq('question_text', text)
        .maybeSingle();
      if (!existingFollowUp) {
        const { error } = await supabase.from('risk_questions').insert({
          category: block.category, question_text: text, is_anchor: false,
          risk_if_yes: true, depends_on_question_id: anchorId, sort_order: i + 1,
        });
        if (error) throw error;
      }
    }
  }
}

// Determine which categories should be presented to the accountant this
// cycle. Returns the anchor question for each category that qualifies —
// never asked, stale (>12mo since last review), or an open risk
// (Watch/Identified) worth a status check regardless of age.
async function getCategoriesForReview(supabase, clientId) {
  const { data: anchors, error } = await supabase
    .from('risk_questions')
    .select('id, category, question_text, risk_if_yes')
    .eq('is_anchor', true).order('sort_order');
  if (error) throw error;

  const toReview = [];
  for (const anchor of anchors || []) {
    const { data: latestRows } = await supabase
      .from('risk_items')
      .select('status, last_reviewed_date')
      .eq('client_id', clientId).eq('source', 'business').eq('category', anchor.category)
      .order('last_reviewed_date', { ascending: false }).limit(1);

    const latest = latestRows?.[0];
    if (!latest) { toReview.push(anchor); continue; }

    const ageDays = (Date.now() - new Date(latest.last_reviewed_date)) / 86400000;
    const isOpenRisk = latest.status === 'Watch' || latest.status === 'Identified';
    const isStale = ageDays > RESURFACE_AFTER_DAYS;
    if (isOpenRisk || isStale) toReview.push(anchor);
  }
  return toReview;
}

// Follow-ups for a category, for when the anchor answer indicates a risk
// is present (render these before final submit).
async function getFollowUpQuestions(supabase, anchorQuestionId) {
  const { data, error } = await supabase
    .from('risk_questions').select('id, question_text')
    .eq('depends_on_question_id', anchorQuestionId).order('sort_order');
  if (error) throw error;
  return data || [];
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// is_new/is_changed vs the most recent PRIOR review of this EXACT question
// (anchor or a specific follow-up, identified by question_id — excluding
// this exact period, so re-submitting the same period to fix a mistake
// doesn't compare against the row it's about to replace). Keyed per-
// question rather than per-category now that each question is its own
// row: "the key-employee answer changed" and "the recruitment answer
// changed" are different facts, not one shared category-level flag.
async function computeNewChanged(supabase, { clientId, periodEnd, category, questionId, newStatus }) {
  const { data: priorRows } = await supabase
    .from('risk_items')
    .select('status, last_reviewed_date')
    .eq('client_id', clientId).eq('source', 'business').eq('category', category).eq('question_id', questionId)
    .neq('period_end', periodEnd)
    .order('last_reviewed_date', { ascending: false }).limit(1);
  const priorRow = priorRows?.[0] || null;
  return { isNew: !priorRow, isChanged: !!priorRow && priorRow.status !== newStatus };
}

// Anchor answered "no risk" — writes one quiet row (status='Managed', no
// recommendation; index.html's riskItemRow renders this as a plain
// "reviewed, no risk" line, not a full risk card), tied to the anchor's
// own question_id.
//
// Deletes ALL of this category's existing rows for this period first, not
// just the anchor's own — if the accountant had previously answered "yes"
// and saved one or more follow-ups before changing their mind back to
// "no," those follow-up rows are now stale/contradictory and shouldn't
// survive alongside a fresh "no risk" verdict.
async function submitAnchorNoRisk(supabase, { clientId, periodEnd, anchor }) {
  const { isNew, isChanged } = await computeNewChanged(supabase, {
    clientId, periodEnd, category: anchor.category, questionId: anchor.id, newStatus: 'Managed',
  });

  const { error: delError } = await supabase
    .from('risk_items').delete()
    .eq('client_id', clientId).eq('period_end', periodEnd)
    .eq('source', 'business').eq('category', anchor.category);
  if (delError) throw delError;

  const row = {
    client_id: clientId, period_end: periodEnd, source: 'business', question_id: anchor.id,
    category: anchor.category, risk_name: `${capitalize(anchor.category)} — no risk identified`,
    detail: anchor.question_text, status: 'Managed', severity: 'Low', last_reviewed_date: new Date().toISOString().slice(0, 10),
    is_new: isNew, is_changed: isChanged,
  };
  const { data: inserted, error } = await supabase.from('risk_items').insert(row).select().single();
  if (error) throw error;
  return { riskPresent: false, item: inserted };
}

// One follow-up question, answered and synthesized on its own — the
// sequential flow (anchor -> follow-up 1 -> its own AI write-up ->
// follow-up 2 -> its own AI write-up, not all bundled into one form) means
// each question is submitted, and can be edited, independently of its
// siblings.
//
// Deletes rows matching THIS question_id (so re-saving/editing replaces
// rather than duplicates) OR the anchor's own question_id (clears a stale
// "no risk identified" row left over if the accountant had previously
// answered the anchor "no" and is now switching to "yes") — but leaves any
// OTHER follow-up's row in this category untouched, since those are
// answered independently and shouldn't be wiped out by this one saving.
async function submitFollowUpAnswer(supabase, { clientId, periodEnd, anchor, questionId, questionText, answerText }) {
  const { isNew, isChanged } = await computeNewChanged(supabase, {
    clientId, periodEnd, category: anchor.category, questionId, newStatus: 'Identified',
  });

  const { error: delError } = await supabase
    .from('risk_items').delete()
    .eq('client_id', clientId).eq('period_end', periodEnd)
    .eq('source', 'business').eq('category', anchor.category)
    .in('question_id', [questionId, anchor.id]);
  if (delError) throw delError;

  const synthesized = await synthesizeRiskItem({
    category: anchor.category, anchorQuestion: anchor.question_text,
    followUpQA: [{ questionText, answerText }],
  });

  const row = {
    client_id: clientId, period_end: periodEnd, source: 'business', question_id: questionId,
    category: anchor.category, risk_name: synthesized.risk_name, detail: synthesized.detail,
    recommendation: synthesized.recommendation, notes: `Q: ${questionText}\nA: ${answerText || '(no detail given)'}`,
    status: 'Identified', severity: synthesized.severity || 'Medium', last_reviewed_date: new Date().toISOString().slice(0, 10),
    is_new: isNew, is_changed: isChanged,
  };
  const { data: inserted, error } = await supabase.from('risk_items').insert(row).select().single();
  if (error) throw error;
  return { item: inserted };
}

module.exports = {
  seedQuestions,
  getCategoriesForReview,
  getFollowUpQuestions,
  submitAnchorNoRisk,
  submitFollowUpAnswer,
  QUESTION_BANK,
};
