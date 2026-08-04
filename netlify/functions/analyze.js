// netlify/functions/analyze.js
// Runs the deterministic rules engine (ratios, flags, pillar scoring) and then
// calls Claude for the diagnosis/advise narrative — matching the framework's
// separation of Analysis Engine (rules = your IP) from the AI narrative layer.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Which pillars are active at each cadence — mirrors the framework's cadence map.
const CADENCE_PILLARS = {
  quarterly: ['profitability', 'cash_flow', 'tax'],
  half_yearly: ['profitability', 'cash_flow', 'tax', 'growth', 'risk', 'systems_team'],
  annual: ['profitability', 'cash_flow', 'tax', 'growth', 'risk', 'systems_team', 'owner_wealth', 'owner_goals'],
};

function computeRatios(fs) {
  return {
    gp_margin: fs.revenue ? fs.gross_profit / fs.revenue : null,
    np_margin: fs.revenue ? fs.net_profit / fs.revenue : null,
    wages_pct: fs.revenue ? fs.wages / fs.revenue : null,
    debtor_days: fs.revenue ? (fs.debtors / fs.revenue) * 365 : null,
    creditor_days: fs.cogs ? (fs.creditors / fs.cogs) * 365 : null,
    current_ratio: fs.current_liabilities ? fs.current_assets / fs.current_liabilities : null,
    debt_to_equity: fs.equity ? fs.total_debt / fs.equity : null,
  };
}

function runFlags(ratios, priorRatios) {
  const flags = [];
  if (ratios.debtor_days && priorRatios?.debtor_days && ratios.debtor_days > priorRatios.debtor_days) {
    flags.push({ pillar: 'cash_flow', message: 'Debtor days trending up vs last period — check collections before assuming cash is fine.', severity: 'warning' });
  }
  if (ratios.gp_margin && priorRatios?.gp_margin && ratios.gp_margin < priorRatios.gp_margin - 0.03) {
    flags.push({ pillar: 'profitability', message: 'Gross margin dropped 3+ points — check pricing, labour, materials, waste.', severity: 'warning' });
  }
  if (ratios.current_ratio && ratios.current_ratio < 1) {
    flags.push({ pillar: 'cash_flow', message: 'Current ratio below 1 — short-term liabilities exceed short-term assets.', severity: 'danger' });
  }
  return flags;
}

// Simple 0-10 scoring off ratio thresholds — replace with your own bands over time.
function scorePillar(pillar, ratios) {
  const band = (val, good, ok) => (val == null ? null : val >= good ? 9 : val >= ok ? 6 : 3);
  switch (pillar) {
    case 'profitability': return band(ratios.gp_margin, 0.4, 0.25);
    case 'cash_flow': return band(ratios.current_ratio, 1.5, 1.0);
    case 'tax': return 8; // placeholder until BAS-variance logic is added
    default: return 6; // placeholder for pillars not yet ratio-driven
  }
}

exports.handler = async (event) => {
  try {
    const { client_id, period_end } = JSON.parse(event.body || '{}');
    if (!client_id || !period_end) return { statusCode: 400, body: 'client_id and period_end required' };

    const [{ data: fs }, { data: context }, { data: priorFsList }] = await Promise.all([
      supabase.from('financial_snapshots').select('*').eq('client_id', client_id).eq('period_end', period_end).single(),
      supabase.from('client_context').select('*').eq('client_id', client_id).single(),
      supabase.from('financial_snapshots').select('*').eq('client_id', client_id).lt('period_end', period_end).order('period_end', { ascending: false }).limit(1),
    ]);
    if (!fs) throw new Error('No financial snapshot found — run xero-pull first');

    const ratios = computeRatios(fs);
    const priorRatios = priorFsList?.[0] ? computeRatios(priorFsList[0]) : null;
    const flags = runFlags(ratios, priorRatios);
    const activePillars = CADENCE_PILLARS[context?.cadence || 'quarterly'];
    const scores = activePillars.map((p) => ({ pillar: p, score: scorePillar(p, ratios), active: true }));
    const healthScore = Math.round(
      (scores.reduce((sum, s) => sum + (s.score || 0), 0) / (10 * scores.length)) * 100
    );

    // Ask Claude for the diagnosis/advise narrative, grounded in the computed facts.
    const prompt = `You are the analysis engine for an accounting advisory app. Given this client's data, write:
1. A one-paragraph diagnosis (why the numbers look this way — reference the specific ratios/flags)
2. Up to 3 opportunities, each with expected impact, difficulty, and timeframe
3. Up to 3 risks worth raising
Respond ONLY as JSON: {"diagnosis": "...", "opportunities": [{"title":"","impact":"","difficulty":"","timeframe":""}], "risks": ["..."]}

Client: ${context?.business_description || 'no description'} (${context?.industry})
Cadence: ${context?.cadence}
Ratios: ${JSON.stringify(ratios)}
Flags fired: ${JSON.stringify(flags)}
Pillar scores: ${JSON.stringify(scores)}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    await Promise.all([
      supabase.from('flags').insert(flags.map((f) => ({ ...f, client_id, period_end }))),
      supabase.from('pillar_scores').insert(scores.map((s) => ({ ...s, client_id, period_end }))),
      supabase.from('health_scores').upsert({ client_id, period_end, score: healthScore, active_pillar_count: scores.length }, { onConflict: 'client_id,period_end' }),
      supabase.from('diagnostics').insert({ client_id, period_end, pillar: 'overall', cause_text: parsed.diagnosis }),
      supabase.from('recommendations').insert((parsed.opportunities || []).map((o) => ({
        client_id, period_end, title: o.title, impact: o.impact, difficulty: o.difficulty, timeframe: o.timeframe,
      }))),
    ]);

    return { statusCode: 200, body: JSON.stringify({ ratios, flags, scores, healthScore, ...parsed }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
