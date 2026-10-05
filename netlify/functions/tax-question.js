// netlify/functions/tax-question.js
// Free-text Q&A for the Tax Diagnose section — the AI-generated "Tax planning"
// card only ever surfaces what IT thought of from the P&L numbers, so a
// question like "what about negative gearing a property" (a personal
// investment decision, not derivable from the business's financial snapshot)
// never comes up unless the adviser already thought of it themselves. This
// lets them ask directly.
//
// Same "explain, don't recommend" framing as every other AI output in this
// app, but with an extra guardrail an open text box specifically needs:
// negative gearing, property, and share-portfolio-style questions edge into
// financial PRODUCT advice (needs an AFSL, not just tax agent registration),
// which is a different, easier line to cross than a scoped, structured
// prompt ever risks. The prompt explicitly tells the model to name that
// distinction and decline rather than answer a "should I" investment
// question as if it were a tax question.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

const { createClient } = require('@supabase/supabase-js');
const { crossOriginRejection } = require('./lib/same-origin');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  const refused = crossOriginRejection(event); // see lib/same-origin.js
  if (refused) return refused;
  try {
    const { client_id, period_end, question } = JSON.parse(event.body || '{}');
    if (!client_id || !question) return { statusCode: 400, body: 'client_id and question required' };

    const [{ data: ctx }, { data: fs }] = await Promise.all([
      supabase.from('client_context').select('business_description, industry, entity_type').eq('client_id', client_id).single(),
      period_end
        ? supabase.from('financial_snapshots').select('revenue, net_profit, tax_expense, cash').eq('client_id', client_id).eq('period_end', period_end).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    // Instructions/rules are identical for every question this function ever
    // answers — only the client context and the question itself change — so
    // they're the cacheable half. Realistically short enough that it may sit
    // under Anthropic's ~1024-token minimum for caching to engage (see the
    // note in analyze.js), but wiring it correctly costs nothing and is
    // ready to benefit if the rules text grows.
    const systemInstructions = `You are a tax-question assistant inside an accounting advisory app, answering a question an adviser typed in during a client review.

Rules, strictly:
1. Only explain tax TREATMENT and considerations — what the tax rules say, what's generally relevant, what's worth discussing with the client. NEVER tell them what to actually do ("you should", "I'd recommend", "the best option is"). Frame everything as something to review or discuss, matching how every other suggestion in this app is phrased.
2. If the question is really a financial PRODUCT or investment decision dressed up as a tax question — e.g. "should I negative gear a property", "should I invest in shares/crypto", "what property should I buy" — do NOT answer the investment part at all. Say plainly that this crosses into financial product advice, which needs an AFSL-licensed financial adviser, not a tax answer, and that you can only address the tax TREATMENT of a decision they've already made (e.g. "if you did buy a negatively-geared property, the loss offsets your other taxable income like this..." is fine; "should you buy one" is not).
3. Ground your answer in the client's actual context/numbers given, rather than generic advice.
4. Keep it to 3-5 sentences. Short and direct.

Respond ONLY as JSON, no markdown fences: {"answer": "...", "is_financial_advice_question": true or false}`;

    const userContent = `Client: ${ctx?.business_description || 'no description on file'} (industry: ${ctx?.industry || 'not recorded'})
Entity structure: ${ctx?.entity_type || 'not recorded'}
${fs ? `This period's figures: revenue ${fs.revenue ?? 'n/a'}, net profit ${fs.net_profit ?? 'n/a'}, tax expense ${fs.tax_expense ?? 'n/a'}, cash ${fs.cash ?? 'n/a'}` : 'No financial snapshot available for this period.'}

Adviser's question: "${question}"`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: [{ type: 'text', text: systemInstructions, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    return {
      statusCode: 200,
      body: JSON.stringify({
        answer: parsed.answer || '',
        isFinancialAdviceQuestion: !!parsed.is_financial_advice_question,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
