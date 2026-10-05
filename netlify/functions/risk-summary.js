const { crossOriginRejection } = require('./lib/same-origin');
// netlify/functions/risk-summary.js
// One-off AI narrative over the current top risks, for the Risk Review
// summary card — turns a list of pill-tagged risk items into 2-4 sentences
// naming what's actually worth raising in the next client meeting, same
// "explain what's there, don't invent" framing as every other AI output in
// this app. No DB access — the frontend already has the risk list from
// get_risk_items (read-data.js), so this just takes it as input rather than
// re-fetching. Deliberately not persisted anywhere (see index.html's
// wireRiskSummaryRegion) — generated fresh on request via a button, not on
// every page load.
//
// Env vars required: ANTHROPIC_API_KEY

const SYSTEM_PROMPT = `You write a short overall risk summary for a small business adviser to use
in a client meeting brief.

You'll be given a list of the client's current active risks — name,
severity, source (financial/business/industry), category, and detail —
plus how many other risks are already Managed/resolved.

Write 2-4 sentences: what's the overall picture, which 1-2 risks are most
worth raising with the client, and any notable pattern (e.g. several risks
clustered in one area, or a mix of financial and operational exposure).
Be specific — reference the actual risk names given, not generic advice.
If there are no active risks, say so plainly and briefly rather than
padding out a summary of nothing.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{ "summary": "..." }`;

exports.handler = async (event) => {
  const refused = crossOriginRejection(event); // see lib/same-origin.js
  if (refused) return refused;
  try {
    const { risks, managedCount } = JSON.parse(event.body || '{}');
    if (!Array.isArray(risks)) return { statusCode: 400, body: 'risks[] required' };

    const risksText = risks.length
      ? risks.map((r) => `- [${r.severity}] ${r.risk_name} (${r.source}/${r.category}): ${r.detail || 'no detail on file'}`).join('\n')
      : '(no active risks currently)';
    const userContent = `Active risks:\n${risksText}\n\nManaged/resolved count: ${managedCount || 0}`;

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
    if (!parsed.summary) throw new Error('Response missing summary');

    return { statusCode: 200, body: JSON.stringify({ summary: parsed.summary }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
