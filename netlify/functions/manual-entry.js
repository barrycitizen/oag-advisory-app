// netlify/functions/manual-entry.js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FINANCIAL_FIELDS = [
  'revenue', 'cogs', 'operating_expenses', 'net_profit', 'wages',
  'debtors', 'creditors', 'cash', 'current_assets', 'current_liabilities',
  'total_debt', 'equity',
];

async function saveFinancials(body) {
  const { client_id, period_end } = body;
  if (!client_id || !period_end) throw new Error('client_id and period_end required');

  const row = { client_id, period_end, source: 'manual', synced_at: new Date().toISOString() };
  for (const field of FINANCIAL_FIELDS) {
    const val = body[field];
    row[field] = val === '' || val === undefined || val === null ? 0 : Number(val);
  }
  row.gross_profit = row.revenue - row.cogs;

  const { error } = await supabase.from('financial_snapshots').upsert(row, { onConflict: 'client_id,period_end' });
  if (error) throw error;
  return row;
}

async function saveContext(body) {
  const { client_id } = body;
  if (!client_id) throw new Error('client_id required');

  const updatable = ['business_description', 'industry', 'key_contact', 'adviser', 'cadence'];
  const update = {};
  for (const field of updatable) {
    if (body[field] !== undefined) update[field] = body[field];
  }
  if (body.owner_goals_business !== undefined || body.owner_goals_personal !== undefined) {
    const { data: existing } = await supabase.from('client_context').select('owner_goals').eq('client_id', client_id).single();
    update.owner_goals = {
      ...(existing?.owner_goals || {}),
      ...(body.owner_goals_business !== undefined ? { business: body.owner_goals_business } : {}),
      ...(body.owner_goals_personal !== undefined ? { personal: body.owner_goals_personal } : {}),
    };
  }

  const { error } = await supabase.from('client_context').update(update).eq('client_id', client_id);
  if (error) throw error;
  return update;
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    if (!body.type) return { statusCode: 400, body: 'type ("financials" or "context") required' };

    const result = body.type === 'financials' ? await saveFinancials(body)
      : body.type === 'context' ? await saveContext(body)
      : null;

    if (!result) return { statusCode: 400, body: 'Unknown type — use "financials" or "context"' };

    return { statusCode: 200, body: JSON.stringify({ ok: true, saved: result }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
