# Growth Domain — Build Spec

## ⚠️ APPROVED FOR BUILD NOW: "NEXT BUILD (Round 1)" and "NEXT BUILD (Round 2)" only

Everything below both NEXT BUILD sections (§1-§5) is background/history —
what's already shipped and a backlog of ideas that have NOT been approved.
**Build only the items under the two NEXT BUILD headings. Do not build
anything from §4 or §5 in this pass** — those need separate confirmation
first. If anything below is ambiguous or looks like it needs a design
decision, stop and ask rather than guessing — earlier in this project part
of a plan (moving the Get Better card) was silently skipped without being
flagged, so surface gaps instead of quietly dropping them.

If Round 1 (pace-to-goal / cash cost of growing / prompt tweak) hasn't
been built yet, do that first — Round 2 doesn't depend on it, but keeping
build batches in order makes it easier to review each one on its own.

---

## NEXT BUILD (Round 1) — Pace-to-goal, Cash cost of growing, and a small AI prompt tweak

Three items. The first two go in `renderGrowthAnalyse` (index.html ~3449),
alongside the existing Growth Outlook and Opportunities cards. All three
reuse data/infrastructure that's already in place — no new Supabase tables,
no new `read-data.js` actions, no schema changes.

### A. Pace-to-goal — new card

**What it's for, in plain terms:** Goals already lets someone set a target
(e.g. "$2M revenue") on a goal item, via its `kpi_key`/`target` fields
(same fields `findKpiTarget` already reads — analyze.js ~217, mirrored in
index.html). Nobody currently compares that target to the client's actual
trend. This card answers: "at the rate we're actually growing, how long
until we hit that number — or are we even heading the right way?"

**Data already available, no new fetching needed to build:**
- `get_kpi_history` (read-data.js ~292) already returns up to 6 periods of
  computed KPI values: `{ periods: [...period_end dates...], kpis: [{ key,
  values: [...one value per period...] }] }`. Call it from
  `renderGrowthAnalyse` alongside the existing `get_diagnosis`/
  `get_kpi_report` calls.
- Goal targets live on `context.owner_goals` (the same object already
  loaded via the `get_context` read action and used elsewhere in the app —
  check for the existing global holding this, e.g. `currentCtx`, before
  fetching it again).

**Logic:**
1. Walk the client's goal items across all categories, find any with both
   a `kpi_key` and a `target` set.
2. For each one, find the matching entry in `get_kpi_history`'s `kpis`
   array by `key`, and take its `values` array (oldest → newest, per
   `periods`).
3. Compute a simple trend — the rate of change from the oldest to newest
   non-null value is enough for v1, no need for real regression.
4. Project forward: at that rate, how many periods until `target` is
   reached? If the trend is flat or moving away from the target, say so
   plainly rather than showing a nonsense/negative timeframe.

**Display, in plain language, one line per goal-with-a-target:**
- "Revenue target $2,000,000 — at the current trend, ~5 quarters away."
- "Wages % target 30% — trending the wrong way, not on track at the current rate."

If no goal has a `kpi_key`/`target` set yet, show a prompt instead of an
empty card: "Set a target on a Goals item (with a linked KPI) to see pace-to-goal here."

### B. Cash cost of growing — extends the EXISTING Growth Outlook card

**What it's for, in plain terms:** growth eats cash before it pays back —
if revenue grows, debtors and stock usually grow with it, tying up cash
right when things feel like they're going well. The Growth Outlook card
(already built, §1) currently shows only a projected profit number when
you model a revenue increase. This adds a second line showing roughly how
much extra cash that growth would tie up.

**This is NOT a new card** — extend `computeGrowthOutlookResult`/
`renderGrowthOutlookCard` (index.html, ~1892-2160+) in place.

**Data already available, no new computation needed to build:**
`get_kpi_report` (already called in `renderGrowthAnalyse`) already returns
`debtor_days`, `creditor_days`, and `inventory_days` as computed KPI values
in its `kpis` array (confirmed present — see the `KPI_DIRECTION` map,
index.html ~1432, which already references all three keys). Read the
client's own current values for these straight off the already-fetched
`kpiData.kpis`, the same object `renderGrowthAnalyse` already has in scope.

**Logic — apply the client's own ratios to the modeled growth, don't invent new assumptions:**
- Extra revenue this period vs the scenario = `projectedRevenue - snapshot.revenue` (already computed inside `projectGrowthProfitScenario`).
- Extra debtors tied up ≈ that extra revenue × (`debtor_days` / 365) — debtor days scale off revenue.
- Extra stock/creditor movement ≈ scale off the extra COGS implied by the projected GP, using `inventory_days`/`creditor_days`, which are COGS-based, not revenue-based (see `computeRatios`/`computeInventoryDays`, analyze.js ~19-33, for the exact denominator — confirm against `kpi_library`'s actual numerator/denominator for these two KPIs before wiring the formula, don't assume revenue-based for all three).
- Show net figure as a second line under the existing profit headline, plain language: "+$180,000 profit — but roughly $95,000 extra cash tied up in debtors/stock to fund it."
- If `debtor_days`/`inventory_days` aren't available for this client (KPI confidence is 'red' / value is null), omit the line rather than showing a broken or zero figure — same "don't invent a number" convention the rest of the app follows.

### C. Prompt tweak — nudge Opportunities toward marketing too

**Why:** checked the actual system prompt driving the Opportunities list
(`analyze.js` ~line 401). It already explicitly tells Claude to consider
"new services, pricing changes, expansion, upsell" — pricing is covered —
but marketing/customer-acquisition ideas aren't named, so they only show up
if the model happens to think of one, not reliably. Small, low-risk change.

**What to change** — one line, `analyze.js` ~401, inside the
`systemInstructions` template string:

```
// Before:
Up to 2 growth opportunities — NEW, additive ideas (new services, pricing changes, expansion, upsell) ...

// After:
Up to 2 growth opportunities — NEW, additive ideas (new services, pricing changes, marketing/customer acquisition, expansion, upsell) ...
```

That's the whole change — don't touch anything else in that prompt block.
Note this only ever surfaces up to 2 opportunities total per period, so
adding a category doesn't guarantee it appears every time — it's now just
possible where it wasn't reliably before.

**What this does NOT fix, on purpose — leave for later, don't try to solve it here:**
Staffing decisions (hiring, cutting roles) and acquisitions were both
confirmed absent from what the AI can reliably suggest — and for
acquisitions specifically, no prompt wording will fix it, because the AI
only ever sees this client's own financial ratios/flags, never market or
target-company information. Both of these are really the 12-month outlook
questionnaire idea from the backlog below (§4) — asking the accountant/
client directly rather than hoping the AI infers it from a P&L. See the
priority note added to §4.

---

## NEXT BUILD (Round 2) — Growth trajectory view and Business valuation

Build the trajectory view first, valuation second — trajectory is lower
risk (a chart on data that already exists), valuation has more new moving
parts (new table, new AI call, new editable input). Neither depends on the
other or on Round 1.

### D. Growth trajectory view — new card

**What it's for, in plain terms:** every comparison built so far (ratios,
flags, the outlook cards) is this-period-vs-last-period only. This card
shows revenue and net profit across the last several periods together, so
an accountant can see at a glance whether growth is accelerating,
flattening, or lumpy — something a two-period comparison hides.

**Data:** `get_kpi_history` (read-data.js ~292) already returns up to 6
periods (`{ periods: [...], kpis: [{ key, values: [...] }] }`) — the same
action Round 1's pace-to-goal card also uses, so if that's already been
built, this can reuse the same fetch rather than calling it twice.

**⚠️ Confirm before building, don't assume:** `get_kpi_history`'s `kpis`
array only contains whatever's defined in `kpi_library` — check whether
`kpi_library` has plain-dollar "Revenue" and "Net profit" entries (not
just ratios like GP margin or revenue growth %). If those don't exist,
either add them to `kpi_library` as data (no code change, matches the
existing "KPIs are data, not hardcoded formulas" convention) or extend
`get_kpi_history` to also return `snapshot.revenue`/`snapshot.net_profit`
directly per period. Don't guess which KPI keys exist — check the actual
`kpi_library` table content first.

**Chart approach:** this app hand-rolls its own visuals in inline SVG
(see the cash-conversion donut ~2434 and the health wheel ~2620) — there's
no charting library imported anywhere in `index.html`. Match that
convention: a simple inline SVG line/sparkline, not a new dependency.
**Read the `dataviz` skill before writing the chart itself** — this
project's style guide for chart colors, line weight, and layout.

**Display:** one small multi-period line for revenue, one for net profit,
labelled with period-end dates, sitting in `renderGrowthAnalyse` alongside
the other Growth cards. Read-only for v1 — no interaction needed.

### E. Business valuation — new card, new table, new AI-suggested-multiple lib

**What it's for, in plain terms:** a simple, clearly-labelled "roughly
what is this business worth" estimate — EBITDA × a multiple, both shown
plainly, not hidden behind one polished number. The multiple is
AI-suggested based on the client's industry, but always editable — the
accountant confirms or overrides it before it's saved, the same
"AI proposes, human confirms" pattern already used for the industry risk
checklist and KPI benchmark lines elsewhere in this app. **Label this
clearly as an indicative/internal-working estimate, not a formal
valuation** — same spirit as the existing "not verified" caveats already
used on AI benchmark figures.

**EBITDA — no new computation needed.** `financial_snapshots` already has
`interest_expense` and `depreciation_amortisation`, and `net_profit` is
already pre-tax throughout this app (see the comment above
`deriveOperatingCashFlow`, analyze.js ~257). EBITDA = `net_profit +
interest_expense + depreciation_amortisation` — the exact same formula
already used as `op_cash_conversion`'s denominator. Reuse it, don't
reimplement it differently here.

**New migration** (`migration_business_valuations.sql`, following this
project's existing migration-file convention):

```sql
create table if not exists business_valuations (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null,
  period_end            date not null,
  ebitda                numeric,
  ai_suggested_multiple numeric,
  multiple_used         numeric not null,
  valuation_amount      numeric not null,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  unique (client_id, period_end)
);

-- Cache so identical industries don't re-hit the AI every time — same
-- pattern as industry_risk_checklist_cache (migration_risk_items.sql).
create table if not exists industry_valuation_multiple_cache (
  industry_key      text primary key,
  suggested_multiple numeric not null,
  rationale         text not null,
  generated_at      timestamptz default now()
);
```

**New lib file** `netlify/functions/lib/valuation-multiple.js` — clone
`industry-risk-checklist.js`'s structure directly, don't redesign it:
- `generateMultipleViaAI(industryText, businessDescription)` — one Claude
  call asking for a single typical EBITDA multiple for that industry/size
  (not a range — a range just becomes an argument, a single defensible
  starting number is more useful), plus a one-line rationale that itself
  states this is general guidance, not a formal valuation (bake the
  caveat into the AI's own output, don't rely only on surrounding UI text).
- `getOrGenerateMultiple(supabase, industryText)` — cache-check, generate
  if missing/stale, upsert — same `CACHE_MAX_AGE_DAYS = 180` pattern as
  `industry-risk-checklist.js`.

**New `read-data.js` action**, e.g. `get_valuation_history` — returns
this client's stored `business_valuations` rows ordered by `period_end`,
and if there's no row yet for the current period, also calls
`getOrGenerateMultiple` so the card can pre-fill a suggested multiple and
computed EBITDA before anything's been saved.

**New `manual-entry.js` write action**, e.g. `save_valuation` — takes
`client_id`, `period_end`, `ebitda`, `multiple_used`; computes
`valuation_amount = ebitda * multiple_used` server-side (don't trust a
client-computed total); upserts on `(client_id, period_end)` so re-saving
the same year overwrites rather than duplicating (same `onConflict`
pattern `health_scores` already uses).

**Frontend card**, in `renderGrowthAnalyse`:
- EBITDA for the current period (computed client-side, same formula as
  above, from data already in scope via the existing `get_kpi_report` call).
- The AI-suggested multiple and its one-line rationale, shown together —
  never the multiple alone without the reasoning behind it.
- An editable number input for the multiple, pre-filled with the AI
  suggestion, recalculating the valuation amount live as it's changed —
  same instant-recalc pattern as the Outlook cards.
- A visible, permanent caveat line on the card itself (not just a code
  comment): something like "Indicative estimate for internal/advisory
  discussion only — not a formal valuation. Adjust the multiple based on
  your own judgement."
- A "Save this year's valuation" button calling `save_valuation`.
- Below that, if a prior year's valuation is on file: a plain comparison
  line, "Last year: $X → This year: $Y (+Z%)." Compare by **year**, not
  by every period on file — dedupe stored valuations to one per calendar
  year the same way `dedupeBusinessToLatestPerCategory` already dedupes
  business risk answers (analyze.js ~154) — don't show a quarter-to-quarter
  valuation comparison, it isn't a meaningful cadence for this figure.

---

Everything from here down is unbuilt background/backlog — reference only,
not part of this build.

## Four pieces, roughly in
build order.

## 0. Correction to keep in mind while building

Opportunities and Get Better recommendations are NOT currently homeless —
they already render under **Financial Performance → Diagnose**
(`renderFinancialDiagnose`, index.html ~line 3191), fed by the existing
`get_diagnosis` read action (`read-data.js` ~line 65), with a working
"→ turn into goal" button already wired per item. No new data-fetching is
needed for these two cards — the work is moving/re-homing them under Growth,
not building them.

---

## 1. Growth Outlook card — net profit scenario

Same pattern as Cash Outlook (index.html ~line 1885,
`cashOutlookState` / `computeCashOutlookResult` / `renderCashOutlookCard`),
which itself is built on the shared `projectProfitScenario()` function
(~line 2058). Cash Outlook takes that function's projected net profit and
multiplies by the cash-conversion rate; Growth Outlook should stop one step
earlier and show projected net profit directly as the headline.

**New state + functions, mirroring the Cash Outlook trio exactly:**

```js
let growthOutlookState = { unit: 'pct', revenue: 0, gp: 0, wages: 0, opex: 0, netProfit: 0, netProfitAbsolute: '' };

function computeGrowthOutlookResult(snapshot, unit, revenueChange, gpChange, wagesChange, opexChange, netProfitChange, netProfitAbsolute) {
  const { projectedProfit, buildup, provenance } = projectGrowthProfitScenario(
    snapshot, unit, revenueChange, gpChange, wagesChange, opexChange, netProfitChange, netProfitAbsolute
  );
  return {
    headline: formatMoney(projectedProfit),
    buildup,
    provenance,
  };
}

function renderGrowthOutlookCard(snapshot) {
  // Same shape as renderCashOutlookCard (~1895): collapsed "Adjust assumptions"
  // panel, panelOpen computed the same way (any non-zero/non-empty field),
  // same select-unit (% vs $) control.
}
```

**Extending `projectProfitScenario` for a wages lever.** Today's function
lumps everything below gross profit into one `baselineOpex` figure
(`baselineOpex = baselineGP - netProfit`), so a wage rise and a rent rise
move the same slider. `analyze.js` already computes `wages_pct` as its own
ratio (`fs.wages / fs.revenue`), and `financial_snapshots` already has a
`wages` field (see `computeRatios`, analyze.js ~line 19-28) — so splitting
wages out is additive, not a schema change:

```js
function projectGrowthProfitScenario(snapshot, unit, revenueChange, gpChange, wagesChange, opexChange, netProfitChange, netProfitAbsolute) {
  const baselineWages = snapshot.wages || 0;
  // baselineOtherOpex = everything below GP that ISN'T wages
  // (baselineOpex from the original function, minus baselineWages)
  // Buildup order: revenue -> GP -> wages -> other opex -> profit
  // Reuse projectProfitScenario's existing revenue/GP branch logic for the
  // top two levels, then insert a wages delta step before applying the
  // remaining opex delta, same delta() dollar-vs-percent helper already
  // defined at ~line 2063.
}
```

Don't touch Tax Outlook or Cash Outlook's existing calls to
`projectProfitScenario` — leave that function as-is and add
`projectGrowthProfitScenario` alongside it (or add an optional
`wagesChange` param to the original with a default of `0`, if a single
shared function is preferred — either works, just don't break the two
existing callers' signatures).

**Note on "inventory" as a lever:** inventory is a balance-sheet position,
not a P&L line — it doesn't flow through net profit the way wages does. If
what's wanted is "what if we hold less stock and free up cash," that
belongs as a Cash Outlook lever (alongside cash-conversion), not a Growth
Outlook one. Confirm intent before building an inventory input here.

---

## 2. Wire the Growth domain tab

**`WIRED_WORKFLOWS`** (index.html ~line 552) currently has no `growth` key,
so it falls into the "nothing wired yet, show every tab as placeholder"
default. Add:

```js
const WIRED_WORKFLOWS = {
  financial: ['input', 'analyse', 'diagnose'],
  goals: ['profile', 'input'],
  risk: ['analyse'],
  growth: ['analyse'],
};
```

**New `renderGrowthAnalyse(content)`**, same shape as
`renderFinancialDiagnose` (~3191):

- Call the existing `callRead('get_diagnosis', currentClientId, currentPeriodEnd)` — no backend change needed.
- Render the Opportunities card and Get Better card here (move the markup, don't duplicate it, out of `renderFinancialDiagnose`).
- Render the new Growth Outlook card (§1) above or below them.
- Leave the AI diagnosis text and Tax planning card in Financial → Diagnose (they're financial-specific).
- Keep the existing "→ turn into goal" button behavior as-is — see §4 for extending it.
- Add a one-line cross-link in Financial → Diagnose where Opportunities/Get Better used to render: "Opportunities and profit ideas have moved to the Growth domain →" so nobody's muscle memory breaks.

---

## 3. Real Growth pillar score

`scorePillar()` (analyze.js ~line 181) currently has no `'growth'` case, so
it falls through to `default: return 6` — a score that never moves. Add a
case following the same additive/subtractive shape `scoreRiskPillar` (~164)
already established, rather than inventing a new scoring style:

```js
function scoreGrowthPillar(fs, priorFs, flags, openOpportunityCount) {
  let score = 6; // neutral baseline when there's no prior period to compare
  if (priorFs?.revenue) {
    const growthRate = (fs.revenue - priorFs.revenue) / priorFs.revenue;
    if (growthRate >= 0.10) score = 9;
    else if (growthRate >= 0.03) score = 7;
    else if (growthRate >= -0.03) score = 6;
    else if (growthRate >= -0.10) score = 4;
    else score = 2;
  }
  // Trading risk flag already fires on 10%+ revenue decline (runFlags ~89) —
  // don't double-penalize, the band above already covers it.
  return Math.max(0, Math.min(10, score));
}
```

Wire it into `scorePillar`'s switch statement the same way `'risk'` calls
`scoreRiskPillar` with a `riskContext` object — pass `fs`/`priorFs` through
(both already in scope at the call site, analyze.js's handler).

---

## 4. Backlog — scoped but not required for v1

- **⬆ PRIORITY (bumped) — 12-month outlook questionnaire**, cloned from `business-risk-questionnaire.js`'s pattern (flat questions per category, 12-month resurfacing, `active` soft-delete) but repointed at hiring/marketing/equipment/expansion/technology/acquisitions instead of risk. Reuses the same DB shape idea — would need its own table (e.g. `growth_checkin_items`) rather than overloading `risk_items`. Bumped ahead of the other backlog items specifically because staffing plans and acquisitions were confirmed to have NO other path into this app — the AI opportunities engine (§ NEXT BUILD, item C) can't reliably surface either one, since it only ever sees financial ratios, never a client's actual hiring/M&A plans. This questionnaire is the only realistic way those two ever get captured. Next candidate for a "NEXT BUILD" pass after pace-to-goal/cash-cost-of-growing/prompt-tweak ship and are reviewed.
- **Extend the "→ turn into goal" button** on Opportunities into a "→ turn into decision" option too, once the Decisions domain (Accept/Discuss/Reject on recommendations, flagged as unbuilt in `workspace-architecture-spec.md`) exists. Build the Decisions interaction once, reuse it for both Risk and Growth rather than building it twice.
- **Feed Opportunities into Meeting Mode's ranking.** `FLAG_SCORING_RULES` (index.html ~601) only scores `flags` — a high-impact Opportunity currently can't reach the top-3 meeting brief no matter how good it is, even though impact/difficulty/timeframe already exist on it. Needs its own scoring path (map difficulty/timeframe to an ease/urgency proxy) merged into the same ranked list `buildMeetingBtn`'s handler produces.
- **Revenue-per-employee KPI**, using `client_context`'s existing (currently unused) employee count field — add to `kpi_library` as a Business Performance Driver, sharpens the flat wages/sales ratio into something growth-relevant.

---

## 5. Trajectory & capacity — a different theme (v2, not yet scoped)

Everything above is "what should we do about growth" (a lever, an AI idea, a
check-in). This section is the other half — growth as trajectory and
capacity, not action. Six ideas, ordered by how much new data capture they
need (least first).

### 5a. Pace-to-goal

Goals already stores a target with a `kpi_key`/`target` pair, read via
`findKpiTarget` (analyze.js ~217, mirrored in index.html). Nobody currently
answers "at the actual growth rate we're seeing, when do we hit that
number — or do we ever?" Build: given the client's historical revenue (or
whatever KPI the goal targets) across however many periods are on file,
fit a straight-line (or simple trend) rate, project forward to the target
value, and surface it as a card — "At this rate: ~14 months to your $2M
target" or "Flat/declining trend — not on track at current pace." No new
schema — reads `financial_snapshots` history + the existing goal target.
Lowest-effort of the six; build this one first alongside §1-3.

### 5b. Cash cost of growing

The classic trap: growth consumes working capital before it pays back — if
revenue grows 20%, debtors and inventory usually grow with it, tying up
cash right when the business feels like it's winning. Nothing currently
connects a growth scenario to its working-capital impact. Build: extend
the Growth Outlook card (§1) — once a revenue growth % is entered, apply
the client's own `debtor_days`/`creditor_days`/inventory-days ratios
(already computed in `computeRatios`, analyze.js ~19) to estimate the
extra cash tied up in debtors/stock at the new revenue level, and show it
alongside the projected profit figure ("+$180k profit, but ~$95k extra
cash tied up in debtors/stock to fund it"). Reuses existing ratios — no
new fields needed.

### 5c. Growth trajectory view (multi-period trend)

Every comparison currently built (ratios, flags, the outlook cards) is
this-period-vs-last-period. Growth is inherently a multi-period story — a
trend chart (revenue, GP margin, net profit across the last 6-8 periods on
file) would show whether growth is accelerating, flattening, or lumpy,
which two-period comparisons hide. The historical data-access pattern
already exists (`get_kpi_history`, used for the health wheel elsewhere in
index.html) — this is mostly a new chart component reading data that's
already reachable, not new plumbing. Read the `dataviz` skill before
building the chart itself.

### 5d. Budget / plan vs actual

BSF's own Benchmarking section (item 3) lists four comparison points —
prior year, prior quarter, **budget**, industry — and only three exist
anywhere in this app today. There is no budget/plan concept at all. This
is the biggest of the six: needs a new table (e.g. `budgets` — client_id,
plan period, target revenue/GP/opex/net profit, probably set annually),
a small entry UI (likely under Growth → Input, a new wired workflow
stage), and a "vs budget" variance shown alongside "vs prior period" on
existing KPI cards. Second-wave — needs the new data capture before it's
useful, unlike 5a/5b/5c which read data that already exists.

### 5e. Non-financial growth drivers

BSF's Business Performance Drivers (average sale, conversion rate, repeat
customers, utilisation, revenue per employee) can't come from Xero — none
of it lives in a P&L. The only unused thread pointing this direction today
is `employee_count` on the client profile (captured, wired into nothing —
same gap `ideas.md` already flagged). Needs a small manual-entry driver
set — likely 3-4 fields chosen per client/industry rather than one fixed
list (a tradie cares about utilisation, a retailer cares about average
sale) — plus somewhere to enter and trend them. Second-wave, same reason
as 5d: new data capture required before this does anything.

### 5f. Business valuation as a growth output (stretch)

Growth's ultimate point, for most owners, is that the business becomes
worth more. A simple multiple-of-EBITDA estimate, tracked period over
period, would turn "revenue is up 12%" into "and the business is worth
roughly $X more than last year" — the number that actually connects
Growth back to Owner Wealth (§ ideas from the Owner domain discussion) and
the exit/succession goals already sitting in `owner_goals`. Nothing in the
schema captures this today. Deliberately keep v1 simple — a stored
multiple (accountant sets it per client/industry), not a real valuation
methodology. Lowest priority of the six — it's a nice-to-have narrative
layer on top of everything else here, not something anyone's currently
missing operationally.

**Suggested build order for this section:** 5a and 5b first (zero new data
capture, both reuse fields/goals that already exist and both give the
accountant something new to say in a meeting). 5c next (new chart, old
data). 5d and 5e after that (both need real new data capture before
they're useful). 5f last, whenever there's appetite for it.
