-- Business valuation card (Growth domain) — a simple, clearly-labelled
-- "roughly what is this business worth" estimate: EBITDA x a multiple, both
-- shown plainly. The multiple is AI-suggested per industry (cached so
-- identical industries across clients don't re-hit the AI every time, same
-- pattern as industry_risk_checklist_cache in migration_risk_items.sql) but
-- always editable — the accountant confirms or overrides it before saving.
-- One row per client per period; deduped to one-per-calendar-year client-side
-- when showing a "last year vs this year" comparison, since quarter-to-quarter
-- isn't a meaningful cadence for a valuation figure.
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
create index if not exists business_valuations_client_idx on business_valuations (client_id);

create table if not exists industry_valuation_multiple_cache (
  industry_key       text primary key,
  suggested_multiple numeric not null,
  rationale          text not null,
  generated_at        timestamptz default now()
);
