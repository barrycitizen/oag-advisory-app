-- Supersedes the previous (never-run) v2 migration, which tried to split the
-- director loan into flow fields (advanced/repaid) — replaced here with a
-- single BALANCE field, consistent with how debtors/creditors/total_debt
-- already work (delta computed automatically), and avoiding the
-- double-counting risk when a client's "total debt" figure already blends
-- in a director loan (as Chaillon's does).
--
-- fixed_assets is Property, Plant & Equipment net book value SPECIFICALLY —
-- deliberately not derived from total_assets - current_assets, since that
-- bucket can include unrelated non-current items (a loan receivable from a
-- director, long-term investments, intangibles) that would distort a capex
-- estimate built on top of it.
--
-- cash_recon_adjustments is a free-form list of one-off named items (e.g.
-- "Insurance payout $15,000") for the cash reconciliation panel, for
-- whatever a bookkeeper needs to explain that doesn't fit a fixed field.
alter table financial_snapshots add column if not exists fixed_assets numeric;
alter table financial_snapshots add column if not exists director_loan_balance numeric;
alter table financial_snapshots add column if not exists cash_recon_adjustments jsonb default '[]'::jsonb;

-- The v1 migration (already run) added director_loan_movement and
-- director_loan_advanced/director_loan_repaid were never created (v2 was
-- never run) — director_loan_movement stays in the table unused/harmless.
