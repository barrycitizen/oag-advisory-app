-- Owner Wealth domain — personal net worth tracker. One row per client per
-- year (this pillar is annual-cadence-only, see CADENCE_PILLARS in
-- analyze.js). Business equity is deliberately NOT a column here — the
-- Owner Wealth card cross-references business_valuations live instead, so
-- the two numbers can never drift out of sync with each other.
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
create index if not exists owner_wealth_snapshots_client_idx on owner_wealth_snapshots (client_id);
