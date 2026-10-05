# OAG Advisory App — Full Audit Report

**Date:** 5 Oct 2026 · **Scope:** `index.html` (15.5k lines), 10 Netlify functions + 9 libs, Supabase schema/data, UI at 375/1024/1280px · **Context:** single user, run locally via `netlify dev` (localhost:8888), not deployed.

**Verdict: READY WITH WARNINGS** for local, single-user use. **NOT READY** to deploy or share as-is (see H4, H2).

---

## What was done

| Area | How |
|---|---|
| Existing tests | None existed (no test runner, linter, type checker or build). Built a suite: **55 tests** (`npm test`, `npm run test:api`, `npm run test:all`). |
| Dependencies | `npm audit`: 0 vulnerabilities. `@supabase/supabase-js` 2.112 (2.117 available). |
| Secrets | `.env` never committed to git. Service key + Anthropic key used server-side only. Public anon key in `index.html` verified harmless: RLS blocks **reads and writes** (0 rows; insert → 401). |
| Database | Read schema via PostgREST metadata; scanned every client table for duplicates and orphans (none). |
| API | 22 live edge-case tests on a throwaway client (malformed JSON, junk/huge/negative numbers, impossible dates, 20k-char text, HTML/emoji, cross-client edits, parallel writes, cross-site requests). |
| Failure testing | Simulated server down / HTTP 500 / garbage responses on 5 screens; AI API 529/429/empty/truncated on analysis. |
| UI | Every screen × both clients × 4 periods; all 11 meeting steps; full user journey (analyse → meeting → decisions → finish → report → edit figures → re-run); double-click/Enter-repeat; 375/1024px layouts; accessibility scan. |

---

## CRITICAL — data loss (both FIXED)

### C1. A quick edit on Analyse silently wiped a period's division split — FIXED
- **File:** `index.html` — the three quick-save handlers in `renderHealthWheelBlock` (OCF adjust, single balance field adjust, borrowing panel)
- **Description:** These rebuild the full `financials` payload from the snapshot but omitted `division_breakdown`. `saveFinancials` treats "no breakdown sent" as "not split" and nulls it.
- **Reproduce (before fix):** Chaillon FY23 (split: Jim's Auto Service / Glenn's Service Centre) → Financial Performance → Analyse → adjust any balance and save. `division_breakdown` became `null`. Reproduced via the identical request; data restored afterwards.
- **Why it matters:** Silent, permanent loss of divisional figures for any multi-division client.
- **Fix:** All three callers now pass `snapshot.division_breakdown` through.

### C2. An AI API error during "Run analysis" wiped the existing analysis — FIXED
- **File:** `netlify/functions/analyze-background.js` (handler, Claude call)
- **Description:** A non-200 reply (overloaded/rate-limited/bad key) fell through as `'{}'`; the run then deleted the period's flags, scores, recommendations and diagnostics and wrote blanks — reporting success.
- **Reproduce (before fix):** Anthropic returns 529 → analysis "completes", recommendations gone.
- **Fix:** Checks `res.ok`, content present, JSON parses and has a diagnosis — **before** any delete; otherwise records a clear "Nothing was changed — try again" error.
- **Test:** `tests/unit/analysis-failure.test.js` (4 cases; verified failing on the old code, passing on the new).

---

## HIGH

### H1. A failed load showed the previous screen's content (or "no data") — FIXED
- **File:** `index.html` — `callRead`, `renderMain`, `refreshHealthBadge`, `loadClients`, run-analysis poll
- **Description:** Server down / garbage → render threw midway, leaving the *previous* tab's content under the new tab name (e.g. Report showing Analyse's "Run analysis" button). HTTP 500 → screens rendered as empty (Analyse said "Enter this period's figures first").
- **Fix:** `callRead` throws on non-2xx/unparseable; `renderMain` shows "Couldn't load this screen — <reason>" with **Try again**. Verified on 15 failure combinations, zero unhandled rejections, full recovery; no regressions on 4 client/period sweeps or 11 meeting steps.

### H2. Concurrent saves lose data (read-modify-write on JSON columns) — OPEN
- **File:** `netlify/functions/manual-entry.js` — `saveRecommendationState`, `saveMeetingRecord`, all `owner_goals` handlers (goal items, pulse/check-in answers, questions, categories)
- **Description:** Each reads the whole JSON column, changes one key, writes it all back. Two saves in flight → the later overwrites the earlier.
- **Reproduce:** `tests/api.integration.test.js` fires 6 parallel rec-state writes → **only 1–2 of 6 survive**. Same pattern for goals/check-in answers, and for two browser tabs on the same client.
- **Mitigation already in place:** the UI queues recommendation-state saves within one tab (`postRecState`).
- **Recommended fix:** Postgres RPC functions that update one key atomically (`jsonb_set` / `||` in a single `UPDATE`), or an `updated_at` version check with retry. Needs a migration — not changed here.

### H3. Any website could trigger writes on the local server (CSRF) — FIXED
- **File:** all 10 functions; new `netlify/functions/lib/same-origin.js`
- **Description:** No auth + plain-text POSTs need no CORS preflight → a page open in another tab could fire e.g. `delete_client` (Riverside's id is all 1s) or `save_tax_rates_by_fy` (global). Responses weren't readable cross-site (no ACAO header), but the actions ran.
- **Fix:** Requests whose `Origin` doesn't match the host are refused with 403 before running. Tests: unit + live (403 for evil origin, write doesn't land; app's own requests unaffected).

### H4. No authentication or authorization anywhere — OPEN (CRITICAL if deployed)
- **Files:** every function; they use the Supabase **service key** (bypasses RLS) and trust any `client_id` in the body.
- **Why it matters:** Locally, only your browser reaches it (and H3 now blocks other sites). If deployed, anyone with the URL could read, change or delete every client.
- **Recommended fix before any deployment:** Netlify Identity or Supabase Auth; verify the user in each function; scope every query to clients that user may access.

### H5. Typed and AI text wasn't escaped — text swallowed, edits truncated — FIXED
- **File:** `index.html` — 34 interpolations (goals, custom questions/categories, division names, risk names/notes/details, AI titles/impacts/talking points, flags, client names in the dropdown)
- **Reproduce (before fix):** a goal "Keep GP margin <target until costs settle" displayed as "Keep GP margin" and broke the row; a division or question containing `"` was cut at the quote in its edit box, and saving lost the rest.
- **Fix:** wrapped in `escAttr`. Fixed labels from code left alone (some intentionally contain HTML).
- **Test:** `escAttr` unit tests incl. the `<target` regression.

### H6. Non-numeric figures silently saved as blank — FIXED
- **Files:** `manual-entry.js` (`saveFinancials`, `cleanDivisionBreakdown`), `index.html` (`me-save-financials`)
- **Description:** `Number('12,345')`/`'abc'` → `NaN` → JSON `null`: the figure vanished with no error. A pasted "12,345" in a number box also reads as empty in the browser.
- **Fix:** server `toNumberOrNull` rejects with the field named; form refuses to save while any box holds unreadable input and names it.
- **Tests:** unit (`toNumberOrNull`, division cleaning) + API.

---

## MEDIUM

| # | Status | Where | Issue | Fix / recommendation |
|---|---|---|---|---|
| M1 | **Fixed** | `index.html` create-client, add action (Enter key), add goal category, add check-in question | Double-click / Enter-repeat created duplicates. Verified: 3 clicks → 1 client; Enter, Enter, click → 1 action. | Buttons disable during the request; Enter path checks it. |
| M2 | **Fixed** | `read-data.js` `get_context` | Missing client → HTTP 500 (`.single()`). | `maybeSingle()`; API test. |
| M3 | **Fixed** | Report CSS `.report-figures` | Windows < ~1100px clipped "$1,026,783" to "$1,026,". | Tiles wrap on screen; print keeps 5 across. Verified 0 clipped/overflowing on 11 screens at 1024px. |
| M4 | Open | `pdf-extract`, `suggest-goal`, `tax-question`, `risk-advice`, `risk-summary`, `expand-text` | Don't check the AI API status; on overload they return blank/odd output with an unhelpful error. No data loss (they don't delete). | Same `res.ok` + content check as C2; consider one retry with backoff. |
| M5 | Open (warned) | Recommendation decisions | Keyed by AI-written title; a re-run writes new titles, so decisions/dismissals stop applying. | Run analysis now warns first. Longer term: stable ids on `recommendations` rows. |
| M6 | Open | Meeting cache (`localStorage`) | Two tabs on one meeting: each keeps its own cache; last save wins; the other tab never refreshes. | Re-read the server copy on focus, or version-check on save. |
| M7 | Open | Navigation | No URL/history: Back leaves the app; refresh loses client, period and tab. | Store selection in the URL hash. |
| M8 | Open | Database | Core tables (client_context, financial_snapshots, flags, pillar_scores, health_scores, diagnostics, recommendations, kpi_library, xero_connections) have **no migration in the repo**; most tables have no foreign keys; `deleteClient`/`deletePeriod` run table by table (a mid-way failure leaves a partial delete). | Export the schema to a migration; add FKs with `on delete cascade`; do deletes in one RPC transaction. |
| M9 | Open | Layout | Not usable on a phone: no viewport meta tag, fixed 260px sidebar (renders as a zoomed-out desktop). Fine at 1024px+. | Only if mobile use is wanted. |
| M10 | Open | All functions | Raw database errors are passed to the UI (e.g. `invalid input syntax for type date`). Low risk locally. | Map to friendly messages; log the detail server-side. |
| M11 | Open | `xero-pull.js` | `period_end` not validated before going into the Xero URL; aged receivables/payables fetched but never used (2 wasted API calls per sync); warning says unmatched fields "were saved as 0" but they're saved as null. Untested against a live Xero org (per `ideas.md`). | Validate the date; drop or use the aged reports; fix the message. |

---

## LOW

| # | Where | Issue |
|---|---|---|
| L1 | `formatMoney` | Negatives display as "$-1,234" (conventional: "−$1,234"). |
| L2 | `today()` | Uses the UTC date — before 10am AEST "today" is still yesterday (overdue flags can be a day late). |
| L3 | 7 functions; tax tables | AI model id `claude-sonnet-4-6` hard-coded 7×; FY2026-27 tax brackets and the KPI engine duplicated client/server (kept in sync by hand). |
| L4 | Database | Unused tables: `actions`, `advisory_reports`, `owner_data_updates`, `business_data`, `kpi_results`, `industry_kpi_presets`, `pmdr_data` (1 row — looks like another project). |
| L5 | `index.html` | Unused `SUPABASE_URL`/`SUPABASE_ANON_KEY` constants (the key is public by design; RLS verified). |
| L6 | Accessibility | 35 inputs had visible but unlinked labels — **financial form fixed** (`for=`), page `lang="en-AU"` **added**; Goals/Profile fields remain. All buttons have accessible names. |
| L7 | Performance | Overview/Report fetch `get_kpi_report` twice; Growth fetches `get_growth_trajectory` twice. Otherwise 1–7 calls/screen, ≤20 KB, ≤210 ms. `get_context`/`get_action_items` return all history (fine for years at this size). |
| L8 | Functions | No HTTP-method checks; `analyze-background` parses the body outside its try. |
| L9 | Tooling | `netlify dev` crashed once while hot-reloading edited functions (CLI fault, not app code). |
| L10 | Maintainability | Single 15.5k-line HTML file, no build/lint/type checking. |

---

## Checks that passed

- No duplicate or orphaned rows in any client table; health score consistent across topbar, Overview, Report.
- Edits keep other fields intact (form save round-trip: 0 field changes); done-date preserved on edit.
- Invalid status/owner values fall back safely; another client's action can't be edited by id.
- Impossible dates rejected; 0, negatives and 1e12 round-trip exactly; 20k-char text and emoji/HTML stored verbatim.
- Empty-period analysis refused (UI + server).
- No TODO/FIXME, no stray `console.log`.

---

## Tests added

`npm test` (unit, no server needed) · `npm run test:api` (needs `netlify dev`) · `npm run test:all`

| File | Tests | Covers |
|---|---|---|
| `tests/unit/frontend-logic.test.js` | 16 | escaping, money/KPI/date formatting, score bands, financial score, not-scored areas, cash in/out + story, "since last meeting" |
| `tests/unit/server-logic.test.js` | 10 | pillar scoring (incl. not-scored), growth/risk bands, OCF derivation, KPI zero-denominators, tax rate, number parsing, division cleaning |
| `tests/unit/same-origin.test.js` | 3 | cross-site guard |
| `tests/unit/analysis-failure.test.js` | 4 | AI 529/429/empty/truncated never wipes analysis |
| `tests/api.integration.test.js` | 22 | validation, junk/edge inputs, text handling, permissions, concurrency, meeting records, empty-period guard, CSRF, error leakage |

Unit tests load the **real** functions out of `index.html` and the function files (`tests/unit/_load.js`), so they can't drift from the shipped code.

**Result: 55 / 55 passing.**

---

## Final verdict

| | |
|---|---|
| **Bugs found** | 30 (2 critical, 6 high, 11 medium, 10 low, plus the not-yet-applied H4) |
| **Bugs fixed** | 13 — C1, C2, H1, H3, H5, H6, M1 (4 handlers), M2, M3, L6 (partial) |
| **Tests added** | 55 (none existed) |
| **Tests passed / failed** | 55 / 0 |
| **Security** | H4 no auth (critical if deployed) · H3 CSRF fixed · M10 raw DB errors · secrets not exposed; RLS verified |
| **Performance** | No problems at current scale; minor duplicate fetches (L7) |
| **Remaining risks** | H2 lost updates (two tabs / fast parallel saves) · M8 no schema in repo, non-transactional deletes · M4 other AI features fail unclearly · M5/M6 |

**Status: READY WITH WARNINGS** — safe for local, single-user, one-tab use.

**Recommended next steps**
1. Avoid editing the same client in two tabs until H2 is fixed (atomic JSON updates via a small migration).
2. Export the Supabase schema into a migration file (M8) so the database can be rebuilt.
3. Apply the C2-style API check to the other six AI features (M4).
4. Before any deployment: add authentication (H4).
5. Run `npm test` after changes, and `npm run test:api` with the server running.
