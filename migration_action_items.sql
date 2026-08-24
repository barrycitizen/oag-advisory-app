-- Actions domain — the piece that ties the rest of the app together. Up to
-- now, every card in Risk/Owner & Succession/Meeting could flag a gap and
-- point you at where to fix it, but nothing remembered that you'd agreed to
-- do it. This table is that memory: a client-level (not period-scoped) list
-- of things to do, sourced from wherever they were raised (a meeting, a
-- risk item, an Exit Readiness or Continuity gap, or typed in directly) and
-- tracked to done.
--
-- Client-level rather than period-scoped deliberately — an action agreed
-- to in one period's meeting doesn't stop mattering just because a new
-- period starts; it should stay visible until it's actually done.
create table if not exists action_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  text text not null,
  source text not null default 'manual', -- 'manual' | 'meeting' | 'exit_readiness' | 'continuity' | 'estate' | 'risk'
  status text not null default 'not_started', -- 'not_started' | 'in_progress' | 'done'
  priority text, -- 'High' | 'Medium' | 'Low' | null — inherited from the source where one exists
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);
create index if not exists action_items_client_idx on action_items (client_id);
