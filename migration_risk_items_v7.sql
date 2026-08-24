-- Widens risk_items.source's CHECK constraint to allow 'owner_wealth' —
-- Source D, alongside financial/business/industry. Feeds Risk Review from
-- Owner Wealth's Succession & estate planning card (estate checklist gaps,
-- succession readiness), same "enter once, feeds everywhere" principle
-- Sources A-C already use, via lib/owner-wealth-risk-sync.js.
--
-- Dynamic constraint lookup rather than a hardcoded DROP CONSTRAINT name —
-- the base migration (migration_risk_items.sql) defined this as an inline
-- column-level CHECK with no explicit name, so Postgres auto-named it;
-- this finds whatever that name actually is instead of guessing.
do $$
declare
  con_name text;
begin
  select con.conname into con_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'risk_items' and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%source%';
  if con_name is not null then
    execute format('alter table risk_items drop constraint %I', con_name);
  end if;
end $$;

alter table risk_items add constraint risk_items_source_check
  check (source in ('financial', 'business', 'industry', 'owner_wealth'));
