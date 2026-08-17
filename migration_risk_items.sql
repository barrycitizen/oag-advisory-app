-- Risk Review — shared risk_items table for all three planned sources
-- (financial/business/industry) plus the industry checklist cache. This
-- migration only wires up Source C (industry). Only the columns Source C
-- needs are populated for now; financial/business sources get their own
-- integration work later, into the same table.
--
-- Adapted from a pg-style CREATE TABLE draft to match this app's actual
-- schema: client_id is a uuid (see client_context.client_id, generated via
-- crypto.randomUUID() in manual-entry.js), and periods are identified by
-- period_end (date), not an integer period_id — same shape as
-- financial_snapshots/flags/pillar_scores/etc.

create table if not exists risk_items (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null,
  period_end          date not null,
  source              text not null check (source in ('financial','business','industry')),
  category            text,
  risk_name           text not null,
  detail              text,
  status              text not null default 'Unknown'
                        check (status in ('Detected','Identified','Watch','Managed','Not applicable','Unknown')),
  severity            text default 'Medium' check (severity in ('High','Medium','Low')),
  last_reviewed_date  date,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index if not exists risk_items_client_period_idx on risk_items (client_id, period_end);

-- Cache so the same industry text (e.g. "Automotive Repair") isn't
-- re-generated via AI for every client that shares it.
create table if not exists industry_risk_checklist_cache (
  industry_key   text primary key,
  checklist_json jsonb not null,
  generated_at   timestamptz default now()
);
