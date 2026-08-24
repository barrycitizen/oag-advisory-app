-- Exit readiness checklist — the genuinely NEW questions the original 12-
-- factor proposal needed (recurring revenue, management depth, IP/brand
-- protection, contracts, premises stability). Owner dependence, key
-- employee dependence, customer concentration, and processes-documented
-- are deliberately NOT re-asked here — they're already answered in the
-- Business Risk Questionnaire (People/Operations categories) and reused
-- directly by the scoring code. Profitability is reused from the existing
-- profitability pillar score. Same "one lightweight JSONB column per
-- lightweight feature" pattern as custom_buckets/estate_planning_checklist.
alter table owner_wealth_snapshots
  add column if not exists exit_readiness_checklist jsonb;
