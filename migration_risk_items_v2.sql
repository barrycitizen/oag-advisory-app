-- Adds what Source A (financial risk sync) needs on top of the base
-- risk_items table from migration_risk_items.sql: impact_estimate is
-- TEXT because runFlags() already formats it as a string (e.g.
-- "Estimated additional cash tied up: $12,345"), not a raw number.
-- is_new/is_changed drive the dashboard's new/changed counts.
alter table risk_items add column if not exists impact_estimate text;
alter table risk_items add column if not exists is_new boolean not null default true;
alter table risk_items add column if not exists is_changed boolean not null default false;
