-- Adds the AI-synthesized recommendation text (see risk-item-synthesis.js)
-- to sit alongside detail on a risk_items row.
alter table risk_items add column if not exists recommendation text;
