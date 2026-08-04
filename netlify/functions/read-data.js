// netlify/functions/read-data.js
// With RLS on and no policies, the anon key can't read these tables from the
// browser — this function uses the service key server-side instead, same
// reasoning as xero-pull.js and analyze.js.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  try {
    const { action, client_id } = JSON.parse(event.body || '{}');

    if (action === 'list_clients') {
      const { data, error } = await supabase.from('client_context').select('client_id, business_description, industry, cadence');
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (action === 'get_context') {
      const { data, error } = await supabase.from('client_context').select('*').eq('client_id', client_id).single();
      if (error) throw error;
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (action === 'get_report_data') {
      const [{ data: hs }, { data: recs }] = await Promise.all([
        supabase.from('health_scores').select('*').eq('client_id', client_id).order('period_end', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('recommendations').select('*').eq('client_id', client_id).order('period_end', { ascending: false }).limit(3),
      ]);
      return { statusCode: 200, body: JSON.stringify({ healthScore: hs, recommendations: recs }) };
    }

    return { statusCode: 400, body: 'Unknown action' };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
