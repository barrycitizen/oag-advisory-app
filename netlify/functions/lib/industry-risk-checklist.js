// netlify/functions/lib/industry-risk-checklist.js
//
// Industry Risk Checklist — AI-generated (Source C of Risk Review)
// ------------------------------------------------------------------
// Generates an industry-specific risk checklist from a client's free-text
// industry field, caches the checklist so identical industries don't
// re-hit the AI every period, and writes rows into the shared
// `risk_items` table with source='industry', status='Unknown'.
//
// Same trust model as this app's existing AI benchmark estimates:
// caveated as "not verified", not treated as ground truth.
//
// Not a Netlify function itself — no exports.handler, so netlify-cli
// doesn't register it as its own endpoint. Lives in lib/ (a plain
// subdirectory, not top-level in functions/) purely so it can be
// require()'d from manual-entry.js.
//
// DB: this app's Supabase client (see manual-entry.js), not a raw pg
// pool. Schema: run migration_risk_items.sql first (risk_items +
// industry_risk_checklist_cache).

const MODEL = 'claude-sonnet-4-6'; // matches the model used elsewhere (analyze.js, suggest-goal.js, tax-question.js)
const CACHE_MAX_AGE_DAYS = 180; // regenerate periodically in case AI quality/coverage improves

const SYSTEM_PROMPT = `You produce industry-specific business risk checklists for small business advisers.

Given an industry description, return 5-9 risks that are SPECIFIC to that industry
- not generic risks like "cash flow" or "competition" that apply to any business.
Think about what a trade/industry association or an experienced adviser in that
specific field would flag that a generic financial-ratio scan would never surface.

Respond with ONLY a JSON array, no markdown fences, no preamble. Each item:
{
  "risk_name": "short label, 2-5 words",
  "category": "one of: people, customers, suppliers, operations, financial, legal, insurance, technology",
  "detail": "one sentence explaining why this matters for this specific industry"
}`;

// Normalize free-text industry into a cache key. Deliberately loose
// (lowercase, trim, collapse whitespace) rather than a real taxonomy —
// good enough to catch "Automotive Repair" vs "automotive repair " without
// needing the full industry taxonomy build (see ideas.md).
function normalizeIndustryKey(industryText) {
  return industryText.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Calls Claude to generate a checklist for a given industry. Throws if the
// response isn't parseable JSON — caller should catch and skip (don't
// silently write garbage into risk_items).
async function generateChecklistViaAI(industryText) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Industry: ${industryText}` }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = (data.content || []).map((block) => block.text || '').join('').trim();
  const cleaned = text.replace(/^```json\s*|```$/g, '').trim();

  const parsed = JSON.parse(cleaned); // let this throw — caller decides how to handle
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array from AI response');
  return parsed;
}

// Get a checklist for this industry, using the cache if fresh, otherwise
// generating via AI and caching the result.
async function getOrGenerateChecklist(supabase, industryText) {
  const key = normalizeIndustryKey(industryText);

  const { data: cached } = await supabase
    .from('industry_risk_checklist_cache')
    .select('checklist_json, generated_at')
    .eq('industry_key', key)
    .maybeSingle();

  if (cached) {
    const ageDays = (Date.now() - new Date(cached.generated_at)) / 86400000;
    if (ageDays < CACHE_MAX_AGE_DAYS) return cached.checklist_json;
  }

  const checklist = await generateChecklistViaAI(industryText);

  const { error } = await supabase
    .from('industry_risk_checklist_cache')
    .upsert({ industry_key: key, checklist_json: checklist, generated_at: new Date().toISOString() }, { onConflict: 'industry_key' });
  if (error) throw error;

  return checklist;
}

// Main entry point. Call this when a new period is saved and the client has
// no industry risk_items yet (see manual-entry.js's saveFinancials) — don't
// re-run every period, the cache above is for identical industries across
// clients, not for skipping repeat calls for the same client.
//
// Writes one risk_items row per checklist item, status='Unknown' so it
// shows up for accountant review rather than being presented as fact.
async function generateIndustryRiskItems(supabase, { clientId, periodEnd, industryText }) {
  if (!industryText || !industryText.trim()) {
    return []; // no industry set — nothing to generate, don't fail the caller
  }

  const checklist = await getOrGenerateChecklist(supabase, industryText);

  const rows = checklist.map((item) => ({
    client_id: clientId,
    period_end: periodEnd,
    source: 'industry',
    category: item.category,
    risk_name: item.risk_name,
    detail: item.detail,
    status: 'Unknown',
    severity: 'Medium',
  }));

  const { data, error } = await supabase.from('risk_items').insert(rows).select('id');
  if (error) throw error;
  return (data || []).map((r) => r.id);
}

module.exports = {
  generateIndustryRiskItems,
  getOrGenerateChecklist, // exported for testing / manual cache warm-up
  normalizeIndustryKey,
};
