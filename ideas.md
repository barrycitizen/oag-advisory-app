# Ideas & suggestions — not yet built

Things discussed/proposed during development but not implemented. For the
big-picture product roadmap (Growth/Risk/Owner/Actions domains, Decision
Engine, Knowledge Engine rule library, Business Pulse, Meeting Brief
ranking), see `workspace-architecture-spec.md` — this file is the more
granular stuff that came up while building out Financial Performance/KPIs/
cash reconciliation specifically.

## Data quality — needs action

- **Chaillon's `total_debt` likely includes the director loan.** Confirmed
  the director loan is buried inside the "Loans" figure on Chaillon's
  payables note rather than tracked separately. Once you have the actual
  director loan balance from that note (for whichever periods it applies
  to), it should be subtracted out of `total_debt` and entered into the new
  `director_loan_balance` field instead — otherwise Chaillon's Borrowings
  tile will keep double-reading as bigger than it really is, and Owner will
  stay understated.

## Risk Register — the bigger vision (Phase 2/3, unbuilt)

You originally pasted a much fuller risk framework than what's actually
built. What exists now (`runFlags()` in `analyze.js`) is deliberately just
**Phase 1**: deterministic signals computed straight from the financial
numbers — Cash-flow risk, Pricing/cost pressure, Leverage risk, Liquidity
risk, Trading risk, Cost structure pressure, Debt servicing risk, Stock/cash
risk, Tax/cash-flow risk — each tagged with a `risk_category` and an
optional `impact_estimate`, shown in the Risk Review section each period.

The fuller vision, not built:
- **Business risks** beyond the purely financial ones — people/key-person
  risk, customer concentration, supplier dependency, operational/process
  risk, legal/compliance exposure, technology/systems risk. None of these
  can be detected from the numbers alone; they need a human answering
  questions (fits the "Business Pulse" idea in `workspace-architecture-spec.md`
  — check-in questions captured alongside the financials).
- **Industry-specific risk checklists** — risks that matter for a specific
  trade/industry that a generic financial-ratio scan would never surface.
- **A lifecycle, not a one-off flag list**: risks move through states —
  **Detected → Identified → Watch → Managed** — rather than just appearing
  and disappearing each period with no memory of what was already raised,
  discussed, or actioned.
- **Closed-loop tracking**: a risk raised in one meeting should carry
  forward and show its status/trend at the next one, connecting to the
  Actions tracker (also unbuilt — see `workspace-architecture-spec.md`)
  rather than resetting to a blank slate every period.
- A **"risk sidebar"** — some persistent, always-visible risk-status view
  (as opposed to Risk only appearing inside the Risk domain tab when you
  navigate to it) was discussed as one way to surface this, so risk status
  doesn't require deliberately going looking for it.

Note: this section is reconstructed from my working memory of that
conversation, not the original document you pasted — if you still have
that framework doc, worth re-sharing it before this actually gets built, so
nothing from the original gets lost in my summary of it.

## Capex / asset disposal accuracy

- **The capex estimate (`Δfixed_assets + depreciation`) and the derived
  Operating Cash Flow both silently distort if an asset was disposed of
  during the period.** There's no field for disposal proceeds or gain/loss
  on sale, so a sold van or piece of equipment would currently just throw
  off the numbers with no warning beyond the existing generic "assumes no
  disposals" caveat. Would need `asset_disposal_proceeds` and/or
  `gain_loss_on_disposal` fields, plus logic in both `deriveOperatingCashFlow`
  and the capex estimate to correct for it.
- **Same issue would apply to financial investments** (shares, term
  deposits) if a client held any — deliberately not built since it's rare
  for this client base, but worth remembering if a client with an
  investment portfolio comes up.

## Benchmarking

- **Industry benchmarks are currently AI general-knowledge guesses**
  (explicitly caveated as "not verified" in the UI). A real data source
  (ATO small business benchmarks, an industry association's published
  ratios, etc.) would let these become verified figures instead of
  estimates — a genuinely bigger, separate integration.
- **Industry field is loose free text.** Discussed whether something like
  "Aramex courier" deserves its own more specific category than a generic
  "courier/logistics" bucket, to sharpen AI benchmark relevance — no
  taxonomy or structured industry list was built, still free text.
- **Employee count isn't wired into anything.** It's captured on the client
  profile but nothing currently uses it — the obvious use is a $-per-employee
  or headcount-adjusted wages benchmark, sharper than the current flat
  wages/sales ratio. Deliberately left as-is for now.

## Cash reconciliation follow-ons

- **The "click a number, jump straight to where it's entered, with a back
  button" pattern only exists on the cash reconciliation panel right now**
  (Change in cash balance, Operating cash flow's components, Net change in
  borrowings, etc.). The same UX would be genuinely useful on other KPI
  cards too — e.g. click "GP margin 30.7%" and jump to the revenue/COGS
  fields it's built from.
- **The OCF derivation's debtor/creditor/inventory delta rows don't have
  prior-period jump links** the way the cash balance and debt balance rows
  do — scoped out at the time as a smaller thing not directly asked for,
  not because it wouldn't be useful.
- **"Where the cash went" and the Operating Cash Conversion donut/narrative
  aren't surfaced anywhere outside the Analyse tab** — not in the Meeting
  Brief, not in the Report. Given how much work went into making this
  reconciliation genuinely explain itself, it seems wasted if a client never
  sees it outside the prep-time matrix view.

## Smaller technical debt

- **`KPI_DIRECTION` (which way is "better" for green/rust coloring) is a
  hardcoded JS lookup in `index.html`**, not a `kpi_library` column —
  deliberate at the time to avoid a schema change for a presentation-only
  concern, but worth formalizing into the database if more KPIs get added
  later and this file-based approach gets unwieldy.
- **Xero-pull's label matching for `director_loan_balance` and
  `fixed_assets` is best-effort and untested against a real Xero account.**
  Chart-of-accounts naming varies a lot between clients; the current label
  list is a reasonable guess, not validated against live data yet.
