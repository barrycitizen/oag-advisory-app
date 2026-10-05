// Unit tests for business logic inside index.html — the real functions,
// extracted by tests/unit/_load.js (no browser, no network).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadIndex } = require('./_load');

const c = loadIndex([
  'escAttr', 'formatMoney', 'formatKpi', 'formatShortDate', 'cashInOut', 'cashStorySentence',
  'scoreBucket', 'PILLAR_META', 'CADENCE_PILLAR_KEYS', 'notScoredAreaNames',
  'FINANCIAL_PILLAR_KEYS', 'computeFinancialScore', 'computeActionProgress',
], { today: () => '2026-10-05' });

// ---- escAttr: everything user/AI-typed goes through this into HTML ----

test('escAttr neutralises tags, quotes and ampersands', () => {
  assert.equal(c.escAttr('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)>');
  assert.equal(c.escAttr('Bob\'s "Best" & Co'), 'Bob\'s &quot;Best&quot; &amp; Co');
});
test('escAttr: null/undefined become empty, numbers stringify', () => {
  assert.equal(c.escAttr(null), '');
  assert.equal(c.escAttr(undefined), '');
  assert.equal(c.escAttr(0), '0');
});
test('escAttr keeps a "<word" goal intact once rendered (regression: goal text was swallowed)', () => {
  // Rendering escAttr output as HTML text must give back the original string.
  const original = 'Keep GP margin <target until costs settle';
  const decoded = c.escAttr(original).replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.equal(decoded, original);
});

// ---- Formatting ----

test('formatMoney: rounds, groups thousands, handles null/NaN/Infinity', () => {
  assert.equal(c.formatMoney(1234567.4), '$1,234,567');
  assert.equal(c.formatMoney(0), '$0');
  assert.equal(c.formatMoney(null), '—');
  assert.equal(c.formatMoney(NaN), '—');
  assert.equal(c.formatMoney(Infinity), '—');
});
test('formatKpi: percent/days/null', () => {
  assert.equal(c.formatKpi(0.2575, 'percent'), '25.8%');
  assert.equal(c.formatKpi(null, 'percent'), '—');
  assert.equal(c.formatKpi(14.4, 'days'), '14d');
});
test('formatShortDate: en-AU, no timezone drift on period ends', () => {
  assert.equal(c.formatShortDate('2025-06-30'), '30 June 2025');
  assert.equal(c.formatShortDate('2024-12-31'), '31 Dec 2024');
});

// ---- Scores ----

test('scoreBucket: band edges on both 0-10 and /100 scales', () => {
  assert.equal(c.scoreBucket(null), null);
  assert.equal(c.scoreBucket(8.5).label, 'Very good');
  assert.equal(c.scoreBucket(7).label, 'Good');
  assert.equal(c.scoreBucket(5).label, 'OK');
  assert.equal(c.scoreBucket(3).label, 'Watch');
  assert.equal(c.scoreBucket(2.9).label, 'Poor');
  assert.equal(c.scoreBucket(85, true).label, 'Very good');
  assert.equal(c.scoreBucket(49, true).label, 'Watch');
});
test('computeFinancialScore: averages only the 3 financial pillars, /100', () => {
  assert.equal(c.computeFinancialScore([{ pillar: 'profitability', score: 5.5 }, { pillar: 'cash_flow', score: 9.4 }, { pillar: 'tax', score: 7 }, { pillar: 'risk', score: 0 }]), 73);
  assert.equal(c.computeFinancialScore([{ pillar: 'risk', score: 4 }]), null);
  assert.equal(c.computeFinancialScore([]), null);
  assert.equal(c.computeFinancialScore(undefined), null);
});
test('notScoredAreaNames: per cadence, and narrowed to financial keys', () => {
  const scored = [{ pillar: 'profitability', score: 5 }, { pillar: 'cash_flow', score: 6 }, { pillar: 'tax', score: 7 }, { pillar: 'growth', score: 7 }, { pillar: 'risk', score: 4 }, { pillar: 'owner_wealth', score: 5 }];
  assert.deepEqual([...c.notScoredAreaNames(scored, 'annual')], ['Systems & team', 'Owner goals']);
  assert.deepEqual([...c.notScoredAreaNames(scored, 'quarterly')], []);
  assert.deepEqual([...c.notScoredAreaNames([{ pillar: 'tax', score: 7 }], 'annual', c.FINANCIAL_PILLAR_KEYS)], ['Profitability', 'Cash flow']);
  // a row with score null counts as not scored
  assert.deepEqual([...c.notScoredAreaNames([{ pillar: 'profitability', score: null }], 'quarterly', ['profitability'])], ['Profitability']);
  // unknown/missing cadence falls back to quarterly
  assert.equal(c.notScoredAreaNames([], undefined).length, 3);
});

// ---- Cash story ----

test('cashInOut: splits signed flows into in/out and keeps the real bank delta', () => {
  const r = { operating_cf: 172482, capex: 58155, borrowings_cash_flow: -40000, interest_applicable: true, cash_interest_paid: 10000, delta_director_loan: 100000, adjustments: [{ label: 'Insurance', amount: 20000 }], delta_cash: -46163 };
  const t = c.cashInOut(r);
  assert.equal(t.cashIn, 292482);
  assert.equal(t.cashOut, 108155);
  assert.equal(t.net, 184327);
  assert.equal(t.delta_cash, -46163);
  // the gap the meeting card / report warn about
  assert.equal(t.delta_cash - t.net, -230490);
});
test('cashInOut / cashStorySentence: missing reconciliation is null, not a crash', () => {
  assert.equal(c.cashInOut(null), null);
  assert.equal(c.cashStorySentence(null), null);
  assert.equal(c.cashStorySentence({ delta_cash: 0 }), null);
});
test('cashStorySentence: describes a fall and ignores zero items', () => {
  const s = c.cashStorySentence({ operating_cf: -5000, capex: 0, owner_drawings: 2000, delta_cash: -7000 });
  assert.match(s, /used \$5,000 in operations/);
  assert.match(s, /the owner drew \$2,000/);
  assert.match(s, /cash fell by \$7,000\./);
  assert.doesNotMatch(s, /equipment/);
});

// ---- Since last meeting ----

const RECS = { '2026-03-31': { created_at: '2026-05-10T01:00:00Z' } };
const items = [
  { text: 'done after meeting', status: 'done', created_at: '2026-05-10T03:00:00Z', completed_at: '2026-06-02T00:00:00Z' },
  { text: 'overdue', status: 'not_started', created_at: '2026-04-01T00:00:00Z', due_date: '2026-07-31' },
  { text: 'on time', status: 'in_progress', created_at: '2026-05-10T05:00:00Z', due_date: '2099-01-01' },
  { text: 'no due date', status: 'not_started', created_at: '2026-04-01T00:00:00Z' },
  { text: 'finished before meeting', status: 'done', created_at: '2026-01-01T00:00:00Z', completed_at: '2026-02-01T00:00:00Z' },
  { text: 'added since', status: 'not_started', created_at: '2026-09-01T00:00:00Z' },
];
test('computeActionProgress: done / slipped / open / new since', () => {
  const p = c.computeActionProgress(items, RECS, '2026-06-30');
  assert.deepEqual(p.done.map((i) => i.text), ['done after meeting']);
  assert.deepEqual(p.slipped.map((i) => i.text), ['overdue']);
  assert.deepEqual(p.open.map((i) => i.text).sort(), ['no due date', 'on time']);
  assert.equal(p.total, 4);
  assert.equal(p.addedSince, 1);
});
test('computeActionProgress: actions agreed during the meeting day count as its commitments', () => {
  const p = c.computeActionProgress([{ text: 'agreed same day', status: 'not_started', created_at: '2026-05-10T23:00:00Z' }], RECS, '2026-06-30');
  assert.equal(p.total, 1);
});
test('computeActionProgress: no earlier meeting -> null; later/same-period meetings ignored', () => {
  assert.equal(c.computeActionProgress(items, {}, '2026-06-30'), null);
  assert.equal(c.computeActionProgress(items, { '2026-06-30': { created_at: '2026-07-01T00:00:00Z' } }, '2026-06-30'), null);
  assert.equal(c.computeActionProgress(items, { '2026-03-31': {} }, '2026-06-30'), null); // record without a date
});
test('computeActionProgress: tolerates missing/empty item lists', () => {
  assert.equal(c.computeActionProgress(undefined, RECS, '2026-06-30').total, 0);
  assert.equal(c.computeActionProgress([{ text: 'no dates', status: 'done' }], RECS, '2026-06-30').total, 0);
});
