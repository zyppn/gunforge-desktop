-- ============================================================
-- 003: processed_matches — idempotency for replayed rewards
--
-- The client now queues a match result locally when /reward/offline can't be
-- reached, and replays it later. A replay must never grant twice, which can
-- happen if the original POST succeeded but its response was lost in transit.
-- The client stamps each match with a unique id; the server claims that id
-- before granting, and a claim that loses the race grants nothing.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

create table if not exists processed_matches (
  mid         text primary key,
  player_id   uuid not null references players(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists processed_matches_player on processed_matches(player_id);

-- Only the game server (service role) ever touches this table. RLS on with no
-- policies means the anon/authenticated client cannot read or write it at all.
alter table processed_matches enable row level security;

notify pgrst, 'reload schema';
