// netlify/functions/suggest-goal.js
// Grounded goal suggestions — 2-3 candidates for one goal category, based on this
// client's real diagnosis/ratios/flags for the period, plus business context and
// their existing goals (so it doesn't just re-suggest what's already there).
// Never saved automatically — the frontend only ever offers these as text the
// user can choose to drop into a new goal, then edit and save themselves.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

const { createClient } = require('@supabase/supabase-js');
const { crossOriginRejection } = require('./lib/same-origin');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CATEGORY_LABELS = {
  personal: 'Personal', business: 'Business', income: 'Income',
  wealth: 'Wealth', exit_succession: 'Exit & Succession',
};

exports.handler = async (event) => {
  const refused = crossOriginRejection(event); // see lib/same-origin.js
  if (refused) return refused;
  try {
    const { client_id, period_end, category, category_label, focus, count } = JSON.parse(event.body || '{}');
    if (!client_id || !category) return { statusCode: 400, body: 'client_id and category required' };
    const n = count || 3;

    const [{ data: ctx }, { data: hsList }] = await Promise.all([
      supabase.from('client_context').select('business_description, industry, owner_goals').eq('client_id', client_id).single(),
      period_end
        ? supabase.from('health_scores').select('*').eq('client_id', client_id).eq('period_end', period_end).maybeSingle()
        : supabase.from('health_scores').select('*').eq('client_id', client_id).order('period_end', { ascending: false }).limit(1).maybeSingle(),
    ]);

    const targetPeriod = hsList?.period_end || period_end || null;
    let pillarScores = [];
    let flags = [];
    let diagnosis = null;
    if (targetPeriod) {
      const [{ data: ps }, { data: fl }, { data: diag }] = await Promise.all([
        supabase.from('pillar_scores').select('*').eq('client_id', client_id).eq('period_end', targetPeriod),
        supabase.from('flags').select('*').eq('client_id', client_id).eq('period_end', targetPeriod),
        supabase.from('diagnostics').select('*').eq('client_id', client_id).eq('period_end', targetPeriod).eq('pillar', 'overall').limit(1).maybeSingle(),
      ]);
      pillarScores = ps || [];
      flags = fl || [];
      diagnosis = diag?.cause_text || null;
    }

    // Every existing goal across every category/period, so suggestions don't just repeat them.
    const existingGoals = [];
    const periods = ctx?.owner_goals?.periods || {};
    Object.values(periods).forEach((p) => {
      Object.values(p.cats || {}).forEach((c) => {
        (c.items || []).forEach((it) => { if (it.text && !it.deleted) existingGoals.push(it.text); });
      });
    });
    const uniqueExistingGoals = [...new Set(existingGoals)];

    const label = category_label || CATEGORY_LABELS[category] || category;
    const focusLine = focus ? `\n\nFocus specifically on this flagged issue, not the category in general: "${focus}"` : '';

    const prompt = `You are helping an accountant suggest possible client goals — specifically for the "${label}" area.

Client: ${ctx?.business_description || 'no description on file'} (industry: ${ctx?.industry || 'not recorded'})
Health score this period: ${hsList?.score ?? 'not yet analysed'}/100
Pillar scores: ${JSON.stringify(pillarScores.map((p) => ({ pillar: p.pillar, score: p.score })))}
Flags this period: ${JSON.stringify(flags.map((f) => f.message))}
AI diagnosis: ${diagnosis || 'not yet generated for this period'}
Goals already recorded for this client (do not repeat these): ${uniqueExistingGoals.length ? JSON.stringify(uniqueExistingGoals) : 'none yet'}${focusLine}

Suggest ${n} specific, concrete goal idea${n > 1 ? 's' : ''} for the "${label}" area${focus ? ', addressing the focus above' : ''}. Ground ${n > 1 ? 'each one' : 'it'} in the real data above wherever it's relevant (health score, pillar scores, flags, diagnosis) rather than generic advice. If a suggestion leans on general knowledge of what's typical for this industry rather than this client's own numbers, say so plainly in the suggestion itself (e.g. "typically..." / "industry norms suggest..." — make clear it isn't verified benchmark data from real clients). Keep ${n > 1 ? 'each suggestion' : 'it'} to one or two sentences, written as something the client could actually adopt as a goal${focus ? ', ideally with a concrete number or target' : ''}.

Respond ONLY as JSON: {"suggestions": ["...", ${n > 1 ? '"...", "..."' : ''}]}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    return {
      statusCode: 200,
      body: JSON.stringify({
        suggestions: parsed.suggestions || [],
        grounded_in_period: targetPeriod,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
