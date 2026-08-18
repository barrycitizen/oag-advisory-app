-- Links a business risk_items row to the exact risk_questions row it
-- answers (anchor or a specific follow-up). Needed now that each question
-- in a category gets submitted and can be edited independently — without
-- this, there's no way to replace ONE follow-up's row on re-save without
-- either duplicating it or accidentally wiping out its sibling follow-ups'
-- rows, which share the same category.
alter table risk_items add column if not exists question_id integer references risk_questions(id);
