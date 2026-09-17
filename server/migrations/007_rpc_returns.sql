-- ============================================================
-- 007: RPCs return what changed, so the client stops refetching everything
--
-- loadCloudProfile() pulls the player row AND every parts row. resyncProfile()
-- called it after every scrap / list / buy / cancel, so a 200-part inventory
-- meant ~70 KB of egress per economy action. On Supabase's 5 GB free tier that
-- becomes the binding limit long before storage does.
--
-- Returning the delta lets the client update in place. The database is still
-- written first and remains the source of truth — a wrong local delta is
-- corrected by the next cloud load, so this trades no correctness for the saving.
--
-- Return types change, so these must be dropped before being recreated.
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

-- cancel_listing -> the freed part's uid, so the client can untag it locally
drop function if exists cancel_listing(uuid);
create function cancel_listing(p_listing uuid)
returns uuid language plpgsql security definer as $$
declare v_part uuid;
begin
  update listings set status = 'cancelled', resolved_at = now()
   where id = p_listing and status = 'active'
     and seller_id = (select id from players where auth_uid = auth.uid())
  returning part_uid into v_part;
  if v_part is null then raise exception 'not cancellable'; end if;
  return v_part;
end $$;

-- buy_listing -> the purchased part row and the price paid
drop function if exists buy_listing(uuid);
create function buy_listing(p_listing uuid)
returns jsonb language plpgsql security definer as $$
declare v listings%rowtype; v_buyer uuid; v_part parts%rowtype;
begin
  select id into v_buyer from players where auth_uid = auth.uid();
  select * into v from listings where id = p_listing and status = 'active' for update;
  if v.id is null then raise exception 'listing gone'; end if;
  if v.seller_id = v_buyer then raise exception 'own listing'; end if;
  if parts_held(v_buyer) >= part_cap() then raise exception 'parts locker full'; end if;

  update players set credits = credits - v.price where id = v_buyer;
  update players set credits = credits + v.price where id = v.seller_id;
  update parts set owner_id = v_buyer, equipped = false where uid = v.part_uid;
  update listings set status = 'sold', buyer_id = v_buyer, resolved_at = now() where id = v.id;

  select * into v_part from parts where uid = v.part_uid;
  return jsonb_build_object('price', v.price, 'part', to_jsonb(v_part));
end $$;

notify pgrst, 'reload schema';
