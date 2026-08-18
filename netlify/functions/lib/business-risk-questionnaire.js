// netlify/functions/lib/business-risk-questionnaire.js
//
// Business Risk Questionnaire (Source B of Risk Review)
// ------------------------------------------------------------------
// 8 categories (people, customers, suppliers, operations, financial,
// legal, insurance, technology — same 8 buckets industry risk uses, see
// industry-risk-checklist.js's SYSTEM_PROMPT), each with a FLAT list of
// independent questions — no anchor/follow-up hierarchy. People's 3
// questions are peers: "Is the business heavily dependent on the owner?",
// "Is there a key employee who couldn't be replaced?", "Any recruitment/
// retention issues?" — each answered and synthesized on its own, not one
// gating whether the others even show.
//
// Questions aren't all phrased the same direction ("Is the business
// dependent on the owner?" — yes = risk — vs "Is cash sufficient?" — yes =
// NOT a risk), so each carries its own risk_if_yes flag and the branching
// logic reads that instead of assuming yes always means risk.
//
// Adaptive resurfacing: a category is only put in front of the accountant
// again if at least one of its questions has never been asked, was last
// reviewed over 12 months ago, or is currently an active risk (Watch/
// Identified) that needs a status check.
//
// The accountant can also add a new question to a category (defaults to
// risk_if_yes=true — "yes" indicating risk is the far more common
// direction) or delete one (soft-delete via active=false, so historical
// risk_items answers aren't orphaned).
//
// Same lib/ placement as the other two Risk Review sources — not a
// Netlify function itself, required from manual-entry.js and
// read-data.js. Uses this app's Supabase client, client_id (uuid) +
// period_end (date) — not a raw pg pool with integer client/period ids.
// Run migration_risk_items_v3.sql (risk_questions + risk_items.notes),
// migration_risk_items_v4.sql (risk_items.recommendation),
// migration_risk_items_v5.sql (risk_items.question_id), and
// migration_risk_items_v6.sql (risk_questions.active) before wiring this
// in.

const { synthesizeRiskItem } = require('./risk-item-synthesis');

const RESURFACE_AFTER_DAYS = 365; // 12 months

// Seed data — run seedQuestions() once (safe to re-run — it skips
// anything already there, matched on category + question_text, so
// adding a new question to this bank later and re-running only inserts
// what's new). Flat per category: no anchor, just a list of questions.
const QUESTION_BANK = {
  people: [
    { text: 'Is the business heavily dependent on the owner?', riskIfYes: true },
    { text: 'Is there a key employee the business couldn\'t easily replace?', riskIfYes: true },
    { text: 'Any recruitment/retention issues?', riskIfYes: true },
  ],
  customers: [
    { text: 'Is a significant amount of revenue dependent on one customer?', riskIfYes: true },
    { text: 'Have you lost or potentially lost a major customer?', riskIfYes: true },
  ],
  suppliers: [
    { text: 'Is the business dependent on a key supplier?', riskIfYes: true },
    { text: 'Any supply/pricing issues?', riskIfYes: true },
  ],
  operations: [
    { text: 'Could the business continue if the owner was unavailable for 3 months?', riskIfYes: false },
    { text: 'Are critical processes documented?', riskIfYes: false },
  ],
  financial: [
    { text: 'Is cash sufficient?', riskIfYes: false },
    { text: 'Is debt manageable?', riskIfYes: false },
    { text: 'Any upcoming major funding requirements?', riskIfYes: true },
  ],
  legal: [
    { text: 'Any outstanding legal issues?', riskIfYes: true },
    { text: 'Licences/compliance concerns?', riskIfYes: true },
    { text: 'Employment issues?', riskIfYes: true },
  ],
  insurance: [
    { text: 'Is insurance current and adequate?', riskIfYes: false },
    { text: 'Are key assets protected?', riskIfYes: false },
  ],
  technology: [
    { text: 'Are critical systems backed up?', riskIfYes: false },
    { text: 'Any recent cyber/security concerns?', riskIfYes: true },
  ],
};

// Updates risk_if_yes/sort_order on already-seeded questions too, not just
// insert-if-missing — the old anchor/follow-up model hardcoded every
// follow-up to risk_if_yes=true regardless of actual phrasing (e.g. "Are
// critical processes documented?" is backwards under that assumption —
// yes there means NOT a risk), so a database seeded before this flattening
// needs those corrected values applied, not silently skipped because a
// row with that question_text already exists. Keeps the existing row's id
// stable either way (risk_items.question_id references it).
async function seedQuestions(supabase) {
  for (const [category, questions] of Object.entries(QUESTION_BANK)) {
    for (let i = 0; i < questions.length; i++) {
      const { text, riskIfYes } = questions[i];
      const { data: existing } = await supabase
        .from('risk_questions').select('id')
        .eq('category', category).eq('question_text', text)
        .maybeSingle();
      if (existing) {
        const { error } = await supabase.from('risk_questions')
          .update({ risk_if_yes: riskIfYes, sort_order: i, active: true }).eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('risk_questions').insert({
          category, question_text: text, risk_if_yes: riskIfYes, sort_order: i,
        });
        if (error) throw error;
      }
    }
  }
}

// Determine which categories should be presented to the accountant this
// cycle, and return ALL of each qualifying category's active questions
// (flat, not just the ones individually due) so the frontend can show the
// whole category together — some questions may already have a saved
// answer (rendered with its result + an Edit link), others still need
// one, but they're always shown as one set, e.g. "People: Q1, Q2, Q3."
//
// A category qualifies if ANY of its questions has never been asked, is
// stale (>12mo since last reviewed), or is a currently open risk (Watch/
// Identified) worth a status check regardless of age.
async function getCategoriesForReview(supabase, clientId) {
  const { data: questions, error } = await supabase
    .from('risk_questions')
    .select('id, category, question_text, risk_if_yes')
    .eq('active', true).order('category').order('sort_order');
  if (error) throw error;

  const byCategory = {};
  (questions || []).forEach((q) => { (byCategory[q.category] = byCategory[q.category] || []).push(q); });

  const { data: allRows } = await supabase
    .from('risk_items')
    .select('question_id, status, last_reviewed_date')
    .eq('client_id', clientId).eq('source', 'business')
    .order('last_reviewed_date', { ascending: false });
  const latestByQuestion = {};
  (allRows || []).forEach((r) => { if (!latestByQuestion[r.question_id]) latestByQuestion[r.question_id] = r; });

  const needsReview = (q) => {
    const latest = latestByQuestion[q.id];
    if (!latest) return true;
    const ageDays = (Date.now() - new Date(latest.last_reviewed_date)) / 86400000;
    const isOpenRisk = latest.status === 'Watch' || latest.status === 'Identified';
    return isOpenRisk || ageDays > RESURFACE_AFTER_DAYS;
  };

  const result = [];
  for (const [category, categoryQuestions] of Object.entries(byCategory)) {
    if (categoryQuestions.some(needsReview)) {
      result.push({ category, questions: categoryQuestions });
    }
  }
  return result;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// is_new/is_changed vs the most recent PRIOR review of this EXACT
// question (identified by question_id — excluding this exact period, so
// re-submitting the same period to fix a mistake doesn't compare against
// the row it's about to replace).
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

// Answer one question. riskPresent = (answer === question.risk_if_yes) —
// each question carries its own direction, see QUESTION_BANK.
//
// No risk: writes one quiet row (status='Managed', no recommendation;
// index.html's riskItemRow renders this as a plain "reviewed, no risk"
// line, not a full risk card).
//
// Risk present: the answer gets turned into an actual write-up via
// synthesizeRiskItem (risk-item-synthesis.js) — risk_name, detail, and a
// recommendation, not the question text echoed back.
//
// Either way, deletes only THIS question's existing row before inserting
// — re-saving/editing one question must not touch any of its sibling
// questions' rows in the same category. Also clears any pre-flattening
// legacy row for this same category with question_id IS NULL — those
// predate this schema (a single row spoke for the whole category, back
// when there was one anchor question) and would otherwise sit alongside
// a fresh per-question answer as an orphaned duplicate forever, since
// nothing else ever revisits them.
async function submitQuestionAnswer(supabase, { clientId, periodEnd, category, question, answer, notes }) {
  const riskPresent = answer === question.risk_if_yes;
  const newStatus = riskPresent ? 'Identified' : 'Managed';

  const { isNew, isChanged } = await computeNewChanged(supabase, {
    clientId, periodEnd, category, questionId: question.id, newStatus,
  });

  const { error: delError } = await supabase
    .from('risk_items').delete()
    .eq('client_id', clientId).eq('period_end', periodEnd)
    .eq('source', 'business').eq('category', category)
    .or(`question_id.eq.${question.id},question_id.is.null`);
  if (delError) throw delError;

  const today = new Date().toISOString().slice(0, 10);

  if (!riskPresent) {
    const row = {
      client_id: clientId, period_end: periodEnd, source: 'business', question_id: question.id,
      category, risk_name: `${capitalize(category)} — no risk identified`,
      detail: question.question_text, status: 'Managed', severity: 'Low', last_reviewed_date: today,
      is_new: isNew, is_changed: isChanged,
    };
    const { data: inserted, error } = await supabase.from('risk_items').insert(row).select().single();
    if (error) throw error;
    return { riskPresent: false, item: inserted };
  }

  const synthesized = await synthesizeRiskItem({ category, questionText: question.question_text, answerText: notes });

  const row = {
    client_id: clientId, period_end: periodEnd, source: 'business', question_id: question.id,
    category, risk_name: synthesized.risk_name, detail: synthesized.detail,
    recommendation: synthesized.recommendation, notes: `Q: ${question.question_text}\nA: ${notes || '(no detail given)'}`,
    status: 'Identified', severity: synthesized.severity || 'Medium', last_reviewed_date: today,
    is_new: isNew, is_changed: isChanged,
  };
  const { data: inserted, error } = await supabase.from('risk_items').insert(row).select().single();
  if (error) throw error;
  return { riskPresent: true, item: inserted };
}

// Adds a new question to a category — shows up in getCategoriesForReview
// like any seeded question, same flat treatment, same AI synthesis when
// answered yes. Defaults risk_if_yes to true (the far more common
// direction — "yes" indicating a risk) since there's no natural way to
// infer the intended direction from free text alone; the accountant can
// still say so explicitly.
async function addQuestion(supabase, { category, questionText, riskIfYes = true }) {
  const { data, error } = await supabase
    .from('risk_questions')
    .insert({ category, question_text: questionText, risk_if_yes: riskIfYes, sort_order: 999 })
    .select().single();
  if (error) throw error;
  return data;
}

// Soft-delete — a real DELETE would either fail (risk_items.question_id
// references it) or silently orphan real client answers. active=false
// just stops it from being offered/resurfaced; existing risk_items rows
// for it are untouched.
async function deleteQuestion(supabase, { questionId }) {
  const { error } = await supabase.from('risk_questions').update({ active: false }).eq('id', questionId);
  if (error) throw error;
  return { deleted: true };
}

module.exports = {
  seedQuestions,
  getCategoriesForReview,
  submitQuestionAnswer,
  addQuestion,
  deleteQuestion,
  QUESTION_BANK,
};
