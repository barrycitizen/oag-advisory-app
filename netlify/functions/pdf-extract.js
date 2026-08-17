// netlify/functions/pdf-extract.js
const FIELD_LIST = [
  'revenue', 'cogs', 'operating_expenses', 'other_income', 'other_expenses',
  'interest_expense', 'depreciation_amortisation', 'net_profit', 'wages',
  'debtors', 'creditors', 'cash', 'current_assets', 'current_liabilities',
  'total_assets', 'total_liabilities', 'total_debt', 'equity', 'inventory', 'fixed_assets',
  'operating_cash_flow', 'tax_expense',
  'owner_drawings', 'funds_introduced', 'director_loan_balance',
  'loan_repayments', 'equipment_purchases',
];

exports.handler = async (event) => {
  try {
    const { client_id, period_end, pdf_base64 } = JSON.parse(event.body || '{}');
    if (!client_id || !period_end || !pdf_base64) {
      return { statusCode: 400, body: 'client_id, period_end and pdf_base64 required' };
    }

    // Field meanings/instructions are identical on every extraction regardless
    // of which document is uploaded, so they're cacheable — the document
    // itself (and which fields to list) is the only part that varies. This
    // block is comfortably over Anthropic's ~1024-token minimum for caching
    // to actually engage, unlike the shorter prompts in the other functions.
    const systemInstructions = `You are extracting figures from a client's financial statements (P&L and/or Balance Sheet), which may come from MYOB, Reckon, or another accounting package with a different layout to Xero.

Extract these fields if present anywhere in the document: ${FIELD_LIST.join(', ')}.

Field meanings:
- revenue: total income/sales
- cogs: total cost of sales/cost of goods sold
- operating_expenses: total operating expenses (excluding COGS)
- other_income: non-operating/other income (e.g. interest received, gains on sale) — not core sales revenue
- other_expenses: non-operating/other expenses not already covered by operating_expenses, interest, or depreciation
- interest_expense: interest paid on loans/borrowings
- depreciation_amortisation: depreciation and amortisation expense
- net_profit: profit/loss BEFORE tax is deducted (i.e. "Profit before tax" / "Net profit before tax" — not the after-tax bottom line). If the statement shows both a pre-tax and post-tax figure, use the pre-tax one.
- wages: wages and salaries expense
- debtors: accounts receivable / trade debtors
- creditors: accounts payable / trade creditors
- cash: bank/cash balance
- current_assets: total current assets
- current_liabilities: total current liabilities
- total_assets: total assets (current + non-current)
- total_liabilities: total liabilities (current + non-current) — not the same as total_debt
- total_debt: interest-bearing debt specifically (loans, finance leases) — not the same as total liabilities generally. IMPORTANT: if the document shows a director's/shareholder's loan blended into the same line as bank loans/borrowings, EXCLUDE the director/shareholder portion from this figure if the document lets you tell them apart (use director_loan_balance for that instead) — only combine them here if the document truly gives no way to separate them
- equity: total equity
- inventory: stock on hand
- fixed_assets: Property, Plant & Equipment, net book value (i.e. after accumulated depreciation) — the specific fixed-assets line, not total non-current assets generally (which can include unrelated items like investments or a loan owed to the business by a director)
- operating_cash_flow: net cash generated from operating activities (from a cash flow statement, if present)
- tax_expense: income tax expense/provision for the period
- owner_drawings: cash withdrawn by the owner/shareholder for personal use this period (often in a statement of changes in equity, or an equity/drawings account note) — enter as a positive number
- funds_introduced: cash contributed/injected by the owner/shareholder this period (capital introduced) — enter as a positive number
- director_loan_balance: the CLOSING BALANCE of the director's/shareholder's loan account at this period end (a balance, not a movement) — positive if the business owes the director money, from a related-party loan note or the balance sheet
- loan_repayments: principal repaid on loans/borrowings this period (from a cash flow statement's financing section, or loan statement) — enter as a positive number, interest is separate (see interest_expense)
- equipment_purchases: cash spent on equipment, vehicles, or other fixed assets this period (capex, often in a cash flow statement's investing section, or fixed asset additions in the notes) — enter as a positive number

Most financial statements show a COMPARATIVE column (this period vs. the same period last year/last quarter). If one is present, ALSO extract that comparative column's figures separately, and state which period_end it represents (as an actual YYYY-MM-DD date if the document states or clearly implies one, otherwise your best label like "prior year" if you can't pin down an exact date). If there is no comparative column, omit "comparative" entirely — don't invent one.

Respond ONLY as JSON, no other text: {"values": {"revenue": 0, ...}, "not_found": ["field names you could not locate"], "notes": "anything ambiguous or worth a human double-checking, e.g. two possible figures for the same line item", "comparative": {"period_end": "YYYY-MM-DD or a label if no exact date is stated", "values": {...}, "not_found": [...]}}

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
        max_tokens: 2200,
        system: [{ type: 'text', text: systemInstructions, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
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
        comparative: parsed.comparative ? {
          period_end: parsed.comparative.period_end || null,
          extracted: parsed.comparative.values || {},
          not_found: parsed.comparative.not_found || [],
        } : null,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
