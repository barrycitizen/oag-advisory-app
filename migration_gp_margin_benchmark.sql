-- AI-suggested, cached "typical GP margin range for this industry" — fixes
-- the Profitability pillar score's fallback (analyze-background.js's
-- scoreProfitabilityPillar) for the common case where a client has no GP
-- margin target of their own set on Goals. Before this, that fallback was a
-- single flat 15-45% range for every client regardless of industry — fine
-- for a trades business, meaningless for a professional-services one that
-- might normally run 60-70%. Same cache-per-industry pattern as
-- industry_valuation_multiple_cache (migration_business_valuations.sql):
-- identical industry strings across different clients share one cached
-- lookup instead of re-hitting the AI every analysis run.
create table if not exists industry_gp_margin_benchmark_cache (
  industry_key  text primary key,
  typical_low   numeric not null,
  typical_high  numeric not null,
  rationale     text not null,
  generated_at  timestamptz default now()
);
