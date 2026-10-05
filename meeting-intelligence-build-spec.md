# Meeting Intelligence — Build Spec

Written for whoever implements this (Claude Code or otherwise) — references
real function/variable names and line numbers from the current codebase,
same convention as `growth-domain-build-spec.md` and
`owner-wealth-domain-build-spec.md`. Not yet split into approved/backlog
rounds — review the whole thing first and confirm scope before it goes to
code.

This spec covers the redesign worked through interactively as a click-through
mockup (Artifact: `meeting-flow-mockup.html`, published during that session —
ask for the link if it's not at hand) before any code was touched. That
mockup is the reference for exact copy, layout, and interaction — this doc
is the reference for how to wire it into the real app without rebuilding
things that already work.

## The core problem this fixes

Today, `MEETING_STEPS`' financial/growth/risk/owner steps
(index.html ~9946-9949) call the exact same render functions as the
Framework tabs — `renderFinancialAnalyse`, `renderGrowthAnalyse`,
`renderRiskAnalyse`, `renderOwnerAnalyse` — unchanged. The Meeting doesn't
summarize anything; it just re-shows the full Framework screen inside a
different nav shell. Everything below exists to fix that, without touching
the Framework screens themselves — they stay exactly as they are, and
become the "full detail" escape hatch instead of the default view.

---

## 0. What NOT to rebuild

- **The Meeting wizard shell** — `MEETING_STEPS` array (index.html:1053),
  the pill nav, `goToMeetingStep`, `renderMeetingSession`
  (index.html ~9926+) — already exists and works. Only what renders
  *inside* each step changes.
- **`renderFinancialAnalyse` / `renderGrowthAnalyse` / `renderRiskAnalyse` /
  `renderOwnerAnalyse`** (index.html:5218, 5492, 8642, 6941) stay exactly as
  they are. They're not being replaced — they become the "See full detail"
  destination, called the same way they are today, just no longer the
  *default* thing shown when a meeting step opens.
- **Cash Outlook, Tax Outlook, Growth Outlook, and the owner retirement
  projection** (`renderCashOutlookCard` ~2967, `renderTaxOutlookCard`
  ~3654, `projectOwnerRetirementOutlook` 6066) already do real scenario
  math with an "Adjust assumptions" pattern. Reuse these components inside
  the new brief cards — don't reimplement the math.
- **`buildMeetingCandidates`'** (index.html:9857) impact×urgency×ease
  scoring logic is unchanged. Only *when* it runs changes — see §6.

---

## 1. Overview becomes one shared component

`renderOverviewTab` (index.html:4202) is currently just the health wheel +
a raw AI diagnosis paragraph + a pillar-score table, reachable only from
Framework's Overview tab. Refactor it into a function callable from two
places — the existing Framework tab, and a **new `MEETING_STEPS` entry**
(`{ key: 'overview', label: 'Overview' }`) inserted right after
`open_questions`, before `goals`.

Add to its output (all read-only — see the note below):
- **What changed** — 3 bullets, plain deltas vs prior period.
- **What matters** — 3 bullets, the same shortlist the pills get badged
  with (§6), just rendered as text here.
- **Today's priorities** — the top-3 ranked list itself, read-only preview
  (source: §6's ranking). This was in the original design brief and got
  missed in the first pass — it belongs here, not only on the dedicated
  Priorities step.
- **The fuller picture** — one distilled sentence per domain (source: each
  domain's so-what, §3), so a 90-second skim covers all four without
  opening a single detail screen.

**Stays read-only.** No "turn into goal/action" buttons here — every line
is a pointer to something with its own proper affordance elsewhere (the
domain briefs, or the Priorities step). Keep it that way; it's what keeps
this screen a 2-minute orientation instead of another workspace.

---

## 2. Opening check-in — minimal changes

`FIXED_QUESTIONS` (index.html:9161) and `renderMeetingQuestionsStep`
(index.html:10211) already do the right thing: Outstanding Actions + Last
Period's Priorities side-by-side (`meeting-side-cards`, styled per the
comment at index.html:336), then two open questions with a "turn into
goal" affordance and prior-answer reference. **No structural change.**

One addition worth considering: a third default question —
*"Has anything changed in what you want from the business?"* — bridging
directly into §1's Objective context and catching the "actually I want to
work four days a week now" scenario before any numbers get shown. Custom
questions are already supported per-client
(`goals.custom_questions`, index.html:10236), so this can ship either as
copy in this doc for advisors to add themselves, or as a genuine third
`FIXED_QUESTIONS` entry. **Left as an open call — see bottom of doc.**

---

## 3. Domain briefs — new condensed render functions

For `financial`, `growth`, `risk`, `owner`: a new render function per
domain (e.g. `renderFinancialBrief(content)`), swapped in at the meeting
step router in place of the direct `renderXAnalyse(content)` calls
(index.html:9946-9949).

**Shape**, consistent across all four:
1. **So-what** — one sentence, the thing you'd actually say out loud.
2. **Where we are** — 2-3 headline current-state figures (not deltas).
3. **What changed** (or **Live opportunities** for Growth specifically —
   it doesn't have meaningful period-over-period deltas the way the others
   do; it has a live list of things you could do, sourced from
   `data.opportunities`, see §5).
4. **What to do** — pulled from `buildMeetingCandidates`'s output, filtered
   to this domain.
5. **Live scenario widget**, where one already exists — Financial embeds
   Cash/Tax Outlook, Owner embeds the retirement growth-rate control (§4).
6. **"See full detail in [Domain] →"** — swaps the content pane to the
   existing `renderXAnalyse(content)`, prefixed with a **"← Back to
   meeting"** link that returns to the brief. This link needs to become
   general — today it exists in exactly one place (Actions tab,
   index.html:7601, gated on `currentWorkflow === 'input'`) and needs
   generalizing to appear on every domain's Analyse screen whenever a
   meeting is in progress, not just Actions.

**Open question, not solved by this doc:** where does the so-what
*sentence* actually come from? The app already generates `kpi.interpretation`
and a longer `data.diagnosis` paragraph per domain, but nothing today
produces one condensed, speakable sentence. Two options: (a) a new short
field in the AI diagnosis prompt (analyze.js, alongside the existing
`diagnosis`/`get_better`/`opportunities` fields, ~line 540) specifically
for this — most reliable, costs one more field in the JSON contract; or
(b) algorithmic distillation from existing flags/verdicts — cheaper, but
risks reading generic. **Recommend (a).** This is the single biggest open
item in this spec — don't start §3 without deciding it.

---

## 3a. Goals & Objectives brief — same problem, different shape

**This domain was missed in the first pass of this spec and has the
identical bug.** The mid-meeting `goals` step (index.html:9945) calls
`renderGoalsInput(content)` — the exact same function Framework's Goals &
Objectives tab uses (index.html:1627, `currentWorkflow === 'input'`). No
summarizing happens; the full editing workspace shows up inside the
meeting unchanged.

**Why this one needs a different compression strategy than §3.** Goals
isn't a ratio with a delta — it's an open-ended list per category, and on
a client with real history it's a *lot* of items. Checked against the real
Chaillon Investments client during this design pass: **13 open goals
across 4 categories** (Business alone has 9, plus 1 already marked
achieved), and only **2 carry a `needs_review` flag**
(`resolveGoalList`/`needs_review`, index.html ~9328) — everything else
already shows "✓ Reviewed this period," meaning it was reconfirmed before
the meeting even started. The compression insight specific to Goals: **the
brief only needs to surface what's still genuinely open, not summarize
everything that exists.** 11 of Chaillon's 13 goals need zero airtime.

**Shape for the Goals & Objectives brief:**
1. **Objective card** — unchanged from today's `renderObjectiveCard`
   (index.html:8806), shown as-is; it's already a single, glanceable fact.
2. **So-what** — a count-based sentence, e.g. *"13 open goals across four
   categories — almost all already reconfirmed. Only two are flagged for
   a fresh look this period."*
3. **Where we are** — open-goal count, categories, achieved-this-period
   count, needs-review count.
4. **Needs a fresh look** — only the items where `needs_review` is true
   (or, for a client with zero flagged items, this section simply doesn't
   render — don't show an empty "nothing to review" card).
5. **Already settled** — the rest, compressed to a plain list of titles
   only (no detail, no per-item controls) — present for scannability, not
   for discussion.
6. **"See full detail in Goals & Objectives →"** — same escape-hatch
   pattern as §3, dropping into the real, unsummarized `renderGoalsInput`.

**Do NOT build a count-based summary for a category with 0-1 items** —
Wealth (1 item, flagged) and Exit & Succession (1 item, settled) are
short enough that the "already settled" list and the "needs review"
section can just show them directly; the compression logic exists for
Business's 9, not to add ceremony around categories that are already
short.

---

## 4. Live scenario widgets — embed, don't escape-hatch

The first pass of this design put every domain's interactive tooling
behind "See full detail," which defeats the point — modeling a scenario
live, in front of the client, is exactly what you want during the
conversation, not after leaving it.

- **Financial brief**: embed `renderCashOutlookCard` and
  `renderTaxOutlookCard`'s "Adjust assumptions" controls directly (or a
  slimmed variant — the mockup used two inputs: debtors collected this
  quarter, price increase applied — recalculating cash-on-hand, profit
  impact, and tax live).
- **Owner brief**: embed a control for the growth-rate assumption driving
  `projectOwnerRetirementOutlook` (index.html:6066), recalculating
  projected value and gap-to-target live. This likely needs extracting
  just that one control from the larger `renderOwnerAnalyse` screen into
  its own small reusable piece, since it's currently bundled with the full
  detail view.
- Growth and Risk don't currently have an equivalent — not a gap to fix
  here, just noting the asymmetry is expected, not an oversight.

---

## 5. Growth opportunities — add what-it-would-take / risk / decision

`data.opportunities` (read-data.js:103, filtering `recommendations` where
`type = 'growth'`) currently carries just `title` / `impact` / `difficulty`
/ `timeframe`, generated by analyze.js's diagnosis prompt (~line 532-540)
and inserted at ~line 610.

**New migration** — add three nullable columns to `recommendations`:
```sql
alter table recommendations add column if not exists takes text;
alter table recommendations add column if not exists risk text;
alter table recommendations add column if not exists decision text;
```

**Extend the AI prompt** (analyze.js ~540) so each opportunity object also
returns `"takes"`, `"risk"`, `"decision"` — one short line each, matching
the existing `impact`/`difficulty`/`timeframe` style. **Extend the insert**
(analyze.js ~610) to store them. **Extend the render** (both the existing
`renderGrowthAnalyse` opportunity rows and the new Growth brief, §3) to
show them — render gracefully when null, same pattern as other optional
fields elsewhere (existing recommendation rows won't have these until the
next analysis run).

---

## 6. Priorities ranking — compute once, read three times

`buildMeetingCandidates()` (index.html:9857) currently runs lazily, only
when the Priorities step is reached (index.html:10111-10124). It needs to
run once, early — right after the meeting brief loads, cached on `brief`
(e.g. `brief.candidateRanking`) — so the ranking exists before the user
ever clicks the Priorities pill.

That single ranking then feeds three places:
1. **Pill badges** — a small numbered marker on whichever of the
   Financial/Growth/Risk pills contain a top-N item (the mockup used
   ①②③). Owner carries no badge in a period where nothing of Owner's
   ranks — it keeps its normal slot rather than being pulled forward.
2. **Overview's "Today's priorities" preview** (§1).
3. **The dedicated Priorities step**, as today.

**Deliberately NOT included in this round:** physically reordering the
pills themselves by rank. Badging only. Reordering (Risk's pill jumping to
the front of the row when it's the hot issue that period) would mean the
pill row isn't a stable, memorizable layout meeting to meeting — worth
prototyping and testing separately before committing to it, not bundled
into this build.

---

## 7. Framework Summary — new persistent element

A **topbar button**, not a `MEETING_STEPS` entry — reachable from wherever
the health-badge topbar currently renders, in both Framework and Meeting
workflow chrome. Independent of `currentWorkflow` / `meetingStepIndex` —
needs its own small piece of state (open/closed) that survives regardless
of which screen is showing underneath, and restores that screen when
closed.

**Content:** every domain's so-what (§3) + where-we-are figures + full
what-changed/opportunities list + full what-to-do list, concatenated on
one continuous page, grouped by domain heading. This is deliberately
*comprehensive*, not the compressed 3-bullet version Overview shows — it's
the "client calls three weeks later and asks what we said" reference, so
it needs to actually hold the detail, not just point at it.

**Explicitly not needed:** a duplicate entry point in the Framework
sidebar (e.g. after Owner & Succession). The topbar button is already
visible while working in Framework, so a second nav path to the identical
screen adds sidebar clutter without unlocking any use case the topbar
doesn't already cover. Revisit only if real usage shows people expect it
there.

---

## 8. Meeting step order — no code change, just a locked decision

Current `MEETING_STEPS` order — `open_questions → goals → financial →
growth → risk → priorities → actions → owner → goals_wrapup →
close_questions` (index.html:1053-1064, plus `overview` inserted after
`open_questions` per §1) — **stays as-is.** Owner sitting *after*
Priorities/Actions rather than before was a deliberate call: Financial/
Growth/Risk's own so-what sentences already carry the "why" for those
domains' actions, so Actions doesn't need Owner's wealth context injected
first. Owner works better as the bridge *after* Actions — "here's what
this means for you" — leading naturally into Goals check. Don't re-open
this ordering without re-reading this paragraph.

---

## 9. Priorities vs Actions — copy-only clarity

No logic changes — `buildMeetingCandidates`'s output (Priorities, rebuilt
each meeting) and the `action_items` table / `ACTION_STATUS_META`
(index.html:7376, Actions, durable across meetings) are already correctly
separate systems. This section is just making that distinction visible in
the UI: one caption line on the Priorities step ("Agree one, and it
becomes an Action with an owner and a due date") and one on Actions
("What Priorities become once someone commits").

---

## Open decisions before this goes to code

1. **Where each domain's so-what sentence comes from** — new AI prompt
   field (recommended) vs. algorithmic distillation. See §3.
2. **Whether the 3rd opening question ships as a hardcoded default** or
   stays example copy for advisors to add per-client. See §2.
3. **Whether pills should physically reorder by rank**, not just badge —
   deferred, needs its own test. See §6.
4. **Risk and Owner briefs haven't had the same content scrutiny Financial
   and Growth got** in the mockup session — worth a dedicated pass (real
   so-what copy, real where-we-are figures) before implementation, not
   just extending the Financial/Growth pattern by assumption.
