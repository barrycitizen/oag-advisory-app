-- Lets a client be hidden from the sidebar/list without destroying any of
-- their data. The everyday "remove a client" action is archive (reversible);
-- a separate hard-delete action exists for true cleanup but is not driven by
-- this column.
alter table client_context add column if not exists is_archived boolean not null default false;
