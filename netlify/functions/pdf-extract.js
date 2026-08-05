// netlify/functions/pdf-extract.js
const FIELD_LIST = [
  'revenue', 'cogs', 'operating_expenses', 'net_profit', 'wages',
  'debtors', 'creditors', 'cash', 'current_assets', 'current_liabilities',
  'total_debt', 'equity',
];

exports.handler = async (event) => {
  try {
    const { client_id, period_end, pdf_base64 } = JSON.parse(event.body || '{}');
    if (!client_id || !period_end || !pdf_base64) {
      return { statusCode: 400, body: 'client_id, period_end and pdf_base64 required' };
    }

    const prompt = `You are extracting figures from a client's financial statements (P&L and/or Balance Sheet), which may come from MYOB, Reckon, or another accounting package with a different layout to Xero.

Extract these fields if present anywhere in the document: ${FIELD_LIST.join(', ')}.

Field meanings:
- revenue: total income/sales
- cogs: total cost of sales/cost of goods sold
- operating_expenses: total operating expenses (excluding COGS)
- net_profit: net profit/loss for the period
- wages: wages and salaries expense
- debtors: accounts receivable / trade debtors
- creditors: accounts payable / trade creditors
- cash: bank/cash balance
- current_assets: total current assets
- current_liabilities: total current liabilities
- total_debt: total liabilities
- equity: total equity

Respond ONLY as JSON, no other text: {"values": {"revenue": 0, ...}, "not_found": ["field names you could not locate"], "notes": "anything ambiguous or worth a human double-checking, e.g. two possible figures for the same line item"}

If a field genuinely isn't in the document, put it in not_found rather than guessing a number.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    const data = await res.json();
    const rawText = data.content?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        client_id,
        period_end,
        extracted: parsed.values || {},
        not_found: parsed.not_found || [],
        notes: parsed.notes || null,
        review_required: true,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
