// netlify/functions/lib/risk-item-synthesis.js
//
// Risk Item Synthesis
// ------------------------------------------------------------------
// Turns one question+answer from the business questionnaire into an
// actual risk write-up: what the risk is, why it matters, and what to do
// about it. Same pattern as the industry checklist AI call (see
// industry-risk-checklist.js). Every question in a category is
// independent and flat (no anchor/follow-up hierarchy — see
// business-risk-questionnaire.js), so this only ever synthesizes one
// question's answer at a time.
//
// Fixes: this used to store the literal question text as "detail" —
// answering "yes" just echoed the question back rather than producing an
// answer. This generates real content instead.
//
// Run migration_risk_items_v4.sql first (adds risk_items.recommendation).

const MODEL = 'claude-sonnet-4-6'; // matches the model used elsewhere (analyze.js, suggest-goal.js, industry-risk-checklist.js)

const SYSTEM_PROMPT = `You turn one answer from a small business adviser's risk questionnaire
into a concise risk write-up.

You'll be given: a risk category, the specific question that was answered
in a way that indicates a risk is present, and the accountant's notes.

Write:
- risk_name: short label, 2-5 words (e.g. "Key-person dependency")
- detail: 1-2 sentences on what the actual risk is and why it matters for
  this business, grounded in what was actually said in the answer — do
  not invent specifics that weren't provided
- recommendation: 1 concrete, actionable next step the adviser could
  suggest to the client
- severity: "High", "Medium", or "Low" based on how exposed this makes
  the business, given what was said

If the answer given is too thin to say anything specific, keep detail and
recommendation general to the question/category rather than fabricating
details.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{ "risk_name": "...", "detail": "...", "recommendation": "...", "severity": "High|Medium|Low" }`;

// Throws if the response isn't parseable JSON — same "let the caller
// decide" philosophy as industry-risk-checklist.js's generateChecklistViaAI.
// This is a foreground, user-initiated save (clicking Save on the
// questionnaire), so a failure here should surface to the accountant
// (they'd want to retry), not be silently swallowed.
async function synthesizeRiskItem({ category, questionText, answerText }) {
  const userMessage = `Category: ${category}\nQuestion (answered "risk present"): ${questionText}\nAnswer: ${answerText || '(no detail given)'}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.risk_name || !parsed.detail) throw new Error('Synthesis response missing risk_name/detail');
  return parsed; // { risk_name, detail, recommendation, severity }
}

const INDUSTRY_RECOMMENDATION_SYSTEM_PROMPT = `You give small business advisers one concrete, actionable next step for a
risk that's just been confirmed as applicable to a specific client.

You'll be given the risk's category, name, and description (generated
earlier as a general industry-checklist item, now confirmed as real for
this client). Suggest ONE practical thing the adviser could recommend the
client actually do about it — specific enough to act on, not a vague
"monitor this" platitude.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{ "recommendation": "..." }`;

// Deliberately NOT run when the industry checklist is first generated
// (generateIndustryRiskItems, industry-risk-checklist.js) — that would
// mean an AI recommendation call for every one of the 5-9 items on every
// client, most of which get dismissed as Not applicable. Only runs once a
// risk is actually confirmed applicable (see risk-review-actions.js's
// 'confirm' action) — "is this real" and "what do we do about it" are two
// different questions, and the second one is only worth asking once the
// first is answered yes.
async function synthesizeIndustryRecommendation({ category, riskName, detail }) {
  const userMessage = `Category: ${category}\nRisk: ${riskName}\nDescription: ${detail}`;

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
      system: INDUSTRY_RECOMMENDATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.recommendation) throw new Error('Synthesis response missing recommendation');
  return parsed; // { recommendation }
}

module.exports = { synthesizeRiskItem, synthesizeIndustryRecommendation };
