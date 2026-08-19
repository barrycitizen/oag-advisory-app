-- Each net worth bucket becomes an itemized list (e.g. multiple super
-- funds, multiple properties) rather than one lump-sum number — same
-- pattern as financial_snapshots.cash_recon_adjustments, one JSONB array
-- per bucket instead of one shared array with a section tag, since these
-- buckets are genuinely separate concepts, not sub-categories of one thing.
-- The existing plain numeric columns (super_balance, investments, etc.)
-- stay as-is and keep working exactly as before — manual-entry.js now
-- computes them server-side as the sum of each bucket's items, the same
-- "derived, not trusted from the client" pattern already used for
-- valuation_amount in business_valuations.
alter table owner_wealth_snapshots
  add column if not exists super_items         jsonb,
  add column if not exists investments_items   jsonb,
  add column if not exists property_items      jsonb,
  add column if not exists other_assets_items  jsonb,
  add column if not exists debt_items          jsonb;
