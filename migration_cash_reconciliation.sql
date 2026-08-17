-- Adds the fields needed for the "where did the cash go?" reconciliation
-- panel on the Operating Cash Conversion KPI card: owner drawings, funds
-- introduced by the owner, and net director/shareholder loan movement.
-- All are per-period FLOW figures (like interest_expense), not balances.
alter table financial_snapshots add column if not exists owner_drawings numeric;
alter table financial_snapshots add column if not exists funds_introduced numeric;
alter table financial_snapshots add column if not exists director_loan_movement numeric;
