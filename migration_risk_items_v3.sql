-- Source B (business risk questionnaire) additions.
create table if not exists risk_questions (
  id                      serial primary key,
  category                text not null,
  question_text           text not null,
  is_anchor               boolean not null default false,
  risk_if_yes             boolean not null default true, -- does answering "yes" indicate a risk?
  depends_on_question_id  integer references risk_questions(id), -- null for anchors
  sort_order              integer default 0
);

-- Free-text answer to a follow-up question — kept separate from `detail`
-- (which holds the question text itself), see business-risk-questionnaire.js.
alter table risk_items add column if not exists notes text;
