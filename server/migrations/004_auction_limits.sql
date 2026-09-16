-- ============================================================
-- 004: real auction rules — inventory cap + listing cap
--
-- Context: the client has been keeping listings in a gunforge_kv JSON blob
-- instead of the `listings` table, so list_part/buy_listing/cancel_listing were
-- never called and none of these rules existed. This migration puts the rules
-- where they can actually be enforced; the client moves onto the RPCs next.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

-- One place both the server and the RPCs read the cap from.
create or replace function part_cap() returns int language sql immutable as $$
  select 200;
$$;

-- Parts that occupy locker space. A part with an ACTIVE listing is escrowed:
-- still owned, still returnable on cancel, but not counted against the cap.
create or replace function parts_held(p_player uuid) returns int
language sql stable as $$
  select count(*)::int
    from parts p
   where p.owner_id = p_player
     and not exists (
       select 1 from listings l
        where l.part_uid = p.uid and l.status = 'active'
     );
$$;

-- list_part v2: rejects equipped parts, soulbound parts, duplicates, and
-- anything past the seller's concurrent-listing cap.
create or replace function list_part(p_part uuid, p_price int)
returns uuid language plpgsql security definer as $$
declare v_seller uuid; v_listing uuid; v_active int;
begin
  select owner_id into v_seller
    from parts
   where uid = p_part and not equipped and not bound
     for update;
  if v_seller is null then
    raise exception 'part not found, equipped, or soulbound';
  end if;
  if v_seller <> (select id from players where auth_uid = auth.uid()) then
    raise exception 'not your part';
  end if;
  if exists (select 1 from listings where part_uid = p_part and status = 'active') then
    raise exception 'already listed';
  end if;
  select count(*) into v_active from listings
   where seller_id = v_seller and status = 'active';
  if v_active >= 3 then
    raise exception 'listing limit reached (3 active)';
  end if;
  insert into listings (part_uid, seller_id, price) values (p_part, v_seller, p_price)
  returning id into v_listing;
  return v_listing;
end $$;

-- buy_listing v2: same atomic transfer, plus the buyer's locker must have room.
create or replace function buy_listing(p_listing uuid)
returns void language plpgsql security definer as $$
declare v listings%rowtype; v_buyer uuid;
begin
  select id into v_buyer from players where auth_uid = auth.uid();
  select * into v from listings where id = p_listing and status = 'active' for update;
  if v.id is null then raise exception 'listing gone'; end if;
  if v.seller_id = v_buyer then raise exception 'own listing'; end if;
  if parts_held(v_buyer) >= part_cap() then
    raise exception 'parts locker full';
  end if;
  -- atomic credit transfer; the credits >= 0 check constraint stops overdrafts
  update players set credits = credits - v.price where id = v_buyer;
  update players set credits = credits + v.price where id = v.seller_id;
  update parts set owner_id = v_buyer, equipped = false where uid = v.part_uid;
  update listings set status = 'sold', buyer_id = v_buyer, resolved_at = now() where id = v.id;
end $$;

notify pgrst, 'reload schema';
