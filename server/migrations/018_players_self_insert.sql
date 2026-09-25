-- ============================================================
-- 018: the policy that lets a new account create its own player row.
--
-- The last piece that existed only in the live database (dumped from pg_policies
-- on 2026-09-25; every other policy there already matched the repo). Without it a
-- project rebuilt from these files lets players SELECT and UPDATE their row but never
-- INSERT it, so loadCloudProfile's first-launch insert fails and nobody can start.
--
-- It only checks ownership. What goes IN the row is policed by
-- guard_player_selfinsert (016): credits, level, xp and steam_id are forced to
-- starting values whatever the client sends, and auth_uid is unique, so this allows
-- exactly one row per account.
-- ============================================================
drop policy if exists players_self_insert on public.players;
create policy players_self_insert on public.players
  for insert to public
  with check (auth_uid = auth.uid());
notify pgrst, 'reload schema';
