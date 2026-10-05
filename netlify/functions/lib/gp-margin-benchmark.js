// netlify/functions/lib/gp-margin-benchmark.js
//
// Industry-typical GP margin range — AI-suggested, cached
// ------------------------------------------------------------------
// Feeds the Profitability pillar score's fallback (analyze-background.js's
// scoreProfitabilityPillar) for the common case where a client hasn't set
// their own GP margin target on Goals. Before this existed, that fallback
// was a single flat 15-45% range for every client regardless of industry —
// workable for a trades business, meaningless for a professional-services
// one that might normally run 60-70%. Same cache-per-industry pattern as
// valuation-multiple.js's getOrGenerateMultiple: identical industry strings
// across different clients share one cached lookup instead of re-hitting
// the AI every analysis run.
//
// Not a Netlify function itself — no exports.handler. Lives in lib/ so it
// can be require()'d from analyze-background.js.
//
// DB: this app's Supabase client (passed in by the caller). Schema: run
// migration_gp_margin_benchmark.sql first.

const MODEL = 'claude-sonnet-4-6'; // matches the model used elsewhere (analyze-background.js, valuation-multiple.js)
const CACHE_MAX_AGE_DAYS = 180; // same policy as valuation-multiple.js — regenerate periodically in case AI quality/coverage improves

const SYSTEM_PROMPT = `You suggest a typical gross profit margin RANGE for a small business, for internal/advisory discussion — a rough reference point, not a benchmark study.

Given an industry and a brief business description, return a defensible LOW and HIGH gross profit margin (as decimals, e.g. 0.30 for 30%) that a normal, healthy business of this type/size would typically fall between, plus a one-line rationale.
The rationale must itself state this is general guidance, not a verified benchmark — don't rely on surrounding UI text to carry that caveat.

Respond with ONLY JSON, no markdown fences, no preamble:
{ "typical_low": number, "typical_high": number, "rationale": "one sentence" }`;

// Same loose approach as valuation-multiple.js's normalizeIndustryKey
// (lowercase, trim, collapse whitespace), not a real taxonomy — duplicated
// here rather than shared, per this codebase's established per-file-
// independence convention.
function normalizeIndustryKey(industryText) {
  return industryText.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function generateBenchmarkViaAI(industryText, businessDescription) {
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
  if (typeof parsed.typical_low !== 'number' || typeof parsed.typical_high !== 'number' || parsed.typical_high <= parsed.typical_low || !parsed.rationale) {
    throw new Error('Malformed AI response — expected { typical_low, typical_high, rationale } with typical_high > typical_low');
  }
  return parsed;
}

// Get a GP margin benchmark for this industry, using the cache if fresh,
// otherwise generating via AI and caching the result. businessDescription
// is only used on a cache MISS (to give the AI call more context) — the
// cache key itself stays industry-only, same granularity
// industry_valuation_multiple_cache already uses.
async function getOrGenerateGpMarginBenchmark(supabase, industryText, businessDescription) {
  const key = normalizeIndustryKey(industryText);

  const { data: cached } = await supabase
    .from('industry_gp_margin_benchmark_cache')
    .select('typical_low, typical_high, rationale, generated_at')
    .eq('industry_key', key)
    .maybeSingle();

  if (cached) {
    const ageDays = (Date.now() - new Date(cached.generated_at)) / 86400000;
    if (ageDays < CACHE_MAX_AGE_DAYS) return { typical_low: cached.typical_low, typical_high: cached.typical_high, rationale: cached.rationale };
  }

  const result = await generateBenchmarkViaAI(industryText, businessDescription);

  const { error } = await supabase
    .from('industry_gp_margin_benchmark_cache')
    .upsert(
      { industry_key: key, typical_low: result.typical_low, typical_high: result.typical_high, rationale: result.rationale, generated_at: new Date().toISOString() },
      { onConflict: 'industry_key' }
    );
  if (error) throw error;

  return result;
}

module.exports = {
  getOrGenerateGpMarginBenchmark,
  normalizeIndustryKey, // exported for testing / manual cache warm-up
};
