-- Owner (Client/Accountant) and due date — the two fields the app's own
-- workspace-architecture-spec.md calls out as what actually makes an
-- "action" a plan rather than just a list: "needs a real task/action
-- tracker (owner, due date, status)". status already exists; this adds
-- the other two.
alter table action_items
  add column if not exists owner text,       -- 'Client' | 'Accountant' | null (not yet assigned)
  add column if not exists due_date date;    -- null = no date set
