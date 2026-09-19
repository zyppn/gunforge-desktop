-- ============================================================
-- 009: stop the auction destroying credits
--
-- Reported: the part moves from seller to buyer, but the credits do not move.
--
-- 006 did this:
--     revoke update on players from authenticated, anon;
--     grant  update (callsign, equipped, equipped_weapon) on players to authenticated;
--     create policy players_self on players for update
--       using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());
--
-- buy_listing is SECURITY DEFINER, so it should run as its owner and bypass both.
-- If it does not — because the function is owned by a role that is neither the
-- table owner nor BYPASSRLS, or because players has FORCE ROW LEVEL SECURITY —
-- then inside the function:
--     update players set credits = credits - price where id = buyer   -- own row, passes RLS
--     update players set credits = credits + price where id = seller  -- OTHER row, 0 rows
-- The buyer is charged, the seller is never paid, and the difference is destroyed.
-- Every statement returned without error, so nothing surfaced.
--
-- Two fixes, because either one alone leaves a way to be wrong:
--   1. Assert the row counts. If a credit move touches 0 rows the whole
--      transaction aborts, so the part stays put too. A failed purchase is
--      recoverable; silently burning credits is not.
--   2. Set the owner explicitly, which is the actual repair if ownership was
--      the problem.
--
-- Also adds the balance check the function never had: nothing stopped a buyer
-- with 40 credits taking a 999,999 listing straight into a negative balance.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

drop function if exists buy_listing(uuid);
create function buy_listing(p_listing uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v        listings%rowtype;
  v_buyer  uuid;
  v_part   parts%rowtype;
  v_bal    int;
  n        int;
begin
  select id into v_buyer from players where auth_uid = auth.uid();
  if v_buyer is null then raise exception 'not signed in'; end if;

  select * into v from listings where id = p_listing and status = 'active' for update;
  if v.id is null        then raise exception 'listing gone'; end if;
  if v.seller_id = v_buyer then raise exception 'own listing'; end if;
  if parts_held(v_buyer) >= part_cap() then raise exception 'parts locker full'; end if;

  -- lock the buyer's row and check they can actually afford it
  select credits into v_bal from players where id = v_buyer for update;
  if v_bal is null      then raise exception 'no buyer row'; end if;
  if v_bal < v.price    then raise exception 'not enough credits'; end if;

  update players set credits = credits - v.price where id = v_buyer;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'buyer debit touched % rows, not 1 - aborting', n; end if;

  update players set credits = credits + v.price where id = v.seller_id;
  get diagnostics n = row_count;
  -- THE bug: this silently did nothing, and the purchase completed anyway.
  if n <> 1 then
    raise exception 'seller credit touched % rows, not 1 - aborting (buy_listing cannot write another player''s row; check the function owner)', n;
  end if;

  update parts set owner_id = v_buyer, equipped = false where uid = v.part_uid;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'part transfer touched % rows, not 1 - aborting', n; end if;

  update listings set status = 'sold', buyer_id = v_buyer, resolved_at = now() where id = v.id;

  select * into v_part from parts where uid = v.part_uid;
  return jsonb_build_object('price', v.price, 'part', to_jsonb(v_part),
                            'credits', v_bal - v.price);
end $$;

-- The repair, if the function was owned by something without the rights.
alter function buy_listing(uuid) owner to postgres;
grant execute on function buy_listing(uuid) to authenticated;

-- scrap_part and list_part write players.credits from the same kind of context.
-- Point them at the same owner so one broken assumption can't survive in a
-- corner nobody has tested yet.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'scrap_part') then
    execute 'alter function scrap_part(uuid) owner to postgres';
  end if;
  if exists (select 1 from pg_proc where proname = 'cancel_listing') then
    execute 'alter function cancel_listing(uuid) owner to postgres';
  end if;
exception when others then
  raise notice 'owner fixup skipped: %', sqlerrm;
end $$;

notify pgrst, 'reload schema';
