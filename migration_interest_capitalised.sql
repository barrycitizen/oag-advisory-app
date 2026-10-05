-- How much of this period's interest expense (P&L) got added to the loan
-- balance rather than paid in cash — a redraw/interest-only/line-of-credit
-- facility, e.g. Kept as its own independent fact (not derived from New
-- borrowing minus repayments) because reading interest_expense alone can't
-- tell you which portion, if any, was capitalised — an adviser who knows
-- this from a loan statement needs to be able to say so directly, and a
-- mismatch against New borrowing/repayments should surface as a real
-- discrepancy to investigate, not be silently absorbed into a solved-for
-- number that always makes the arithmetic agree.
alter table financial_snapshots add column if not exists interest_capitalised numeric;
