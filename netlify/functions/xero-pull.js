// netlify/functions/xero-pull.js
// Pulls P&L, Balance Sheet, and Aged Receivables/Payables for one client from Xero
// using a Custom Connection (client_credentials grant — no user login redirect needed),
// computes the ratios, and upserts into Supabase.
//
// Env vars required (set in Netlify site settings):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getXeroToken(clientId, clientSecret) {
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error('Xero auth failed: ' + (await res.text()));
  const data = await res.json();
  return data.access_token;
}

async function fetchXeroReport(token, tenantId, reportName, params = '') {
  const res = await fetch(`https://api.xero.com/api.xro/2.0/Reports/${reportName}${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Xero ${reportName} failed: ` + (await res.text()));
  return res.json();
}

// ---- Robust label matching ----
// Xero reports nest rows inside sections inside sections (sometimes more than
// one level deep — subtotal groups, summary rows, etc). The old version only
// scanned section.Rows one level down, so valid rows could be skipped
// entirely depending on how a client's report was structured.
//
// This version walks the whole tree recursively and normalizes labels
// (trim, collapse whitespace, lowercase) so minor formatting differences
// don't cause a miss.

function normalize(label) {
  return (label || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Recursively collect every {label, value} pair in the report, regardless of nesting depth.
function collectRows(rows, out = []) {
  for (const section of rows || []) {
    if (section.Cells) {
      const label = section.Cells?.[0]?.Value;
      const rawVal = section.Cells?.[1]?.Value;
      if (label) out.push({ label: normalize(label), value: rawVal ? parseFloat(rawVal) : 0 });
    }
    if (section.Rows) collectRows(section.Rows, out);
  }
  return out;
}

// Try each candidate label (in priority order) against the flattened row list.
// Returns { value, matchedLabel } or null if nothing matched.
function findValue(report, candidates) {
  const rows = collectRows(report.Reports?.[0]?.Rows || []);
  for (const candidate of candidates) {
    const target = normalize(candidate);
    const hit = rows.find((r) => r.label === target);
    if (hit) return { value: hit.value, matchedLabel: candidate };
  }
  return null;
}

// Field -> ordered list of label variants to try, to cover different charts of accounts.
// Note: total_debt means interest-bearing borrowings specifically, not all
// liabilities — this used to incorrectly match the "Total Liabilities" line.
// It also can't reliably exclude a director/shareholder loan that a client's
// chart of accounts lumps into the same "Loans"/"Borrowings" line as bank
// debt — label matching alone can't tell them apart, so total_debt may come
// through already blended with director_loan_balance in that case (same
// limitation as PDF extraction and manual entry).
const FIELD_LABELS = {
  revenue: ['Total Income', 'Total Revenue', 'Revenue', 'Sales'],
  cogs: ['Total Cost of Sales', 'Cost of Sales', 'Cost of Goods Sold'],
  operating_expenses: ['Total Operating Expenses', 'Total Expenses'],
  other_income: ['Other Income', 'Total Other Income'],
  other_expenses: ['Other Expenses', 'Total Other Expenses'],
  interest_expense: ['Interest Expense', 'Interest Paid', 'Finance Costs'],
  depreciation_amortisation: ['Depreciation', 'Depreciation and Amortisation', 'Depreciation & Amortisation'],
  // net_profit means PRE-tax profit throughout this app — prioritise labels
  // that say so explicitly, since a report with both a pre- and post-tax line
  // would otherwise match "Net Profit" (usually the after-tax one) first.
  net_profit: ['Profit Before Tax', 'Profit Before Income Tax', 'Net Profit Before Tax', 'Net Profit', 'Net Profit (Loss)', 'Profit for the year'],
  wages: ['Wages and Salaries', 'Wages & Salaries', 'Salaries and Wages', 'Wages'],
  tax_expense: ['Income Tax Expense', 'Tax Expense', 'Provision for Income Tax'],
  debtors: ['Accounts Receivable', 'Trade Debtors', 'Debtors'],
  creditors: ['Accounts Payable', 'Trade Creditors', 'Creditors'],
  cash: ['Bank', 'Total Bank', 'Cash and Cash Equivalents'],
  inventory: ['Inventory', 'Stock', 'Inventory on Hand'],
  current_assets: ['Total Current Assets'],
  current_liabilities: ['Total Current Liabilities'],
  total_assets: ['Total Assets'],
  total_liabilities: ['Total Liabilities'],
  total_debt: ['Total Loans', 'Total Borrowings', 'Interest-bearing Liabilities', 'Bank Loans'],
  equity: ['Total Equity', "Total Equity/(Deficiency)"],
  fixed_assets: ['Total Fixed Assets', 'Property, Plant and Equipment', 'Fixed Assets'],
  // Chart-of-accounts naming for this varies a lot more than most fields —
  // matched on a best-effort basis, left null (and flagged missing) rather
  // than guessed at if nothing matches.
  director_loan_balance: ['Loan from Director', "Director's Loan", 'Directors Loan Account', 'Shareholder Loan', 'Loan - Director'],
};

// Pulls every field for a report, returning both the values and which fields
// (if any) failed to match anything — null (not 0) so a KPI needing this field
// can honestly show Unavailable instead of calculating off a fake zero.
function extractFields(report, fieldNames) {
  const values = {};
  const missing = [];
  for (const field of fieldNames) {
    const result = findValue(report, FIELD_LABELS[field]);
    if (result) {
      values[field] = result.value;
    } else {
      values[field] = null;
      missing.push(field);
    }
  }
  return { values, missing };
}

exports.handler = async (event) => {
  try {
    const { client_id, period_end } = JSON.parse(event.body || '{}');
    if (!client_id || !period_end) {
      return { statusCode: 400, body: 'client_id and period_end required' };
    }

    const { data: conn, error: connErr } = await supabase
      .from('xero_connections')
      .select('*')
      .eq('client_id', client_id)
      .single();
    if (connErr || !conn) throw new Error('No Xero connection found for this client');

    const token = await getXeroToken(conn.xero_client_id, conn.xero_client_secret);

    const pnl = await fetchXeroReport(token, conn.tenant_id, 'ProfitAndLoss', `?date=${period_end}`);
    const bs = await fetchXeroReport(token, conn.tenant_id, 'BalanceSheet', `?date=${period_end}`);
    // Aged receivables/payables fetched for future use (debtor/creditor-days-by-contact
    // drill-down) — not yet parsed into fields, kept as raw pulls for now.
    const agedReceivables = await fetchXeroReport(token, conn.tenant_id, 'AgedReceivablesByContact', `?date=${period_end}`);
    const agedPayables = await fetchXeroReport(token, conn.tenant_id, 'AgedPayablesByContact', `?date=${period_end}`);

    const pnlFields = extractFields(pnl, [
      'revenue', 'cogs', 'operating_expenses', 'other_income', 'other_expenses',
      'interest_expense', 'depreciation_amortisation', 'wages', 'tax_expense', 'net_profit',
    ]);
    const bsFields = extractFields(bs, [
      'cash', 'debtors', 'inventory', 'current_assets', 'creditors', 'current_liabilities',
      'total_assets', 'total_liabilities', 'total_debt', 'equity', 'fixed_assets', 'director_loan_balance',
    ]);

    const revenue = pnlFields.values.revenue;
    const cogs = pnlFields.values.cogs;
    const gross_profit = (revenue == null || cogs == null) ? null : revenue - cogs;

    // operating_cash_flow needs Xero's Cash Flow Statement, which isn't pulled
    // here (P&L + Balance Sheet only) — left null and flagged as missing
    // honestly, rather than guessing at a report that was never fetched.
    const missing = [...pnlFields.missing, ...bsFields.missing, 'operating_cash_flow'];

    const row = {
      client_id, period_end,
      cadence: (await supabase.from('client_context').select('cadence').eq('client_id', client_id).single()).data?.cadence || 'quarterly',
      revenue, cogs, gross_profit,
      operating_expenses: pnlFields.values.operating_expenses,
      other_income: pnlFields.values.other_income,
      other_expenses: pnlFields.values.other_expenses,
      interest_expense: pnlFields.values.interest_expense,
      depreciation_amortisation: pnlFields.values.depreciation_amortisation,
      wages: pnlFields.values.wages,
      tax_expense: pnlFields.values.tax_expense,
      net_profit: pnlFields.values.net_profit,
      cash: bsFields.values.cash,
      debtors: bsFields.values.debtors,
      inventory: bsFields.values.inventory,
      current_assets: bsFields.values.current_assets,
      creditors: bsFields.values.creditors,
      current_liabilities: bsFields.values.current_liabilities,
      total_assets: bsFields.values.total_assets,
      total_liabilities: bsFields.values.total_liabilities,
      total_debt: bsFields.values.total_debt,
      equity: bsFields.values.equity,
      fixed_assets: bsFields.values.fixed_assets,
      director_loan_balance: bsFields.values.director_loan_balance,
      operating_cash_flow: null,
      source: 'xero',
      synced_at: new Date().toISOString(),
      // Surfaces which fields (if any) couldn't be matched in this client's
      // report, so a 0 isn't mistaken for a real figure. Null when everything matched.
      unmatched_fields: missing.length ? missing : null,
    };

    const { error: upsertErr } = await supabase
      .from('financial_snapshots')
      .upsert(row, { onConflict: 'client_id,period_end' });
    if (upsertErr) throw upsertErr;

    await supabase.from('xero_connections').update({ last_synced_at: new Date().toISOString() }).eq('client_id', client_id);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        snapshot: row,
        warning: missing.length
          ? `Could not match: ${missing.join(', ')} — these were saved as 0. Check this client's Xero report labels.`
          : null,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
