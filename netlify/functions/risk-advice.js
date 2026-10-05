// netlify/functions/risk-advice.js
// On-demand, per-risk AI advice — deeper and more tailored than what a risk
// item already carries (its stored `recommendation`/talking point, which is
// either a one-time AI synthesis frozen at creation time, or for financial/
// owner_wealth sources, a generic hardcoded line that never mentions this
// client specifically — see FINANCIAL_RISK_TALKING_POINT/
// ownerWealthTalkingPoint in index.html). This is the opposite: generated
// fresh on click, grounded in this client's actual business context, so the
// advice can reference their industry/size/structure instead of reading
// like boilerplate. No DB access, same reasoning as risk-summary.js —
// deliberately not persisted, since it goes stale the moment the risk or
// the client's context changes, and caching something that needs constant
// invalidation is more complexity than just regenerating on request.
//
// Env vars required: ANTHROPIC_API_KEY

const SYSTEM_PROMPT = `You are a small business advisory assistant giving one accountant a
sharper, more specific take on a single risk already on their client's risk
register than the generic one-liner already on file.

You'll be given the risk's name/category/source/severity/detail, plus this
client's business context (description, industry, entity structure, years
trading, employee count, and any notable context).

Write 60-100 words of concrete, specific advice for THIS client, grounded in
their actual context — not generic risk-management boilerplate that could
apply to any business. Reference their industry/size/structure where it
genuinely changes the advice (e.g. what's proportionate for a 4-person shop
differs from a 50-person one). Cover, in plain language: why this matters
for THIS business specifically, and the concrete next step the adviser
should raise with the client. Do not just restate the risk's existing
detail back — add something the accountant doesn't already have on the
screen.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{ "advice": "..." }`;

exports.handler = async (event) => {
  try {
    const { risk_name, detail, category, source, severity, client_context } = JSON.parse(event.body || '{}');
    if (!risk_name) return { statusCode: 400, body: 'risk_name required' };

    const ctx = client_context || {};
    const userContent = `Risk: ${risk_name}
Severity: ${severity || 'unknown'}
Source: ${source || 'unknown'}
Category: ${category || 'unknown'}
Detail: ${detail || 'none on file'}

Client business: ${ctx.business_description || 'no description'} (${ctx.industry || 'industry not set'}), entity structure: ${ctx.entity_type || 'not set'}
Years trading: ${ctx.years_trading ?? 'not set'}
Employees: ${ctx.employee_count ?? 'not set'}
Notable context: ${ctx.structure_notes || 'none noted'}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!claudeRes.ok) {
      throw new Error(`Anthropic API error: ${claudeRes.status} ${await claudeRes.text()}`);
    }
    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content || []).map((b) => b.text || '').join('').trim();
    const parsed = JSON.parse(rawText.replace(/^```json\s*|```$/g, '').trim());
    if (!parsed.advice) throw new Error('Response missing advice');

    return { statusCode: 200, body: JSON.stringify({ advice: parsed.advice }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
