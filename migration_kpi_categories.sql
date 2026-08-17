-- Adds KPI grouping for the Analyse tab's Key Metrics display.
alter table kpi_library add column if not exists category text;

update kpi_library set category = 'profitability' where key in ('revenue_growth', 'gp_margin', 'np_margin', 'wages_pct', 'roe');
update kpi_library set category = 'working_capital' where key in ('debtor_days', 'creditor_days', 'inventory_days');
update kpi_library set category = 'balance_sheet' where key in ('debt_to_equity', 'current_ratio');
update kpi_library set category = 'cash' where key in ('op_cash_conversion');
update kpi_library set category = 'tax' where key in ('effective_tax_rate');
