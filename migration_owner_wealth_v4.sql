-- A small fixed estate-planning checklist (Will / Enduring POA / buy-sell
-- agreement / key-person insurance) — distinct from Goals' exit_succession
-- category, which covers who takes over the business and when. This is
-- the more personal side: is the paperwork actually in place. Kept as its
-- own JSONB column on the same annual snapshot row rather than a new
-- table, same "one lightweight column per lightweight feature" pattern
-- already used for custom_buckets — no seeding, no AI generation, just a
-- fixed small set of items defined in index.html
-- (OWNER_ESTATE_CHECKLIST_ITEMS), each with a status (yes/no/unknown) and
-- an optional note.
alter table owner_wealth_snapshots
  add column if not exists estate_planning_checklist jsonb;
