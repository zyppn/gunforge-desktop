-- ============================================================
-- 016: the functions and triggers that existed only in the live database.
--
-- Dumped from production (pg_get_functiondef / pg_get_triggerdef) on 2026-09-25.
-- Written in the Supabase SQL editor at some point and never saved, so a restore,
-- a rebuild or a move to a new project would have come up without them:
--
--   add_progress            every credit, XP point and stat from a match goes
--                           through this - without it, rewards 404 silently
--   guard_player_selfinsert new player rows start at 500 credits / level 1 no
--                           matter what the client sends
--   guard_player_selfupdate a signed-in player cannot move their own credits,
--                           level, xp, steam_id, id or auth_uid
--   rls_auto_enable         every new table in public gets RLS switched on
--
-- Left out on purpose: issue_graphql_placeholder, issue_pg_cron_access,
-- issue_pg_graphql_access, issue_pg_net_access, pgrst_ddl_watch, pgrst_drop_watch.
-- Those are Supabase's own event triggers, present in every project; recreating
-- them here would fail on a fresh project and fight Supabase on this one.
--
-- Safe to re-run: functions are CREATE OR REPLACE, triggers are dropped first.
-- ============================================================

CREATE OR REPLACE FUNCTION public.add_progress(p_player uuid, p_credits integer DEFAULT 0, p_xp integer DEFAULT 0, p_stats jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  cur_stats jsonb;
  new_level int;
  new_xp int;
begin
  -- add credits (clamped >= 0) and xp
  update players
     set credits = greatest(0, credits + coalesce(p_credits,0)),
         xp = greatest(0, xp + coalesce(p_xp,0))
   where id = p_player
   returning xp, level, stats into new_xp, new_level, cur_stats;

  if not found then return; end if;

  -- level-ups: same curve as the client (100 + (level-1)*80)
  while new_xp >= 100 + (new_level - 1) * 80 loop
    new_xp := new_xp - (100 + (new_level - 1) * 80);
    new_level := new_level + 1;
  end loop;
  update players set xp = new_xp, level = new_level where id = p_player;

  -- merge stat deltas (kills/deaths/matches/wins are additive counters)
  if p_stats is not null and p_stats <> '{}'::jsonb then
    update players set stats = jsonb_build_object(
      'kills',   coalesce((cur_stats->>'kills')::int,0)   + coalesce((p_stats->>'kills')::int,0),
      'deaths',  coalesce((cur_stats->>'deaths')::int,0)  + coalesce((p_stats->>'deaths')::int,0),
      'matches', coalesce((cur_stats->>'matches')::int,0) + coalesce((p_stats->>'matches')::int,0),
      'wins',    coalesce((cur_stats->>'wins')::int,0)    + coalesce((p_stats->>'wins')::int,0)
    ) where id = p_player;
  end if;
end $function$
;

/* Closed HERE, not only in 015. Migrations apply in file order, so on a fresh project
   015 runs while add_progress does not exist yet - its loop finds nothing to revoke -
   and then this file creates it with Postgres's default EXECUTE-to-PUBLIC. A rebuild
   from the repo would have reopened the exact hole 015 closed. */
revoke execute on function public.add_progress(uuid, integer, integer, jsonb) from public, anon, authenticated;
grant  execute on function public.add_progress(uuid, integer, integer, jsonb) to service_role;

CREATE OR REPLACE FUNCTION public.guard_player_selfinsert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare role_txt text;
begin
  role_txt := coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '');
  if role_txt = 'authenticated' then
    new.credits := 500;   -- fixed starting credits
    new.level   := 1;
    new.xp      := 0;
    new.steam_id := null;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.guard_player_selfupdate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare role_txt text;
begin
  role_txt := coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '');
  if role_txt = 'authenticated' then
    -- a normal signed-in user cannot move these no matter what they send
    new.credits  := old.credits;
    new.level    := old.level;
    new.xp       := old.xp;
    new.steam_id := old.steam_id;
    new.id       := old.id;
    new.auth_uid := old.auth_uid;
  end if;
  return new;
end $function$
;

drop trigger if exists trg_guard_player_selfinsert on public.players;
CREATE TRIGGER trg_guard_player_selfinsert BEFORE INSERT ON public.players FOR EACH ROW EXECUTE FUNCTION guard_player_selfinsert();

drop trigger if exists trg_guard_player_selfupdate on public.players;
CREATE TRIGGER trg_guard_player_selfupdate BEFORE UPDATE ON public.players FOR EACH ROW EXECUTE FUNCTION guard_player_selfupdate();

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function rls_auto_enable();
