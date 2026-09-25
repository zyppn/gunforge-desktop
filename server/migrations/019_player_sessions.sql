-- ============================================================
-- 019: one active session per account (server/sessions.js).
--
-- Each launch of the game claims its account with a random session id; the newest
-- claim is the only one the arena server honours for rewards, store purchases and
-- PvP seats, and every other copy of the game signs itself out. This table is where
-- the claim survives a server restart.
--
-- Server-only. RLS is on with no policies and the grants are revoked, so no client
-- can read another device's session id (which would let it pass as that device) or
-- write its own.
-- ============================================================
create table if not exists player_sessions (
  player_id  uuid primary key references players(id) on delete cascade,
  session    text not null,
  claimed_at timestamptz not null default now()
);
alter table player_sessions enable row level security;
revoke all on player_sessions from public, anon, authenticated;
grant select, insert, update, delete on player_sessions to service_role;
notify pgrst, 'reload schema';
