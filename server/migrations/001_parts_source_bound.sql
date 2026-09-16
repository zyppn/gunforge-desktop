-- ============================================================
-- 001: add parts.source and parts.bound
--
-- Why: server/supabase-admin.js grantReward() has always sent
-- `source` and `bound` in its POST /rest/v1/parts body, but the
-- parts table never had those columns. PostgREST rejects unknown
-- fields with 400 / PGRST204, so EVERY part insert silently failed.
--
-- Run this once in the Supabase SQL editor (Database -> SQL Editor).
-- Safe to re-run: every statement is idempotent.
-- ============================================================

alter table parts add column if not exists source text    not null default 'pvp';
alter table parts add column if not exists bound  boolean not null default false;

-- Bound parts are account-locked and must not reach the auction house.
-- list_part previously only checked `equipped`; now it rejects bound too.
create or replace function list_part(p_part uuid, p_price int)
returns uuid language plpgsql security definer as $$
declare v_seller uuid; v_listing uuid;
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
  insert into listings (part_uid, seller_id, price) values (p_part, v_seller, p_price)
  returning id into v_listing;
  return v_listing;
end $$;

-- PostgREST caches the schema; nudge it so the new columns are visible immediately.
notify pgrst, 'reload schema';
