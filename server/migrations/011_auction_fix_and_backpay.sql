-- ============================================================
-- 011: fix the auction, then pay back everything it destroyed.
--
-- Self-contained and idempotent. If you run only one file, run THIS one - it
-- includes everything 009 does, so it does not matter whether 009 was applied.
--
-- The bug: buy_listing is SECURITY DEFINER, but if it is owned by a role that
-- is neither the table owner nor BYPASSRLS - or if players has FORCE ROW LEVEL
-- SECURITY - then inside the function:
--     update players set credits = credits - price where id = buyer   -- own row, allowed
--     update players set credits = credits + price where id = seller  -- other row, 0 rows
-- The buyer is charged, the seller is never paid, and the difference is gone.
-- No statement errors, so nothing ever surfaced.
--
-- Run in the Supabase SQL editor: Dashboard -> SQL Editor -> New query ->
-- paste the whole file -> Run. Then read STEP 4 before paying anyone.
-- ============================================================

-- ------------------------------------------------------------
-- STEP 1  a ledger flag, so back-pay can never run twice
-- ------------------------------------------------------------
-- Existing sold rows default to FALSE: the bug affected every sale made before
-- the fix, so they are all owed. buy_listing sets it TRUE from here on.
alter table listings add column if not exists seller_paid boolean not null default false;

-- ------------------------------------------------------------
-- STEP 2  the fixed buy_listing
-- ------------------------------------------------------------
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
  if v.id is null          then raise exception 'listing gone'; end if;
  if v.seller_id = v_buyer then raise exception 'own listing'; end if;
  if parts_held(v_buyer) >= part_cap() then raise exception 'parts locker full'; end if;

  select credits into v_bal from players where id = v_buyer for update;
  if v_bal is null   then raise exception 'no buyer row'; end if;
  if v_bal < v.price then raise exception 'not enough credits'; end if;

  update players set credits = credits - v.price where id = v_buyer;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'buyer debit touched % rows, not 1 - aborting', n; end if;

  -- THE bug lived here: this silently did nothing and the sale completed anyway.
  update players set credits = credits + v.price where id = v.seller_id;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'seller credit touched % rows, not 1 - aborting (buy_listing cannot write another player''s row; check the function owner)', n;
  end if;

  update parts set owner_id = v_buyer, equipped = false where uid = v.part_uid;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'part transfer touched % rows, not 1 - aborting', n; end if;

  update listings
     set status = 'sold', buyer_id = v_buyer, resolved_at = now(), seller_paid = true
   where id = v.id;

  select * into v_part from parts where uid = v.part_uid;
  return jsonb_build_object('price', v.price, 'part', to_jsonb(v_part),
                            'credits', v_bal - v.price);
end $$;

alter function buy_listing(uuid) owner to postgres;
grant execute on function buy_listing(uuid) to authenticated;

-- Same class of write in these two. Point them at the same owner so one broken
-- assumption cannot survive in a corner nobody has exercised yet.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'scrap_part')     then execute 'alter function scrap_part(uuid) owner to postgres'; end if;
  if exists (select 1 from pg_proc where proname = 'cancel_listing') then execute 'alter function cancel_listing(uuid) owner to postgres'; end if;
exception when others then raise notice 'owner fixup skipped: %', sqlerrm;
end $$;

-- ------------------------------------------------------------
-- STEP 3  the back-pay, as a function you call deliberately
-- ------------------------------------------------------------
-- Idempotent: it only touches rows with seller_paid = false and flips them, so
-- running it twice pays nobody twice. Atomic: a function body is one
-- transaction, and a credit that fails to land aborts the whole run rather than
-- paying some sellers and losing others.
drop function if exists backpay_sellers();
create function backpay_sellers()
returns table(seller uuid, callsign text, sales bigint, credits_paid bigint)
language plpgsql
security definer
set search_path = public
as $$
declare r record; n int;
begin
  drop table if exists _bp_owed;
  create temp table _bp_owed as
    select l.id, l.seller_id, l.price
      from listings l
     where l.status = 'sold' and l.seller_paid = false;

  create temp table _bp_done(seller uuid, sales bigint, amount bigint);

  for r in select o.seller_id, count(*) as sales, sum(o.price) as amount
             from _bp_owed o group by o.seller_id loop
    update players set credits = credits + r.amount where id = r.seller_id;
    get diagnostics n = row_count;
    if n <> 1 then
      raise exception 'back-pay to % touched % rows, not 1 - aborting the whole run', r.seller_id, n;
    end if;
    insert into _bp_done values (r.seller_id, r.sales, r.amount);
  end loop;

  update listings set seller_paid = true where id in (select id from _bp_owed);

  return query
    select d.seller, p.callsign, d.sales, d.amount
      from _bp_done d left join players p on p.id = d.seller
     order by d.amount desc;
end $$;
revoke execute on function backpay_sellers() from authenticated, anon;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- STEP 4  read this BEFORE paying anyone
-- ------------------------------------------------------------
-- Is the fix live? has_009 must be true and owner should be postgres.
select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
       p.prosrc like '%seller credit touched%' as has_fix
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('buy_listing','scrap_part','cancel_listing')
 order by p.proname;

-- FORCE ROW LEVEL SECURITY defeats SECURITY DEFINER even for the table owner.
-- If rls_forced is true, that is the cause and it has to come off.
select relname, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
  from pg_class where relname = 'players';

-- Who is owed what, and the total. NOTHING HAS BEEN PAID YET at this point.
select l.seller_id, pl.callsign, count(*) as sales, sum(l.price) as credits_owed,
       min(l.resolved_at) as first_sale, max(l.resolved_at) as last_sale
  from listings l left join players pl on pl.id = l.seller_id
 where l.status = 'sold' and l.seller_paid = false
 group by l.seller_id, pl.callsign
 order by credits_owed desc;

-- When that list looks right, run this ON ITS OWN, once:
--     select * from backpay_sellers();
-- It returns exactly who it paid and how much. Run it twice and the second call
-- returns nothing, because there is nothing left owing.
