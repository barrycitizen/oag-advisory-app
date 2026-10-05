// Regression: an AI API failure during analysis must NOT wipe the period's
// existing analysis. Runs the real analyze-background handler with a fake
// Supabase (records every delete/insert) and a fake Anthropic API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeSupabase(log) {
  const snapshot = { client_id: 'c1', period_end: '2025-06-30', revenue: 1000, cogs: 600, gross_profit: 400, net_profit: 100, cash: 50 };
  const tableData = {
    financial_snapshots: { single: snapshot, list: [snapshot] },
    client_context: { single: { client_id: 'c1', cadence: 'annual', profile_extra: {} }, list: [] },
  };
  const from = (table) => {
    let op = 'select';
    let single = false;
    const b = {
      select: () => b, eq: () => b, neq: () => b, lt: () => b, lte: () => b, gte: () => b, in: () => b, like: () => b,
      not: () => b, order: () => b, limit: () => b, is: () => b,
      single: () => { single = true; return b; }, maybeSingle: () => { single = true; return b; },
      delete: () => { op = 'delete'; log.push(`delete ${table}`); return b; },
      insert: () => { op = 'insert'; log.push(`insert ${table}`); return b; },
      upsert: () => { op = 'upsert'; log.push(`upsert ${table}`); return b; },
      update: () => { op = 'update'; log.push(`update ${table}`); return b; },
      then: (resolve) => {
        const d = tableData[table];
        const data = op !== 'select' ? null : single ? (d?.single ?? null) : (d?.list ?? []);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { from };
}

function loadHandler(fetchImpl, log) {
  const dir = path.resolve(__dirname, '..', '..', 'netlify', 'functions');
  const src = fs.readFileSync(path.join(dir, 'analyze-background.js'), 'utf8');
  const sb = fakeSupabase(log);
  const req = (m) => (m === '@supabase/supabase-js' ? { createClient: () => sb } : require(m.startsWith('.') ? path.join(dir, m) : m));
  const ctx = vm.createContext({ require: req, module: { exports: {} }, exports: {}, process: { env: { ANTHROPIC_API_KEY: 'test' } }, console: { error: () => {}, log: () => {} }, fetch: fetchImpl });
  vm.runInContext(src, ctx);
  return ctx.module.exports.handler || ctx.exports.handler;
}

const anthropicReply = (status, body) => async (url) => {
  if (String(url).includes('anthropic.com')) return new Response(JSON.stringify(body), { status });
  throw new Error('unexpected fetch ' + url);
};

for (const [label, status, body] of [
  ['overloaded (529)', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
  ['rate limited (429)', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }],
  ['200 with no content', 200, { content: [] }],
  ['200 with truncated JSON', 200, { content: [{ type: 'text', text: '{"diagnosis": "half a sent' }] }],
]) {
  test(`analysis: AI ${label} -> error recorded, existing analysis NOT deleted`, async () => {
    const log = [];
    const handler = loadHandler(anthropicReply(status, body), log);
    const res = await handler({ body: JSON.stringify({ client_id: 'c1', period_end: '2025-06-30' }), headers: {} });
    const destructive = log.filter((l) => /^delete (flags|pillar_scores|recommendations|health_scores)$/.test(l) || l === 'insert recommendations');
    assert.deepEqual(destructive, [], `wiped: ${destructive.join(', ')}`);
    assert.ok(log.includes('insert diagnostics'), 'an analysis_error marker is recorded for the UI');
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /Nothing was changed/);
  });
}
