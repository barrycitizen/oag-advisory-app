-- Every risk_questions row is now a flat, independent question — no more
-- anchor/follow-up hierarchy (is_anchor/depends_on_question_id are no
-- longer read by the app; left in place rather than dropped, harmless
-- unused columns beat a destructive migration).
--
-- `active` is how a question gets "deleted" — a real DELETE would either
-- fail (risk_items.question_id references it) or silently orphan real
-- client answers. Soft-delete via active=false preserves history, same
-- pattern kpi_library already uses.
alter table risk_questions add column if not exists active boolean not null default true;
