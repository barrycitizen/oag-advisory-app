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

// Xero reports return a nested Rows structure — pull() finds a labelled row's value.
function findValue(report, label) {
  const rows = report.Reports?.[0]?.Rows || [];
  for (const section of rows) {
    for (const row of section.Rows || []) {
      const cellLabel = row.Cells?.[0]?.Value;
      if (cellLabel && cellLabel.trim().toLowerCase() === label.toLowerCase()) {
        const val = row.Cells?.[1]?.Value;
        return val ? parseFloat(val) : 0;
      }
    }
  }
  return 0;
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
    const agedReceivables = await fetchXeroReport(token, conn.tenant_id, 'AgedReceivablesByContact', `?date=${period_end}`);
    const agedPayables = await fetchXeroReport(token, conn.tenant_id, 'AgedPayablesByContact', `?date=${period_end}`);

    const revenue = findValue(pnl, 'Total Income');
    const cogs = findValue(pnl, 'Total Cost of Sales');
    const gross_profit = revenue - cogs;
    const operating_expenses = findValue(pnl, 'Total Operating Expenses');
    const net_profit = findValue(pnl, 'Net Profit');
    const wages = findValue(pnl, 'Wages and Salaries');

    const debtors = findValue(bs, 'Accounts Receivable');
    const creditors = findValue(bs, 'Accounts Payable');
    const cash = findValue(bs, 'Bank');
    const current_assets = findValue(bs, 'Total Current Assets');
    const current_liabilities = findValue(bs, 'Total Current Liabilities');
    const total_debt = findValue(bs, 'Total Liabilities');
    const equity = findValue(bs, 'Total Equity');

    const row = {
      client_id, period_end,
      cadence: (await supabase.from('client_context').select('cadence').eq('client_id', client_id).single()).data?.cadence || 'quarterly',
      revenue, cogs, gross_profit, operating_expenses, net_profit, wages,
      debtors, creditors, cash, current_assets, current_liabilities, total_debt, equity,
      source: 'xero', synced_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('financial_snapshots')
      .upsert(row, { onConflict: 'client_id,period_end' });
    if (upsertErr) throw upsertErr;

    await supabase.from('xero_connections').update({ last_synced_at: new Date().toISOString() }).eq('client_id', client_id);

    return { statusCode: 200, body: JSON.stringify({ ok: true, snapshot: row }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
