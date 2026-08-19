-- Lets an accountant add their own named boxes beyond the fixed five
-- (Superannuation/Investments/Property/Other assets/Personal debt) — e.g. a
-- client with an unusual asset (a boat, a private loan they're owed, a
-- second mortgage) that doesn't fit an existing bucket. Each custom box
-- picks asset or liability so it knows whether to add to or subtract from
-- the net worth total, same as the built-in buckets already do implicitly.
-- One JSONB array holding every custom box (id/label/type/items) rather
-- than one column per box, since the number of boxes is open-ended.
alter table owner_wealth_snapshots
  add column if not exists custom_buckets jsonb;
