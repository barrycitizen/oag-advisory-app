// API edge-case / failure tests against the LOCAL dev server
// (`netlify dev`, http://localhost:8888). Every write goes to a throwaway
// "AUDIT TEST CLIENT" created in before() and hard-deleted in after(), so
// real client data is never touched.
//
// Run:  npm run test:api      (dev server must be running)
// Skips itself cleanly if the dev server isn't reachable.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.OAG_BASE_URL || 'http://localhost:8888';
const fn = (name) => `${BASE}/.netlify/functions/${name}`;

async function post(name, body, { raw } = {}) {
  const res = await fetch(fn(name), { method: 'POST', body: raw !== undefined ? raw : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}
const read = (action, extra = {}) => post('read-data', { action, ...extra });
const write = (type, extra = {}) => post('manual-entry', { type, ...extra });

let serverUp = false;
let clientId = null;
const PERIOD = '2024-06-30';

before(async () => {
  try {
    const r = await fetch(fn('read-data'), { method: 'POST', body: JSON.stringify({ action: 'list_clients' }) });
    serverUp = r.ok;
  } catch { serverUp = false; }
  if (!serverUp) return;
  const r = await write('add_client', { business_name: 'AUDIT TEST CLIENT', industry: 'Testing', cadence: 'annual', fy_end: '2024-06-30' });
  clientId = r.json?.saved?.client_id;
});

after(async () => {
  if (serverUp && clientId) await write('delete_client', { client_id: clientId });
});

const maybe = (name, fnBody) => test(name, async (t) => {
  if (!serverUp) return t.skip('dev server not running on ' + BASE);
  assert.ok(clientId, 'test client was created');
  await fnBody(t);
});

// ---- Input validation / malformed requests ----

maybe('read-data: malformed JSON body returns an error, not a crash', async () => {
  const r = await post('read-data', null, { raw: '{not json' });
  assert.equal(r.status, 500);
  assert.ok(r.json?.error, 'returns a JSON error');
});

maybe('read-data: unknown action is rejected with 400', async () => {
  const r = await read('no_such_action', { client_id: clientId });
  assert.equal(r.status, 400);
});

maybe('manual-entry: unknown type is rejected, not silently accepted', async () => {
  const r = await write('no_such_type', { client_id: clientId });
  assert.ok(r.status >= 400, `status ${r.status}`);
});

maybe('manual-entry: missing client_id is rejected', async () => {
  const r = await write('save_action_item', { text: 'x' });
  assert.ok(r.status >= 400);
});

maybe('get_context for a client that does not exist returns empty, not a 500', async () => {
  const r = await read('get_context', { client_id: '00000000-0000-0000-0000-000000000000' });
  assert.ok(r.status < 500, `status ${r.status}: ${r.text.slice(0, 120)}`);
});

// ---- Financials: numbers, blanks, junk ----

maybe('financials: blank fields are stored as null, not 0', async () => {
  const r = await write('financials', { client_id: clientId, period_end: PERIOD, revenue: '1000', net_profit: '' });
  assert.equal(r.status, 200, r.text);
  const k = await read('get_kpi_report', { client_id: clientId, period_end: PERIOD });
  assert.equal(Number(k.json.snapshot.revenue), 1000);
  assert.equal(k.json.snapshot.net_profit, null);
});

maybe('financials: non-numeric text is rejected rather than stored as NaN', async () => {
  const r = await write('financials', { client_id: clientId, period_end: PERIOD, revenue: 'abc' });
  const k = await read('get_kpi_report', { client_id: clientId, period_end: PERIOD });
  const stored = k.json?.snapshot?.revenue;
  assert.ok(r.status >= 400, `junk revenue was accepted (status ${r.status}); stored ${JSON.stringify(stored)}`);
  assert.match(r.json?.error || '', /revenue must be a number/);
});

maybe('financials: negative, zero and very large values round-trip exactly', async () => {
  const r = await write('financials', { client_id: clientId, period_end: PERIOD, revenue: '0', net_profit: '-25000.5', cash: '999999999999' });
  assert.equal(r.status, 200, r.text);
  const s = (await read('get_kpi_report', { client_id: clientId, period_end: PERIOD })).json.snapshot;
  assert.equal(Number(s.revenue), 0);
  assert.equal(Number(s.net_profit), -25000.5);
  assert.equal(Number(s.cash), 999999999999);
});

maybe('financials: an impossible date is rejected', async () => {
  const r = await write('financials', { client_id: clientId, period_end: '2024-02-31', revenue: '1' });
  assert.ok(r.status >= 400, `status ${r.status}`);
});

// ---- Actions: text handling, duplicates, deletion ----

maybe('action items: special characters and HTML are stored verbatim', async () => {
  const text = `<img src=x onerror=alert(1)> "quotes" & ampersands — emoji 🚀 'single'`;
  const r = await write('save_action_item', { client_id: clientId, text, source: 'manual' });
  assert.equal(r.status, 200, r.text);
  const items = (await read('get_action_items', { client_id: clientId })).json.items;
  assert.ok(items.some((it) => it.text === text));
});

maybe('action items: empty / whitespace-only text is rejected', async () => {
  const r = await write('save_action_item', { client_id: clientId, text: '   ' });
  assert.ok(r.status >= 400);
});

maybe('action items: very long text (20k chars) is accepted and round-trips', async () => {
  const text = 'L'.repeat(20000);
  const r = await write('save_action_item', { client_id: clientId, text });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const items = (await read('get_action_items', { client_id: clientId })).json.items;
  assert.ok(items.some((it) => it.text.length === 20000));
});

maybe('action items: invalid status/owner fall back to safe defaults', async () => {
  const r = await write('save_action_item', { client_id: clientId, text: 'status test', status: 'hacked', owner: 'Mallory' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.saved.status, 'not_started');
  assert.equal(r.json.saved.owner, null);
});

maybe('action items: editing a done item keeps its original completed_at', async () => {
  const created = (await write('save_action_item', { client_id: clientId, text: 'done test', status: 'done' })).json.saved;
  await new Promise((r) => setTimeout(r, 1100));
  const edited = (await write('save_action_item', { id: created.id, client_id: clientId, text: 'done test (edited)', status: 'done' })).json.saved;
  assert.equal(edited.completed_at, created.completed_at);
});

maybe('action items: cannot edit another client’s item by id', async () => {
  const mine = (await write('save_action_item', { client_id: clientId, text: 'owned' })).json.saved;
  const r = await write('save_action_item', { id: mine.id, client_id: '00000000-0000-0000-0000-000000000000', text: 'stolen' });
  const items = (await read('get_action_items', { client_id: clientId })).json.items;
  assert.ok(items.some((it) => it.id === mine.id && it.text === 'owned'), `item was changed (status ${r.status})`);
});

// ---- Recommendation state ----

maybe('recommendation state: invalid decision value is rejected', async () => {
  const r = await write('save_recommendation_state', { client_id: clientId, period_end: PERIOD, rec_id: 'rec:x:y', decision: 'maybe' });
  assert.ok(r.status >= 400);
});

maybe('recommendation state: concurrent writes to different recs (serialised by the UI) — server-side race documented', async () => {
  // The UI queues these (postRecState). Firing them in parallel at the
  // server directly shows whether the server itself is safe: it does a
  // read-modify-write of one JSON column, so parallel writes can be lost.
  const ids = Array.from({ length: 6 }, (_, i) => `rec:race:${i}`);
  await Promise.all(ids.map((rec_id) => write('save_recommendation_state', { client_id: clientId, period_end: PERIOD, rec_id, decision: 'discuss' })));
  const ctx = (await read('get_context', { client_id: clientId })).json;
  const saved = Object.keys(ctx.recommendation_state?.[PERIOD]?.decisions || {}).filter((k) => k.startsWith('rec:race:'));
  // Record the outcome rather than assert: this is a known server-side
  // limitation (see AUDIT-REPORT.md), mitigated client-side.
  console.log(`    parallel rec-state writes kept ${saved.length}/${ids.length}`);
  assert.ok(saved.length >= 1);
});

// ---- Meeting records ----

maybe('meeting record: save, read back, then clear', async () => {
  const record = { client_id: clientId, period_end: PERIOD, created_at: new Date().toISOString(), priorities: [], completed: false };
  assert.equal((await write('save_meeting_record', { client_id: clientId, period_end: PERIOD, record })).status, 200);
  let ctx = (await read('get_context', { client_id: clientId })).json;
  assert.ok(ctx.meeting_records?.[PERIOD]);
  assert.equal((await write('save_meeting_record', { client_id: clientId, period_end: PERIOD, record: null })).status, 200);
  ctx = (await read('get_context', { client_id: clientId })).json;
  assert.ok(!ctx.meeting_records?.[PERIOD]);
});

// ---- Analysis guard ----

maybe('analysis refuses an empty period (records an analysis_error)', async () => {
  const EMPTY = '2023-06-30';
  await write('financials', { client_id: clientId, period_end: EMPTY });
  await post('analyze-background', { client_id: clientId, period_end: EMPTY });
  let d = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    d = (await read('get_diagnosis', { client_id: clientId, period_end: EMPTY })).json;
    if (d?.analysisError) break;
  }
  assert.match(d?.analysisError || '', /No figures entered/);
});

// ---- Cross-site request forgery ----

maybe('a POST from another website is refused before it runs', async () => {
  for (const name of ['manual-entry', 'read-data']) {
    const res = await fetch(fn(name), {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ type: 'save_action_item', action: 'list_clients', client_id: clientId, text: 'csrf probe' }),
    });
    assert.equal(res.status, 403, name);
  }
  const items = (await read('get_action_items', { client_id: clientId })).json.items;
  assert.ok(!items.some((it) => it.text === 'csrf probe'), 'cross-site write did not land');
});

maybe('a same-origin POST (what the app sends) still works', async () => {
  const res = await fetch(fn('read-data'), {
    method: 'POST',
    headers: { Origin: BASE },
    body: JSON.stringify({ action: 'list_clients' }),
  });
  assert.equal(res.status, 200);
});

// ---- Error responses don't leak internals ----

maybe('errors do not expose stack traces or keys', async () => {
  const r = await write('financials', { client_id: 'not-a-uuid', period_end: 'nope', revenue: '1' });
  assert.ok(!/at .+\.js:\d+/.test(r.text), 'no stack trace');
  assert.ok(!/eyJ[a-zA-Z0-9_-]{20,}|sk-ant-/.test(r.text), 'no keys');
});
