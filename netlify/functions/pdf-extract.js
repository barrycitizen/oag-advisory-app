const { crossOriginRejection } = require('./lib/same-origin');
// netlify/functions/pdf-extract.js
const FIELD_LIST = [
  'revenue', 'cogs', 'operating_expenses', 'other_income', 'other_expenses',
  'interest_expense', 'depreciation_amortisation', 'capital_works_deduction', 'net_profit', 'wages',
  'debtors', 'creditors', 'cash', 'current_assets', 'current_liabilities',
  'total_assets', 'total_liabilities', 'total_debt', 'equity', 'inventory', 'fixed_assets',
  'operating_cash_flow', 'tax_expense',
  'owner_drawings', 'funds_introduced', 'director_loan_balance',
  'loan_repayments', 'one_off_loan_repayment', 'new_borrowing', 'interest_capitalised', 'equipment_purchases', 'nbv_assets_sold',
];

// The subset of FIELD_LIST a document can plausibly report broken out by
// division/business unit — mirrors DIVISION_TRADING_FIELDS in
// manual-entry.js (kept as its own copy, same "per-file independence"
// convention already used throughout this codebase, not shared code).
const DIVISION_FIELD_LIST = ['revenue', 'cogs', 'wages', 'operating_expenses', 'debtors', 'creditors', 'inventory'];

exports.handler = async (event) => {
  const refused = crossOriginRejection(event); // see lib/same-origin.js
  if (refused) return refused;
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
- capital_works_deduction: amortisation of leasehold or structural/building improvements specifically — look for it as its OWN line in the P&L/income statement first (e.g. "Amortisation of leasehold improvements", "Capital works deduction"), the same place depreciation_amortisation comes from; a fixed asset schedule may also show it broken out from plant & equipment depreciation if the P&L doesn't separate it — enter as a positive number, and only if it's genuinely reported apart from depreciation_amortisation (don't split a single combined figure yourself)
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
- director_loan_balance: the CLOSING BALANCE of the director's/shareholder's loan account at this period end (a balance, not a movement), from a related-party loan note or the balance sheet — enter as POSITIVE if the business owes the director money (a liability), or NEGATIVE if it's a receivable, i.e. the director/shareholder owes the business instead (check which side of the balance sheet — liabilities vs assets — the line actually sits on, don't assume)
- loan_repayments: REGULAR/scheduled principal repaid on loans/borrowings this period (from a cash flow statement's financing section, or loan statement) — enter as a positive number, interest is separate (see interest_expense). If the document calls out a one-off/extra repayment separately (see one_off_loan_repayment below), exclude that amount from this figure — this is the regular schedule only, not the combined total.
- one_off_loan_repayment: if the document explicitly calls out an unplanned, early, or lump-sum extra loan repayment as distinct from the regular scheduled repayments (e.g. a note saying a loan was paid out early, or an "extra repayment" line), enter that amount here — it's IN ADDITION to loan_repayments above, not a portion already counted within it. Leave blank/not_found if the document doesn't distinguish one from the regular schedule, or reports only one combined repayments figure (in which case put the whole thing in loan_repayments instead).
- new_borrowing: new debt drawn down this period (e.g. "proceeds from borrowings" in a cash flow statement's financing section, or a new loan drawdown noted on a loan statement) — enter as a positive number. Leave blank/not_found if the document doesn't disclose this separately from the loan balance movement; don't calculate it yourself from other figures.
- interest_capitalised: if a loan statement explicitly shows interest being added to/capitalised onto the loan balance (rather than paid separately in cash) — common on redraw, interest-only, or line-of-credit facilities — enter that amount here. This is a portion of interest_expense above, not an amount in addition to it. Leave blank/not_found if the document doesn't say interest was capitalised, or reports only one combined interest figure; don't infer or calculate this from the loan balance movement yourself.
- equipment_purchases: cash spent on equipment, vehicles, or other fixed assets this period (capex, often in a cash flow statement's investing section, or fixed asset additions in the notes) — enter as a positive number
- nbv_assets_sold: the net book value (cost less accumulated depreciation, NOT the original cost) of any fixed assets disposed of/sold during this period — usually in a fixed asset schedule's disposals column, or derivable there if cost and accumulated depreciation for the disposed item are both shown — enter as a positive number, or 0 if nothing was disposed of and the document is explicit about that

Most financial statements show a COMPARATIVE column (this period vs. the same period last year/last quarter). If one is present, ALSO extract that comparative column's figures separately, and state which period_end it represents (as an actual YYYY-MM-DD date if the document states or clearly implies one, otherwise your best label like "prior year" if you can't pin down an exact date). If there is no comparative column, omit "comparative" entirely — don't invent one.

If a field genuinely isn't in the document, put it in not_found rather than guessing a number. If the document requires combining multiple divisions/entities into one set of figures (e.g. two P&Ls for one legal entity), do that arithmetic and report the combined totals in "values" as usual — but ALSO report each division's own ${DIVISION_FIELD_LIST.join(', ')} separately in "divisions" (one entry per division, named as the document names it, only the fields that division's own P&L actually shows). Don't narrate the working in prose either way. If the document is for a single business with no division/segment breakdown, omit "divisions" entirely — most documents are this case. Report your findings by calling the extract_financials tool exactly once. Keep "notes" to one short sentence, or omit it if nothing's ambiguous — it's a flag for a human to double-check something, not a summary of your reasoning.`;

    // A field-name → {type:'number'} map, reused for both the current period's
    // and the comparative period's "values" shape in the tool schema below.
    const valueProps = Object.fromEntries(FIELD_LIST.map((f) => [f, { type: 'number' }]));
    const divisionValueProps = Object.fromEntries(DIVISION_FIELD_LIST.map((f) => [f, { type: 'number' }]));
    const tool = {
      name: 'extract_financials',
      description: 'Report the financial figures extracted from the document.',
      input_schema: {
        type: 'object',
        properties: {
          values: { type: 'object', properties: valueProps, description: 'Extracted figures for the main/current period — only fields actually found' },
          not_found: { type: 'array', items: { type: 'string' }, description: 'Field names from the requested list that are not present in the document' },
          notes: { type: 'string', description: 'One short sentence flagging anything ambiguous, or omit entirely if nothing is' },
          // Named exactly as the document names each division/business unit —
          // matching against this app's own configured division names (if any)
          // happens client-side during review, not here, so this function stays
          // stateless (no client_id-specific lookups) and fast.
          divisions: {
            type: 'array',
            description: 'One entry per division/business unit, only if the document actually breaks figures out this way — omit entirely for a single-business document',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, ...divisionValueProps },
              required: ['name'],
            },
          },
          comparative: {
            type: 'object',
            description: 'The comparative/prior column, if the document shows one',
            properties: {
              period_end: { type: 'string', description: 'YYYY-MM-DD if stated/clearly implied, otherwise a best-effort label like "prior year"' },
              values: { type: 'object', properties: valueProps },
              not_found: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['values'],
      },
    };

    // Forcing a tool call (rather than asking for JSON in free text) means the
    // API hands back already-structured, already-parsed input — no more regex-
    // stripping code fences off raw text and hoping nothing else is around it.
    // On a document complex enough to need real reasoning (e.g. consolidating
    // multiple divisions), free-text responses were opening with several
    // paragraphs of prose before the JSON, which both broke the old parser and
    // burned enough output time to trip the platform's function timeout.
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
        tools: [tool],
        tool_choice: { type: 'tool', name: 'extract_financials' },
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
          ],
        }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Claude API error');
    const toolBlock = (data.content || []).find((b) => b.type === 'tool_use');
    if (!toolBlock) throw new Error('Claude did not return structured data for this document.');
    const parsed = toolBlock.input || {};

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        client_id,
        period_end,
        extracted: parsed.values || {},
        not_found: parsed.not_found || [],
        notes: parsed.notes || null,
        divisions: parsed.divisions || [],
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
