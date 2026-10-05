-- New borrowing drawn this period, as an independent fact (e.g. a "proceeds
-- from borrowings" line on a loan or cash flow statement) rather than always
-- back-solved from the balance movement and repayments. Entering it lets any
-- gap against the balance movement surface as capitalised interest (interest
-- added to the loan rather than paid in cash) instead of being silently
-- forced to zero by overwriting loan_repayments to make the balance movement
-- match exactly (see recon-new-borrowing wiring in index.html).
alter table financial_snapshots add column if not exists new_borrowing numeric;
