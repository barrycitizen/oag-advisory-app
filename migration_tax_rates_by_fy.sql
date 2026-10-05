-- Individual/company tax brackets, Medicare levy and super cap used by Tax
-- outlook and Current tax position (see index.html's TAX_RATES_BY_FY) used
-- to live only as a hardcoded object in index.html, one entry per financial
-- year — correct in spirit (each year keeps its own numbers, adding a new
-- year never overwrites an old one) but it meant every annual update needed
-- a code change and a deploy. This table is the same one-entry-per-FY shape,
-- persisted, so the adviser can save a new year's numbers straight from the
-- Tax rates panel they already use, with no code change involved. Not
-- client-scoped — these are the same national ATO figures for every client
-- in a given year, so one shared table (not a per-client copy) is
-- deliberate: it's exactly what avoids the numbers drifting out of sync
-- between clients the way a per-client copy would risk.
--
-- `rates` mirrors TAX_RATES_BY_FY's per-year shape: taxFreeThreshold,
-- bracket2Upper/Rate, bracket3Upper/Rate, bracket4Upper/Rate, bracket5Rate,
-- medicareRate, medicareThreshold, companyRate, superCap.
--
-- index.html still ships its own hardcoded FY2026-27 entry as a seed/
-- fallback for a brand-new install with no rows here yet, or if this table
-- can't be reached — this table is additive on top of that, not a
-- replacement for it.
create table if not exists tax_rates_by_fy (
  fy text primary key,
  rates jsonb not null,
  updated_at timestamptz not null default now()
);
