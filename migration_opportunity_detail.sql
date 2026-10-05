-- Growth opportunities — extends the existing title/impact/difficulty/
-- timeframe recommendation row with three more short AI-generated fields,
-- so a live opportunity says what it would actually take to act on, what
-- the risk of acting is, and what decision the client is actually facing —
-- not just what the upside is (see meeting-intelligence-build-spec.md §5).
-- Nullable, and only ever populated for type='growth' recommendations;
-- existing rows (and the other recommendation types: get_better,
-- tax_planning) simply have these as null, rendered gracefully as absent.
alter table recommendations add column if not exists takes text;
alter table recommendations add column if not exists risk text;
alter table recommendations add column if not exists decision text;
