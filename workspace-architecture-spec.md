# OAG Advisory — Workspace Architecture Spec

## The core idea
Three dimensions intersect at every point in the app:
- **Workflow** (horizontal, top tabs): Profile → Input → Analyse → Decisions → Actions → Report
- **Framework** (vertical, persistent left sidebar): the 6 domains — always visible, never disappears
- **Time** (top bar): which period you're looking at — current quarter, prior quarter, annual trend

You don't navigate between "screens." You change which lens (workflow stage) you're looking at the same fixed framework through, for a given period.

## Mapping the 6 domains onto what's already built

The backend (Supabase tables, analyze.js) was built around 8 pillars. Good news — they collapse into your 6 domains almost exactly:

| Your domain | Existing pillar(s)/table | Status |
|---|---|---|
| 🎯 Goals | `owner_goals` (business + personal) | Built — stored on client_context |
| 💰 Financial Performance | `profitability`, `cash_flow`, `tax` + future KPIs/benchmarking | Profitability & cash_flow have real scoring; tax is stubbed; KPIs/benchmarking not started |
| 📈 Growth | `growth` | Stubbed flat score — real logic not built |
| ⚠️ Risk | `risk` + `systems_team` (staff/systems = operational risk, same as your own doc groups them) | Stubbed flat score |
| 👤 Owner | `owner_wealth` (personal wealth/succession — separate from Goals) | Stubbed flat score |
| ✅ Actions | `recommendations` table (already exists) + needs a real task/action tracker (owner, due date, status) | Recommendations exist; action tracking with owner/due/status doesn't exist yet — this is the same gap you flagged earlier about actions carrying over between meetings |

Nothing here conflicts with what's built. The "bones" (Supabase schema, the ratio/flag/scoring engine, the AI diagnosis layer) survive as-is. What changes is the **navigation model** wrapped around them — that's a front-end restructure, not a backend rebuild.

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ ABC Plumbing          Quarterly ▾   Q2 2026 ▾    Health: 81/100 │
├───────────────┬─────────────────────────────────────────────────┤
│ Profile│Input│Analyse│Decisions│Actions│Report   ← workflow tabs │
├───────────────┼─────────────────────────────────────────────────┤
│ ✓ Goals       │                                                 │
│ ✓ Financial   │                                                 │
│   Performance │              MAIN WORK AREA                     │
│ ✗ Growth      │   (changes based on domain selected below       │
│ ✗ Risk        │    × workflow tab selected above ×              │
│ ✓ Owner       │    period selected top-right)                   │
│ ✗ Actions     │                                                 │
└───────────────┴─────────────────────────────────────────────────┘
```

Left sidebar = domains, always present. Ticks/flags show completeness *for the currently selected period* — so switching periods can change which domains show as done.

## Worked example — Financial Performance across every workflow stage

- **Profile**: n/a (this domain has no profile-stage content)
- **Input**: Xero sync / manual entry / PDF upload for revenue, COGS, wages, etc.
- **Analyse**: ratios, trend vs prior period, flags (e.g. "debtor days up 9")
- **Decisions**: recommendations with estimated $ benefit, Accept / Discuss / Reject
- **Actions**: accepted recommendations become tasks — owner, due date, status
- **Report**: auto-compiled summary of all of the above for this domain

Same data. Same domain. Six different views of it.

## What's genuinely new vs what already exists

**Survives untouched:**
- `financial_snapshots`, `client_context`, `flags`, `pillar_scores`, `health_scores`, `diagnostics`, `recommendations` tables
- The ratio engine and Claude diagnosis layer in `analyze.js`
- Xero/manual/PDF data entry logic

**Needs building:**
- The layout shell itself (top bar, left framework sidebar, top workflow tabs) — this replaces the current Overview/Data entry/Analysis/Report tab structure entirely
- An Accept/Discuss/Reject state on recommendations (currently they're just displayed, no interaction)
- A real actions/task table — owner, due date, status, and carrying open items into the next period (the thing you flagged as missing weeks ago)
- A period/time selector, and trend views comparing periods
- Real scoring logic for Growth, Risk, Owner, and Tax variance (still stubbed)
- KPIs/benchmarking (needs more real client data before it's meaningful — already flagged as a later step)

## Coverage check — all 14 original framework items, none dropped

| Original item | Lives in domain | Confirmed |
|---|---|---|
| Goals | 🎯 Goals | ✓ |
| Financial Health | 💰 Financial Performance | ✓ |
| Benchmarking | 💰 Financial Performance | ✓ |
| Cash Flow | 💰 Financial Performance | ✓ |
| Tax | 💰 Financial Performance | ✓ |
| KPIs | 💰 Financial Performance | ✓ |
| Profit Improvement | 📈 Growth | ✓ |
| Growth | 📈 Growth | ✓ |
| Opportunities | 📈 Growth | ✓ |
| Risk | ⚠️ Risk | ✓ |
| Owner Wealth | 👤 Owner | ✓ |
| Decisions | ✅ Actions | ✓ |
| Action Plan | ✅ Actions | ✓ |
| Health Score | **Global — top bar, not a domain** | ✓ (improved) |

One deliberate change from the original draft: Health Score was nested under Financial Performance/KPIs in the first pass, but since it's actually computed from all 8 pillars, it belongs as a global indicator in the top bar (next to client name and period), not inside one domain. That's already how the spec above has it.

Also confirmed: the existing backend's `systems_team` pillar (staff/systems) folds cleanly into ⚠️ Risk, exactly as your own "Operational Risk: Staff, Suppliers, Systems" breakdown already had it — no new domain needed for it.

## Why this shape (and not a wizard)

Considered and rejected: a linear step-by-step wizard (one guided sequence, no free navigation). Simpler to build, but loses the thing that makes this valuable — a permanent, jumpable "state of the client" rather than a one-way form. Kept instead: framework (left) + workflow (top), both always visible, because neither should disappear when you interact with the other.

Added on top: a **"Start meeting" mode** — during a live client sit-down, auto-advance through domains in a sensible order for speed, while the full matrix stays available underneath for prep and review outside meetings. Best of both: guided when you need speed, fully explorable when you don't.

## The layer above the matrix — Analysis Engine vs Decision Engine

Everything above is the **Analysis Engine** — the cockpit. Full detail, all domains, all KPIs, built for the accountant's prep time.

On top of it sits a **Decision Engine** — a synthesis view for the actual meeting. Same data, ranked and cut down to what's worth talking about:

```
TODAY'S MEETING — ABC Plumbing          Health: 84/100

① Cash Flow — High priority
   Debtor days up 18. ~$220,000 potentially trapped.
   → Discuss collections process.

② Pricing — Medium priority
   Margins down 3%. A 2% price rise restores it.
   → Estimated benefit: +$48,000.

③ Tax — Medium priority
   Estimated tax payable: $86,000.
   → Equipment purchase before year-end reduces this.
```

Click into any of the three and you drop into that domain's full Analyse view (the matrix) for the supporting detail — KPIs, trend, benchmark. Same data, different depth.

**This becomes the landing screen** when you open a client — before the matrix, not instead of it. The matrix is always one click away for anyone who wants the detail.

### What this actually requires building (new, not just relabeling)

1. **A ranking layer.** Flags currently live per-domain with no cross-domain priority. Getting to "Top 3" means scoring each flag by severity + estimated $ impact and picking the highest across *all* domains — real new logic.
2. **The Knowledge Engine, properly scoped.** `analyze.js` currently has 3 hardcoded IF/THEN rules (debtor days, GP margin, current ratio). The goal is a much larger rule library (revenue up + profit down → check labour/materials/pricing; cash down + profit up → check debtors/inventory/capex/loans; margin below industry → suggest pricing/supplier/cost review, etc.) — this *is* the work of building out the other 6 pillars, just correctly framed as diagnostic rules rather than a scoring formula. Recommend storing rules as **data in a Supabase table**, not hardcoded in JS, so the rule set can grow without a redeploy each time.
   - Start with ~15-20 curated rules covering the highest-value, most common scenarios you and Cheryl actually reach for — not an attempt to enumerate the entire discipline of accounting on day one. Grow the rule set from real client meetings over time.
3. **Business Pulse.** A short qualitative check-in (how's business been, any hires, any major purchases planned) captured before/alongside financial review. Doesn't exist in the schema yet — needs a small new table or fields on `financial_snapshots`/`client_context`. Its value: gives the AI diagnosis context, so a margin drop isn't flagged in a vacuum when the real story is "they just hired three people."

None of this conflicts with the framework/workflow/time structure — it's an additional view (Command Centre) plus a smarter engine feeding both it and the existing domain matrix.

## Two modes, not one continuous workflow

**Prep Mode** (before the meeting): full matrix, free navigation across all 6 domains and Input/Analyse/Diagnose. Ends with **Build Meeting** — which locks a **Meeting Brief**, a snapshot of the top priorities, not a live view. Locking it matters: numbers shouldn't shift mid-conversation, and it forces diagnosis to be finished before walking in rather than improvised live.

**Meeting Mode** (during the client sit-down): runs off the locked Meeting Brief. Forward-only — no backward jumping into raw KPIs by default. Full detail sits behind a "Show detail" click on any priority, for when a client asks "why."

## Priority scoring — Impact × Urgency × Ease

Every flagged issue across every domain gets scored on three axes and ranked by the product, not just by $ estimate:

| Issue | Impact | Urgency | Ease | Priority |
|---|---|---|---|---|
| Debtors | 9 | 8 | 8 | 25 |
| Pricing | 8 | 6 | 9 | 23 |
| Insurance | 4 | 9 | 5 | 18 |

Top-ranked issues become the Meeting Brief's priorities — this is the concrete mechanism behind the ranking layer noted above.

## Three-engine architecture (regrouping, not new work)

- **Data Engine** — Xero sync, manual entry, PDF extraction. Already built.
- **Intelligence Engine** — the domain matrix, KPIs, ratios, and the Knowledge Engine's IF/THEN rules. This is where the full 14-item framework lives and gets analysed. Already spec'd above as "Analysis Engine" + "Knowledge Engine."
- **Advisory Engine** — turns Intelligence Engine output into the Meeting Brief, priority ranking, discussion questions, and the auto-generated report. Already spec'd above as "Decision Engine," now more precisely defined via Prep/Meeting modes.

## Suggested build order — get the top bar + left sidebar + top tabs feeling right before wiring anything real. This is where the "wow" either lands or doesn't, so it's worth nailing before connecting data.
2. **Wire the Financial Performance domain fully** across all 6 workflow stages — it already has the most backend built, so it proves the whole model works end-to-end fastest.
3. **Extend the same pattern to the other 5 domains** — each one is now a known, repeatable shape rather than a new design problem.
4. **Add the Time dimension** — period selector, trend comparisons.
5. **Build the Actions tracker properly** — this is the piece that turns a report into an ongoing advisory relationship rather than a one-off document.
