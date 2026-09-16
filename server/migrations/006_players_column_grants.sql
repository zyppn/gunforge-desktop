-- ============================================================
-- 006: lock down client writes to players
--
-- players_self allowed UPDATE on the whole row with no WITH CHECK, and the
-- client already PATCHes this table for callsign / equipped / equipped_weapon.
-- So a modified client could have sent {"credits": 999999} to the same endpoint,
-- or reassigned auth_uid to point at another player's row.
--
-- RLS can't restrict columns; grants can. The game server is unaffected — the
-- service role bypasses both RLS and column grants.
--
-- ALREADY APPLIED to the live database; kept here so a rebuild reproduces it.
-- Idempotent.
-- ============================================================

revoke update on players from authenticated, anon;
grant update (callsign, equipped, equipped_weapon) on players to authenticated;

drop policy if exists players_self on players;
create policy players_self on players for update
  using (auth_uid = auth.uid())
  with check (auth_uid = auth.uid());

notify pgrst, 'reload schema';
