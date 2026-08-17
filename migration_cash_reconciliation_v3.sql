-- Fixes an oversight: loan_repayments and equipment_purchases were added to
-- the app's field lists (Manual Entry, PDF extraction) across earlier turns
-- but never actually included in a migration — v1 only added owner_drawings/
-- funds_introduced/director_loan_movement, v2 only added fixed_assets/
-- director_loan_balance/cash_recon_adjustments. This closes that gap.
alter table financial_snapshots add column if not exists loan_repayments numeric;
alter table financial_snapshots add column if not exists equipment_purchases numeric;
