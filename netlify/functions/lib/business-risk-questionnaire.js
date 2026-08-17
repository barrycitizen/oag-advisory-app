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
// Run migration_risk_items_v3.sql before wiring this in (adds
// risk_questions + risk_items.notes).

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

// Submit a full category response in one call — anchor answer plus any
// follow-up answers (only present if the anchor indicated a risk).
//
// anchorAnswer: boolean (the literal yes/no answer given)
// followUpAnswers: [{ questionText, answerText }]
//
// If the anchor indicates no risk: writes ONE risk_items row,
// status='Managed', and skips follow-ups entirely (even if some were
// answered client-side by mistake — the anchor governs).
//
// If the anchor indicates a risk: writes one risk_items row per
// follow-up answered, status='Identified'.
//
// Deletes this category's existing risk_items for THIS exact period
// before inserting — re-submitting a category (accountant corrects an
// answer) must not pile up duplicates, same idempotency guard
// financial-risk-sync.js uses. Scoped to period_end + category so other
// periods' history (what getCategoriesForReview's staleness check
// reads) stays intact.
async function submitCategoryResponse(supabase, { clientId, periodEnd, anchor, anchorAnswer, followUpAnswers = [] }) {
  const riskPresent = anchorAnswer === anchor.risk_if_yes;

  // is_new/is_changed vs the most recent PRIOR review of this category
  // (excluding this exact period, so re-submitting the same period to fix
  // a mistake doesn't compare against the row it's about to replace) — same
  // idea as financial-risk-sync.js's previousByName, just keyed by category
  // since business reviews don't happen every period the way financial
  // does. Without this, every inserted row would default to is_new=true
  // forever (the column default), making a dashboard's "new this cycle"
  // count meaningless.
  const newStatus = riskPresent ? 'Identified' : 'Managed';
  const { data: priorRows } = await supabase
    .from('risk_items')
    .select('status, last_reviewed_date')
    .eq('client_id', clientId).eq('source', 'business').eq('category', anchor.category)
    .neq('period_end', periodEnd)
    .order('last_reviewed_date', { ascending: false }).limit(1);
  const priorRow = priorRows?.[0] || null;
  const isNew = !priorRow;
  const isChanged = !!priorRow && priorRow.status !== newStatus;

  const { error: delError } = await supabase
    .from('risk_items').delete()
    .eq('client_id', clientId).eq('period_end', periodEnd)
    .eq('source', 'business').eq('category', anchor.category);
  if (delError) throw delError;

  const today = new Date().toISOString().slice(0, 10);

  if (!riskPresent) {
    const { error } = await supabase.from('risk_items').insert({
      client_id: clientId, period_end: periodEnd, source: 'business',
      category: anchor.category, risk_name: `${capitalize(anchor.category)} — no risk identified`,
      detail: anchor.question_text, status: 'Managed', severity: 'Low', last_reviewed_date: today,
      is_new: isNew, is_changed: isChanged,
    });
    if (error) throw error;
    return { riskPresent: false, itemsWritten: 1 };
  }

  const rows = followUpAnswers.map((f) => ({
    client_id: clientId, period_end: periodEnd, source: 'business',
    category: anchor.category, risk_name: `${capitalize(anchor.category)} risk`,
    detail: f.questionText || anchor.question_text, notes: f.answerText,
    status: 'Identified', severity: 'Medium', last_reviewed_date: today,
    is_new: isNew, is_changed: isChanged,
  }));

  // If a risk was indicated but no follow-ups were answered, still record
  // the anchor-level risk so it isn't lost.
  if (!rows.length) {
    rows.push({
      client_id: clientId, period_end: periodEnd, source: 'business',
      category: anchor.category, risk_name: `${capitalize(anchor.category)} risk`,
      detail: anchor.question_text, status: 'Identified', severity: 'Medium', last_reviewed_date: today,
      is_new: isNew, is_changed: isChanged,
    });
  }

  const { error } = await supabase.from('risk_items').insert(rows);
  if (error) throw error;
  return { riskPresent: true, itemsWritten: rows.length };
}

module.exports = {
  seedQuestions,
  getCategoriesForReview,
  getFollowUpQuestions,
  submitCategoryResponse,
  QUESTION_BANK,
};
