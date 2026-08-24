# Owner Wealth Domain — Build Spec

Written for whoever implements this (Claude Code or otherwise) — references
real function/variable names from the current codebase, same convention as
`growth-domain-build-spec.md`. Not yet split into approved/backlog rounds —
review the whole thing first and confirm scope before it goes to code, the
way the Growth spec was narrowed down before its first build round.

## 0. Rename, and what NOT to rebuild

**Rename the domain tab.** `DOMAINS` (index.html ~535) currently has
`{ key: 'owner', label: 'Owner' }`. Change the label to `'Owner Wealth'`.
Keep the `key` as `'owner'` unchanged — `PILLAR_TO_DOMAIN`,
`WIRED_WORKFLOWS`, and anything else keyed on `'owner'` stays untouched;
this is a display-label-only change. Reason: "Owner Goals" already exists,
fully built, as its own thing (see below) — leaving a separate domain
just called "Owner" next to it is confusing about which one covers what.

**Owner Goals is already fully built — do not duplicate it here.** The
Goals domain's `GOAL_CATEGORIES` (index.html ~4462) already covers
personal, business, income, lifestyle, and exit/succession — the exact
five items from the "Owner Goals" review list. Nothing new needed for
that half. Owner Wealth (this spec) is specifically the OTHER list —
super, investments, debt, property, succession/estate planning as actual
numbers, not goals/intentions.

**Cadence:** `owner_wealth` is already annual-only in `CADENCE_PILLARS`
(analyze.js ~16) — matches this being a once-a-year check-in, not a
quarterly one. Nothing to change there.

**Scoring is intentionally left open.** `scorePillar`'s `default: return 6`
case (analyze.js ~202) still covers `owner_wealth` — this spec does NOT
propose a real 0-10 score for it. Unlike Growth (where "revenue growing"
is a defensible good/bad signal), whether a given net worth number is
"good" depends entirely on age, goals, and circumstances the app doesn't
know — a formula here risks being actively misleading. Leave it as a
placeholder unless/until there's a specific, defensible way to score it.

---

## 1. Net worth tiles — the foundational data capture

**What it's for:** right now nothing captures super, investments,
property, or personal debt anywhere in the schema. This is the base
everything else in this spec sits on top of — a simple personal net
worth tracker, one number per bucket, summed to a total.

**New migration** (`migration_owner_wealth.sql`):

```sql
create table if not exists owner_wealth_snapshots (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null,
  period_end    date not null,
  super_balance numeric,
  investments   numeric,
  property      numeric,
  other_assets  numeric,
  debt          numeric,
  notes         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (client_id, period_end)
);
```

Net worth = `super_balance + investments + property + other_assets - debt`
(plus the business equity cross-reference tile, §5 — NOT stored in this
table, kept as a live read from `business_valuations` so the two numbers
never drift out of sync with each other).

**New `read-data.js` action**, e.g. `get_owner_wealth` — returns this
client's `owner_wealth_snapshots` rows (probably just fetch the last 2-3
years, this is annual data so there won't be many rows), plus — if
`business_valuations` exists for this client (Growth Round 2) — the most
recent valuation row for §5's cross-reference tile.

**New `manual-entry.js` write action**, e.g. `save_owner_wealth` — upsert
on `(client_id, period_end)`, same pattern as `health_scores`/
`business_valuations`.

**Frontend:** `WIRED_WORKFLOWS` (index.html ~552) has no `owner` entry at
all right now, so it's in the "nothing wired, show placeholder" bucket —
add `owner: ['input', 'analyse']`. Build:
- `renderOwnerInput` — one tile per bucket (Super, Investments, Property,
  Other, Debt), each an editable number field, same visual style as the
  Financial Performance input fields.
- `renderOwnerAnalyse` — shows the total (assets minus debt), the §3
  outlook card, and the §4 succession summary.

---

## 2. Debt — its own tile, not folded into "Other"

Already covered by the `debt` column above — called out separately here
because the original framework lists "debt reduction" as its own line
item, and burying it inside "Other assets" would make it too easy to
overlook. Subtract it from the total rather than showing it as a plain
positive tile.

---

## 3. Retirement outlook — per-bucket projections, plus one-off changes

Your two original ideas (a growth/compounding projection, and a
retirement-number calculator) are still one tool, not two — the "what
will it be worth in N years" question and the "is that enough" question
share the same inputs. But this is now a richer version than a single
blended growth rate: each bucket gets its own rate, and the plan can
include one-off changes at specific years (an extra super contribution,
a planned withdrawal, proceeds from selling a property). This is a
deliberate upgrade from a single "one blended rate" v1 — per-bucket rates
are MORE accurate, not just more complex, because super/investments/
property genuinely do compound differently in real life. This is a
different kind of complexity from the inventory-as-a-profit-lever
question flagged in the Growth spec — that was stacking unrelated
speculative guesses onto one number; this is giving each bucket its own
honest, separately-reasoned assumption.

**Same UI pattern as the existing Outlook cards** (Tax/Cash/Growth
Outlook — collapsed "Adjust assumptions" panel, live recalc on input,
plain-language buildup line) for the overall card shell — clone that
convention. The per-bucket rates and one-off-changes list are new
interaction patterns on top of it (below).

**Per-bucket rate inputs:** each of the five tiles from §1 (Super,
Investments, Property, Other, Debt) gets its own small "expected annual
rate" input sitting on that tile, instead of one rate for the whole
total. Debt's rate would typically be entered as negative (being paid
down) or left at 0% (interest-only) — don't force a different UI just
for debt, same input type, sign carries the meaning.

**One-off changes — a small repeatable add/remove list**, same UI shape
as the app already uses elsewhere for adding items to a list (e.g. the
business risk questionnaire's "add a new question," or adding a Goals
item) — don't invent a new list-editing pattern, reuse the existing one.
Each row: a dollar amount (positive or negative), which bucket it applies
to, and years-from-now it happens. Examples an accountant would type:
"+$50,000 to Super in 2 years" (extra contribution or inheritance),
"-$120,000 from Investments in 5 years" (funding a planned purchase),
"+$400,000 to Other in 8 years" (expected proceeds from selling an
investment property).

**Calculation — year-by-year per bucket, not one closed-form multiplication:**
the single `current × (1+rate)^years` formula no longer works once each
bucket has its own rate and can have one-off changes landing in arbitrary
years. Instead, for each bucket, run a simple loop:

```js
function projectBucket(startValue, annualRatePct, years, oneOffEvents) {
  let value = startValue;
  for (let y = 1; y <= years; y++) {
    value *= (1 + annualRatePct / 100);
    oneOffEvents
      .filter((e) => e.bucket === thisBucketKey && e.yearsFromNow === y)
      .forEach((e) => { value += e.amount; });
  }
  return value;
}
```

Run this once per bucket, sum the results for the target year to get
projected total net worth at retirement (this replaces the single-total
projection the earlier version used), then continue exactly as before:

- Target nest egg needed = desired annual income ÷ withdrawal rate.
- Show projected total vs target, and the gap, plainly: "Projected: $1.4M.
  Target for $80k/year at a 4% withdrawal rate: $2M. Currently $600k short
  at this trajectory" — or "on track" if the projection clears the target.
- Safe withdrawal rate stays an editable input, default 4%, caveated on
  the card as a general rule of thumb, not personalised advice.

**Caveat, shown on the card itself:** this is a simple rule-of-thumb
projection, not a retirement or financial plan — same spirit as the
Valuation card's caveat in the Growth spec.

**Where "years to retirement" comes from:** see §4 below — if a
succession goal has a target year set, default this field from that
instead of asking for it separately.

---

## 4. Succession — read from Goals, don't duplicate the data, but DO connect it to the numbers

**What this section is actually for:** not just showing the succession
text a second time — the real point is testing whether a stated exit
plan is financially realistic. "Client wants to exit in 6 years" and
"here's whether the projected net worth (including what the business is
likely worth by then) actually supports the retirement they want" are
two different things — the plain-mirror version only did the first.

**Still don't build a second data entry point.** Goals already has an
`exit_succession` category (`GOAL_CATEGORIES`, index.html ~4466) — that
stays the one place the qualitative plan (who takes over, roughly when,
how) gets typed in. `renderOwnerAnalyse` reads whatever's already saved
there (same data path Goals itself reads,
`currentCtx.owner_goals.periods[currentPeriodEnd].cats.exit_succession.items`)
and shows it as a summary card here, with a "→ edit in Goals" link — same
cross-link pattern already used between Financial Diagnose and Growth
(§2 of the Growth spec).

**New: an optional target year on a succession goal item.** Goal items
already optionally carry a `kpi_key`/`target` pair for KPI-linked goals
(see `findKpiTarget`, analyze.js ~217) — reuse that exact pattern rather
than inventing a new field shape. Add an optional `target_year` to a
goal item, offered specifically when adding/editing an item in the
`exit_succession` category (e.g. "planning to exit in: [year]"), not on
every goal item everywhere.

**The connection:** when `renderOwnerAnalyse` loads the §3 Retirement
Outlook card, check whether any `exit_succession` item has a
`target_year` set. If one does, default the outlook's "years to
retirement" input from `target_year − current year`, and show it clearly
sourced ("years to retirement: 6, from your succession plan") rather than
just a bare pre-filled number, so it's obvious where the default came
from and that it's still editable if the accountant wants to model a
different timeline. If no succession goal has a target year, fall back to
asking for it directly (unchanged from the earlier design) — this is a
default, not a requirement to fill in Goals first.

---

## 5. Business equity — cross-reference tile, only if Growth's Valuation feature exists

If `business_valuations` (Growth Round 2 spec) has a row for this client,
show its latest `valuation_amount` as one more read-only tile in the net
worth summary: "Value of the business (from Growth → Valuation, as of
[period]): $X." This is what directly answers the framework's own
question for this section — "is the business helping achieve personal
wealth goals" — with an actual number instead of a conversation.

**Don't store this number in `owner_wealth_snapshots`** — read it live
from `business_valuations` each time, so the two tables can't drift out
of sync with each other. **Gracefully hide the tile** if no valuation
exists yet for this client (don't build it before Growth's Valuation
feature, and don't error if it's simply never been used) — this is
exactly why it's listed last, as a dependency on already-approved but
not-yet-built work.

---

## Open questions before this goes to code

1. Confirm the withdrawal-rate default (4% suggested) is one you're
   comfortable with as the pre-filled assumption, since it'll be the
   first number every accountant sees on this card.
2. ~~Blended vs per-bucket growth rates~~ — resolved: per-bucket, with
   one-off changes (§3).
3. Should Owner Wealth show only the latest year's numbers, or a simple
   year-over-year net worth trend once 2+ years are on file (same
   dedupe-by-year approach as the Valuation card's comparison line)?
4. One-off changes (§3) are one-time only in this design — a single
   amount at a single year. If you also want RECURRING changes ("extra
   $10k into super every year for 5 years"), that's a further step up in
   complexity (each recurring entry expands into multiple yearly
   amounts) — confirm whether one-off-only is enough for v1 before
   that's built in, rather than adding it by default.
