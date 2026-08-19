// netlify/functions/lib/valuation-multiple.js
//
// Business Valuation Multiple — AI-suggested, cached, accountant-editable
// ------------------------------------------------------------------
// Suggests a typical EBITDA multiple for a client's industry, caches the
// suggestion so identical industries don't re-hit the AI every time, and
// hands it back for the Growth domain's valuation card to pre-fill — the
// accountant always confirms or overrides it before saving. Same trust
// model as industry-risk-checklist.js: caveated, not treated as ground
// truth, and the caveat is baked into the AI's own output, not left to
// surrounding UI text alone.
//
// Not a Netlify function itself — no exports.handler. Lives in lib/ so it
// can be require()'d from read-data.js.
//
// DB: this app's Supabase client (passed in by the caller), not a raw pg
// pool. Schema: run migration_business_valuations.sql first
// (business_valuations + industry_valuation_multiple_cache).

const MODEL = 'claude-sonnet-4-6'; // matches the model used elsewhere (analyze.js, industry-risk-checklist.js, tax-question.js)
const CACHE_MAX_AGE_DAYS = 180; // regenerate periodically in case AI quality/coverage improves

const SYSTEM_PROMPT = `You suggest a typical EBITDA multiple for valuing a small business, for internal/advisory discussion — not a formal valuation.

Given an industry and a brief business description, return ONE defensible multiple (not a range) for a business of this type/size, plus a one-line rationale.
The rationale must itself state this is general guidance, not a formal valuation — don't rely on surrounding UI text to carry that caveat.

Respond with ONLY JSON, no markdown fences, no preamble:
{ "suggested_multiple": number, "rationale": "one sentence" }`;

// Normalize free-text industry into a cache key — same loose approach as
// industry-risk-checklist.js's normalizeIndustryKey (lowercase, trim,
// collapse whitespace), not a real taxonomy.
function normalizeIndustryKey(industryText) {
  return industryText.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Calls Claude to generate a multiple + rationale for a given industry.
// Throws if the response isn't parseable/well-formed JSON — caller should
// catch and skip (don't silently write garbage into business_valuations).
async function generateMultipleViaAI(industryText, businessDescription) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Industry: ${industryText}\nBusiness: ${businessDescription || 'not described'}` }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = (data.content || []).map((block) => block.text || '').join('').trim();
  const cleaned = text.replace(/^```json\s*|```$/g, '').trim();

  const parsed = JSON.parse(cleaned); // let this throw — caller decides how to handle
  if (typeof parsed.suggested_multiple !== 'number' || !parsed.rationale) {
    throw new Error('Malformed AI response — expected { suggested_multiple, rationale }');
  }
  return parsed;
}

// Get a multiple for this industry, using the cache if fresh, otherwise
// generating via AI and caching the result. businessDescription is only
// used on a cache MISS (to give the AI call more context) — the cache key
// itself stays industry-only, matching industry_valuation_multiple_cache's
// schema and the same granularity industry-risk-checklist.js already
// caches at.
async function getOrGenerateMultiple(supabase, industryText, businessDescription) {
  const key = normalizeIndustryKey(industryText);

  const { data: cached } = await supabase
    .from('industry_valuation_multiple_cache')
    .select('suggested_multiple, rationale, generated_at')
    .eq('industry_key', key)
    .maybeSingle();

  if (cached) {
    const ageDays = (Date.now() - new Date(cached.generated_at)) / 86400000;
    if (ageDays < CACHE_MAX_AGE_DAYS) return { suggested_multiple: cached.suggested_multiple, rationale: cached.rationale };
  }

  const result = await generateMultipleViaAI(industryText, businessDescription);

  const { error } = await supabase
    .from('industry_valuation_multiple_cache')
    .upsert(
      { industry_key: key, suggested_multiple: result.suggested_multiple, rationale: result.rationale, generated_at: new Date().toISOString() },
      { onConflict: 'industry_key' }
    );
  if (error) throw error;

  return result;
}

module.exports = {
  getOrGenerateMultiple,
  normalizeIndustryKey, // exported for testing / manual cache warm-up
};
