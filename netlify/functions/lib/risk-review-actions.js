// netlify/functions/lib/risk-review-actions.js
//
// Risk Review Actions
// ------------------------------------------------------------------
// What was missing: risk_items get created (financial auto-detected,
// business questionnaire, industry AI checklist) but nothing let the
// accountant DO anything with them afterward — status/severity just sat
// there, decorative. This is what gives status a purpose: four actions,
// available on any risk_items row regardless of source, that move it to
// a different bucket and clear the New/Changed flags once it's been
// looked at.
//
//   Confirm            → this is a real, current risk the accountant is
//                         actively acknowledging → status = 'Identified'.
//   Investigate         → not enough info yet, needs follow-up before
//                         next period → status = 'Watch'.
//   Not applicable       → doesn't apply to this client → status =
//                         'Not applicable' — drops out of the rollup
//                         banner's active buckets, kept on file for
//                         history.
//   No longer a risk     → was a risk, now resolved → status = 'Managed'.
//
// Same lib/ placement as the other Risk Review sources — not a Netlify
// function itself, required from manual-entry.js.
//
// Confirming an industry-source item also triggers synthesizeIndustryRecommendation
// (risk-item-synthesis.js) — "is this real" and "what do we do about it" are
// two different questions, and the second is only worth asking (i.e. worth
// an AI call) once the first is answered yes. Financial/business rows
// already carry a recommendation from when they were created, so this only
// fires for industry and only when one isn't already set.

const { synthesizeIndustryRecommendation } = require('./risk-item-synthesis');

const VALID_ACTIONS = ['confirm', 'investigate', 'not_applicable', 'no_longer_a_risk'];

const ACTION_TO_STATUS = {
  confirm: 'Identified',
  investigate: 'Watch',
  not_applicable: 'Not applicable',
  no_longer_a_risk: 'Managed',
};

// Apply a review action to a single risk_items row.
//   await applyReviewAction(supabase, { riskItemId, action: 'confirm', note: 'Discussed in Aug meeting' });
async function applyReviewAction(supabase, { riskItemId, action, note }) {
  if (!VALID_ACTIONS.includes(action)) {
    throw new Error(`Invalid action "${action}". Must be one of: ${VALID_ACTIONS.join(', ')}`);
  }

  const newStatus = ACTION_TO_STATUS[action];
  const update = {
    status: newStatus, is_new: false, is_changed: false,
    last_reviewed_date: new Date().toISOString().slice(0, 10),
    updated_at: new Date().toISOString(),
  };
  // Only touches notes when a note was actually given — Supabase's update()
  // sets whatever keys are present, so unlike a SQL COALESCE this key is
  // just omitted entirely rather than passed as null, to leave existing
  // notes (e.g. the raw Q&A transcript from submitCategoryResponse) intact.
  if (note) update.notes = note;

  if (action === 'confirm') {
    const { data: current } = await supabase
      .from('risk_items').select('source, category, risk_name, detail, recommendation')
      .eq('id', riskItemId).single();
    if (current?.source === 'industry' && !current.recommendation) {
      try {
        const { recommendation } = await synthesizeIndustryRecommendation({
          category: current.category, riskName: current.risk_name, detail: current.detail,
        });
        update.recommendation = recommendation;
      } catch (err) {
        // Non-fatal — confirming the risk must still succeed even if the
        // AI call hiccups. The recommendation can always be generated on
        // a later confirm, since this only skips when one's missing.
        console.error('Industry recommendation synthesis failed:', err.message);
      }
    }
  }

  const { error } = await supabase.from('risk_items').update(update).eq('id', riskItemId);
  if (error) throw error;
  return { riskItemId, newStatus };
}

// Bulk version for a review screen where an accountant might clear several
// items in one sitting.
async function applyReviewActions(supabase, actions) {
  const results = [];
  for (const a of actions) results.push(await applyReviewAction(supabase, a));
  return results;
}

module.exports = { applyReviewAction, applyReviewActions, VALID_ACTIONS };
