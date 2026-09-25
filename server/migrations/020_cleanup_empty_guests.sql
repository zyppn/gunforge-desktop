-- ============================================================
-- 020: delete guest accounts that were never played.
--
-- Every fresh install creates an anonymous guest, and most people who open a game
-- once never come back. Those rows only accumulate. This removes a guest ONLY when
-- there is nothing of anyone's in it:
--
--   - still anonymous (never connected Discord or made a login)
--   - not signed in for p_days (30 from the schedule; refuses anything under 7)
--   - level 1, 0 XP, no more than the 500 starting credits
--   - every stat zero: no matches, wins, kills or deaths
--   - no parts, no auction listing as seller OR buyer, no store purchase, and no
--     claimed match - even one whose reward failed to land
--
-- A guest with a single XP point is someone's progress they just have not secured
-- yet, and is never touched. Anonymous users with no player row at all (the app was
-- opened but never reached the menu) go too.
--
-- p_dry_run defaults to TRUE, so calling it by hand only counts:
--   select cleanup_empty_guests(30);          -- how many would go
--   select cleanup_empty_guests(30, false);   -- actually delete
-- Every table that references players cascades or sets null (see schema.test.js), so
-- the delete cannot fail halfway; player_sessions rows go with their player.
-- ============================================================
create or replace function public.cleanup_empty_guests(p_days int default 30, p_dry_run boolean default true)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare n int;
begin
  if p_days is null or p_days < 7 then
    raise exception 'cleanup_empty_guests: refusing p_days < 7 (got %)', p_days;
  end if;

  drop table if exists _empty_guests;
  create temp table _empty_guests on commit drop as
  select u.id as uid, p.id as pid
    from auth.users u
    left join public.players p on p.auth_uid = u.id
   where u.is_anonymous is true
     and coalesce(u.last_sign_in_at, u.created_at) < now() - make_interval(days => p_days)
     and (p.id is null or (
             p.level = 1 and p.xp = 0 and p.credits <= 500
         and coalesce((p.stats->>'matches')::int, 0) = 0
         and coalesce((p.stats->>'wins')::int,    0) = 0
         and coalesce((p.stats->>'kills')::int,   0) = 0
         and coalesce((p.stats->>'deaths')::int,  0) = 0
         and not exists (select 1 from public.parts x             where x.owner_id  = p.id)
         and not exists (select 1 from public.listings x          where x.seller_id = p.id or x.buyer_id = p.id)
         and not exists (select 1 from public.store_purchases x   where x.player_id = p.id)
         and not exists (select 1 from public.processed_matches x where x.player_id = p.id)
     ));

  select count(*) into n from _empty_guests;
  if not p_dry_run then
    delete from public.players where id in (select pid from _empty_guests where pid is not null);
    delete from auth.users     where id in (select uid from _empty_guests);
  end if;
  return n;
end $$;

-- an admin tool: never callable from the game
revoke execute on function public.cleanup_empty_guests(int, boolean) from public, anon, authenticated;
grant  execute on function public.cleanup_empty_guests(int, boolean) to service_role;

-- nightly, 09:23 UTC (early morning in the US), via Supabase's pg_cron (Free plan OK).
-- If this errors with "extension pg_cron is not available", enable it under
-- Database -> Extensions -> pg_cron and run the rest of the file again.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'gunforge-cleanup-empty-guests';
select cron.schedule('gunforge-cleanup-empty-guests', '23 9 * * *',
                     $cron$ select public.cleanup_empty_guests(30, false) $cron$);
