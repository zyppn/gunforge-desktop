-- ============================================================
-- 022: parts bought in the daily store are soulbound
--
-- Every account gets its own shop (the seed is the player id), so a new account is a
-- new shop. While store parts could be listed, a player with credits could make guest
-- or alt accounts, fund them through the auction, buy whatever legendary their shops
-- rolled and "sell" it to their main - unlimited shop rerolls. The price never mattered:
-- between two accounts you own, credits only go round in a circle.
--
-- A store part is now bound to the account that bought it, like an offline drop:
-- equip it, scrap it, never list it. list_part already refuses bound parts (001/004),
-- so this is the only change the auction needs.
--
--   1. buy_store_part inserts bound = true (CREATE OR REPLACE keeps its owner and grants)
--   2. a trigger binds any store part however it is written - a second wall
--   3. store parts bought before this migration are bound too, and any of them sitting
--      on the auction are taken down (cancelled, the part stays with its owner)
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

create or replace function buy_store_part(
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
          nullif(p_part->>'ability', ''), 'store', true)          -- soulbound: yours only
  returning uid into v_uid;

  update store_purchases set part_uid = v_uid
   where player_id = p_player and day_key = p_day and idx = p_idx;

  select * into v_row from parts where uid = v_uid;
  return jsonb_build_object('ok', true, 'part', to_jsonb(v_row),
                            'credits', v_credits - p_price);
end $$;

create or replace function parts_store_bound() returns trigger language plpgsql as $$
begin
  if new.source = 'store' then new.bound := true; end if;
  return new;
end $$;
drop trigger if exists parts_store_bound on parts;
create trigger parts_store_bound before insert or update of source, bound on parts
  for each row execute function parts_store_bound();

-- store parts already on the auction come down first (the part never left its owner)
update listings set status = 'cancelled', resolved_at = now()
 where status = 'active'
   and part_uid in (select uid from parts where source = 'store');

update parts set bound = true where source = 'store' and not bound;

notify pgrst, 'reload schema';
