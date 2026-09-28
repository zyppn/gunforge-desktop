-- ============================================================
-- 021: auction sales move credits again - and the seller sees it instantly.
--
-- Two parts:
--   A. the player guards stop cancelling the game's own credit moves (the bug)
--   B. Realtime is switched on for players and listings, so the seller's game
--      hears about a sale the moment it happens instead of on their next reload
--
-- ---- A --------------------------------------------------------------------
-- The bug, as players saw it: an auction sale completed - the part moved to the
-- buyer - but NO credits moved. The buyer was not charged and the seller was not
-- paid. Scrapping a part paid nothing either.
--
-- Cause: guard_player_selfupdate (016) resets credits/level/xp whenever the
-- REQUEST came from a signed-in player:
--
--     if request.jwt.claims ->> 'role' = 'authenticated' then new.credits := old.credits; ...
--
-- But the request claims are set for the WHOLE request, including inside the
-- game's own SECURITY DEFINER functions. buy_listing and scrap_part are called by
-- a signed-in player, so every credit update inside them was silently undone -
-- "1 row updated", no error, nothing changed. 011's row-count checks could not see
-- it, because the row WAS updated, just back to what it already was.
--
-- The fix asks the right question: not "who sent the request" but "who is writing
-- this row". A player writing their own row directly through the API runs as the
-- role `authenticated` (or `anon`). The game's functions run as their owner
-- (postgres) and are trusted - they check prices, balances and ownership themselves.
-- For current_user to mean that, the guard itself must be SECURITY INVOKER: a
-- SECURITY DEFINER trigger would see its own owner as current_user every time.
--
-- Nothing a player can do directly changes: column grants (006) still refuse the
-- write, and this guard still resets it if a grant is ever widened by mistake.
--
-- Run in the Supabase SQL editor. Idempotent. Takes effect immediately.
-- ============================================================

create or replace function public.guard_player_selfupdate()
returns trigger
language plpgsql
security invoker
set search_path = public
as $function$
begin
  if current_user in ('authenticated', 'anon') then
    -- a player writing their own row directly cannot move these no matter what they send
    new.credits  := old.credits;
    new.level    := old.level;
    new.xp       := old.xp;
    new.steam_id := old.steam_id;
    new.id       := old.id;
    new.auth_uid := old.auth_uid;
  end if;
  return new;
end $function$;

create or replace function public.guard_player_selfinsert()
returns trigger
language plpgsql
security invoker
set search_path = public
as $function$
begin
  if current_user in ('authenticated', 'anon') then
    new.credits  := 500;   -- fixed starting credits
    new.level    := 1;
    new.xp       := 0;
    new.steam_id := null;
  end if;
  return new;
end $function$;

-- The functions that move credits must be owned by a trusted role, or current_user
-- inside them would not be one. 011 set this; asserted again because it is now load-bearing.
do $$
declare f text;
begin
  foreach f in array array['buy_listing(uuid)', 'scrap_part(uuid)', 'cancel_listing(uuid)', 'list_part(uuid,integer)'] loop
    if to_regprocedure('public.' || f) is not null then
      execute format('alter function public.%s owner to postgres', f);
    end if;
  end loop;
end $$;

-- ---- B --------------------------------------------------------------------
-- The game subscribes to UPDATEs on its own players row (balance) and on listings
-- where it is the seller ("SOLD"). Both tables are already readable by everyone
-- (players_read / listings_read), so this exposes nothing new - Realtime applies the
-- same RLS as a normal read. Until this runs, the game falls back to checking every
-- 10 seconds.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players') then
    alter publication supabase_realtime add table public.players;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'listings') then
    alter publication supabase_realtime add table public.listings;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Check: both guards print security_definer = false, and both tables are listed for Realtime
select proname, prosecdef as security_definer
  from pg_proc where proname in ('guard_player_selfupdate', 'guard_player_selfinsert');
select tablename as realtime_on from pg_publication_tables
 where pubname = 'supabase_realtime' and tablename in ('players', 'listings');
