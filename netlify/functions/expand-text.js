const { crossOriginRejection } = require('./lib/same-origin');
// netlify/functions/expand-text.js
// Turns a short seed phrase into a fuller draft for a Profile text field — the
// same idea as "Suggest a goal" but for prose: type a few words, get a draft,
// review/edit before saving. Never invents specifics (numbers, dates, names)
// beyond what's given, just expands the wording.
//
// Env vars required: ANTHROPIC_API_KEY

const FIELD_PROMPTS = {
  business_description: 'a short business description for an accounting client profile — what the business does and who it serves',
  structure_notes: "a short 'notable context' note for an accounting client profile — the kind of thing an adviser wants to remember before a meeting (family business, recent change of ownership, seasonal trade, one big customer, etc.)",
};

exports.handler = async (event) => {
  const refused = crossOriginRejection(event); // see lib/same-origin.js
  if (refused) return refused;
  try {
    const { seed, field, industry } = JSON.parse(event.body || '{}');
    if (!seed || !field) return { statusCode: 400, body: 'seed and field required' };

    const fieldDesc = FIELD_PROMPTS[field] || 'a short profile note for an accounting client';

    const prompt = `Expand this short note into ${fieldDesc}.

They typed: "${seed}"${industry ? `\nIndustry: ${industry}` : ''}

Write a natural 1-2 sentence draft. Do not invent specific facts (numbers, dates, names, locations) that weren't given — only reword and flesh out what was actually said. Respond with ONLY the expanded text, no quotes, no preamble, no JSON.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const draft = (data.content?.[0]?.text || '').trim();

    return { statusCode: 200, body: JSON.stringify({ draft }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
