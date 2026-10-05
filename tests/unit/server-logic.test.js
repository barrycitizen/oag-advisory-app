// Unit tests for server-side logic in the Netlify functions — real code,
// loaded with Supabase stubbed out (tests/unit/_load.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunction } = require('./_load');

const an = loadFunction('analyze-background.js');
const me = loadFunction('manual-entry.js');

// ---- Pillar scoring: unscored is null, never a placeholder 6 ----

const ctx = { flags: [], riskItems: [], fs: { revenue: 100 }, priorFs: null, ownerWealth: {}, taxScore: null };

test('scorePillar: areas with no data, or no scoring logic, are not scored (null)', () => {
  for (const p of ['tax', 'growth', 'owner_wealth', 'systems_team', 'owner_goals']) {
    assert.equal(an.scorePillar(p, {}, ctx), null, p);
  }
});
test('scorePillar: real data still scores', () => {
  assert.equal(an.scorePillar('tax', {}, { ...ctx, taxScore: 7 }), 7);
  assert.equal(an.scorePillar('growth', {}, { ...ctx, priorFs: { revenue: 90 } }), 9); // +11%
  assert.equal(an.scorePillar('owner_wealth', {}, { ...ctx, ownerWealth: { exitReadinessOverall: 70, estateGapCount: 1, estateApplicableCount: 4 } }), 6.5);
});
test('scoreGrowthPillar bands, incl. consolidate posture and decline', () => {
  const g = (cur, prior, posture) => an.scoreGrowthPillar({ revenue: cur }, { revenue: prior }, posture);
  assert.equal(g(110, 100), 9);
  assert.equal(g(104, 100), 7);
  assert.equal(g(100, 100), 6);
  assert.equal(g(95, 100), 4);
  assert.equal(g(80, 100), 2);
  assert.equal(g(102, 100, 'consolidate'), 9);
  assert.equal(g(80, 100, 'hold_wealth'), 3);
  assert.equal(an.scoreGrowthPillar({ revenue: 100 }, { revenue: 0 }), null); // no usable prior
});
test('scoreRiskPillar: starts at 10, docks per active item, floors at 0', () => {
  assert.equal(an.scoreRiskPillar([], []), 10);
  assert.equal(an.scoreRiskPillar([{ severity: 'danger' }, { severity: 'warning' }], []), 7);
  const many = Array.from({ length: 20 }, () => ({ severity: 'danger' }));
  assert.equal(an.scoreRiskPillar(many, []), 0);
});

// ---- Cash / KPI engine edge cases ----

test('deriveOperatingCashFlow: entered value wins; derives only with full data', () => {
  assert.deepEqual({ ...an.deriveOperatingCashFlow({ operating_cash_flow: 5 }, null) }, { value: 5, derived: false });
  assert.equal(an.deriveOperatingCashFlow({ net_profit: 1 }, null).value, null);
  const fs = { net_profit: 100, interest_expense: 10, depreciation_amortisation: 5, debtors: 50, creditors: 30, inventory: 20 };
  const prior = { debtors: 40, creditors: 20, inventory: 25 };
  // 100+10+5 -(50-40) +(30-20) -(20-25) = 120
  assert.deepEqual({ ...an.deriveOperatingCashFlow(fs, prior) }, { value: 120, derived: true });
});
test('computeKpiValue: zero / missing denominators give null, not Infinity', () => {
  const kpi = { kind: 'ratio', numerator: ['net_profit'], denominator: ['revenue'] };
  assert.equal(an.computeKpiValue({ net_profit: 10, revenue: 0 }, kpi, null), null);
  assert.equal(an.computeKpiValue({ net_profit: 10, revenue: null }, kpi, null), null);
  assert.equal(an.computeKpiValue({ net_profit: 10, revenue: 40 }, kpi, null), 0.25);
  const growth = { kind: 'growth', numerator: ['revenue'] };
  assert.equal(an.computeKpiValue({ revenue: 110 }, growth, { revenue: 0 }), null);
  assert.equal(an.computeKpiValue({ revenue: 110 }, growth, { revenue: 100 }), 0.1);
});
test('estimateIndividualEffectiveRate: 0 at/below zero income, rises with income', () => {
  assert.equal(an.estimateIndividualEffectiveRate(0), 0);
  assert.equal(an.estimateIndividualEffectiveRate(-5), 0);
  const low = an.estimateIndividualEffectiveRate(30000);
  const high = an.estimateIndividualEffectiveRate(300000);
  assert.ok(low > 0 && low < high && high < 0.47, `${low} ${high}`);
});

// ---- Financial input parsing (manual-entry) ----

test('toNumberOrNull: blanks -> null; numbers incl. 0, negatives, decimals pass', () => {
  for (const blank of ['', null, undefined]) assert.equal(me.toNumberOrNull('f', blank), null);
  assert.equal(me.toNumberOrNull('f', '0'), 0);
  assert.equal(me.toNumberOrNull('f', '-25000.5'), -25000.5);
  assert.equal(me.toNumberOrNull('f', 1e12), 1e12);
});
test('toNumberOrNull: junk is rejected with the field named (regression: saved as blank)', () => {
  for (const junk of ['abc', '12,345', '$5k', 'NaN', 'Infinity']) {
    assert.throws(() => me.toNumberOrNull('revenue', junk), /revenue must be a number/, junk);
  }
});
test('cleanDivisionBreakdown: drops unknown divisions, derives GP, rejects junk numbers', () => {
  const valid = new Set(['a']);
  const out = me.cleanDivisionBreakdown([{ division_id: 'a', revenue: '100', cogs: '60' }, { division_id: 'zzz', revenue: '1' }], valid);
  assert.equal(out.length, 1);
  assert.equal(out[0].gross_profit, 40);
  assert.throws(() => me.cleanDivisionBreakdown([{ division_id: 'a', revenue: 'x' }], valid), /must be a number/);
  assert.deepEqual([...me.cleanDivisionBreakdown('not-an-array', valid)], []);
});
