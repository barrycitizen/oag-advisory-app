-- Carries the reasoning behind an action, not just the task itself — the
-- Decision text from a meeting, or the "why this matters" copy already
-- written for Exit Readiness/Continuity/estate gaps. Optional: manual
-- adds don't require one, since the point is to carry context that
-- already exists elsewhere, not demand the accountant write more.
alter table action_items add column if not exists why text;
