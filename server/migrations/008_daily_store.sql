-- ============================================================
-- 008: Daily Store
--
-- The shop itself is NOT stored: it is a pure function of (player id, store
-- day) computed identically by the client and the server, so there is nothing
-- to persist and nothing to reroll. What must be persisted is the fact of a
-- purchase, so a double-click, a retry or a replayed request cannot buy the
-- same slot twice.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

create table if not exists store_purchases (
  player_id  uuid not null references players(id) on delete cascade,
  day_key    text not null,            -- Chicago date the window opened, 'YYYY-MM-DD'
  idx        smallint not null,        -- which of the eight slots
  part_uid   uuid,
  price      int  not null,
  bought_at  timestamptz not null default now(),
  primary key (player_id, day_key, idx)
);

alter table store_purchases enable row level security;

-- a player may read their own purchase history (the UI greys out bought slots)
drop policy if exists store_purchases_own on store_purchases;
create policy store_purchases_own on store_purchases
  for select using (player_id = (select id from players where auth_uid = auth.uid()));

-- Writes go only through the RPC below, never directly.
revoke insert, update, delete on store_purchases from authenticated, anon;

-- buy_store_part: the whole transaction in one place.
--   * the SERVER supplies the part (it re-derives the shop from the seed), so a
--     client cannot name its own rarity, mods or price
--   * the primary key claims the slot, so a replay is a no-op rather than a
--     second part
--   * credits are checked and deducted in the same statement that inserts
drop function if exists buy_store_part(uuid, text, smallint, int, jsonb);
create function buy_store_part(
  p_player uuid, p_day text, p_idx smallint, p_price int, p_part jsonb)
returns jsonb language plpgsql security definer as $$
declare v_credits int; v_uid uuid; v_row parts%rowtype;
begin
  -- claim the slot first: on conflict we have already sold this one
  begin
    insert into store_purchases(player_id, day_key, idx, price) values (p_player, p_day, p_idx, p_price);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'already-bought');
  end;

  if parts_held(p_player) >= part_cap() then
    raise exception 'parts locker full';
  end if;

  select credits into v_credits from players where id = p_player for update;
  if v_credits is null then raise exception 'no player'; end if;
  if v_credits < p_price then raise exception 'not enough credits'; end if;

  update players set credits = credits - p_price where id = p_player;

  insert into parts(owner_id, weapon_id, slot, rarity, name, mods, set_id, ability, source, bound)
  values (p_player,
          p_part->>'weapon', p_part->>'slot', p_part->>'rarity', p_part->>'name',
          coalesce(p_part->'mods', '{}'::jsonb), null,
          nullif(p_part->>'ability', ''), 'store', false)
  returning uid into v_uid;

  update store_purchases set part_uid = v_uid
   where player_id = p_player and day_key = p_day and idx = p_idx;

  select * into v_row from parts where uid = v_uid;
  return jsonb_build_object('ok', true, 'part', to_jsonb(v_row),
                            'credits', v_credits - p_price);
end $$;

notify pgrst, 'reload schema';
