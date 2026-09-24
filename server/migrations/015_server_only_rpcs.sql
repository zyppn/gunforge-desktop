-- ============================================================
-- 015: functions only the arena server may call.
--
-- add_progress and buy_store_part are SECURITY DEFINER and take the player, the
-- amounts and (for the store) the part itself as PARAMETERS. The arena server
-- decides those values and calls them with the service key; the server's checks are
-- the only thing standing between a request and the economy.
--
-- But Postgres grants EXECUTE on every new function to PUBLIC, and Supabase's default
-- privileges grant it to anon and authenticated as well - so unless someone revoked it
-- by hand, every copy of the game carried the publishable key needed to call
--     POST /rest/v1/rpc/buy_store_part  {p_player: <anyone>, p_price: 0, p_part: {...}}
-- directly, and to mint any part, for anyone, for free. add_progress likewise with
-- credits and XP. Nothing in the migrations ever revoked either.
--
-- Revoke by oid in a loop rather than by signature: add_progress was written in the
-- SQL editor and its argument list is not in this repo, and an overload added later
-- must not slip through either. service_role keeps an explicit grant, because it is
-- how the server calls these and it must not depend on PUBLIC.
-- ============================================================
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('add_progress', 'buy_store_part')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Verify (run after): both rows must read false, false.
-- select p.proname,
--        has_function_privilege('anon', p.oid, 'execute')          as anon_can_call,
--        has_function_privilege('authenticated', p.oid, 'execute') as players_can_call
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname in ('add_progress', 'buy_store_part');
