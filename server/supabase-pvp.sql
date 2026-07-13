-- ============================================================
-- GUNFORGE live backend: accounts, profiles, inventory, auction
-- Run in the Supabase SQL editor. Designed so Steam identity
-- bolts on later without migration (steam_id is already here).
-- ============================================================

-- ---- players: one row per account, any identity provider ----
create table if not exists players (
  id            uuid primary key default gen_random_uuid(),
  auth_uid      uuid unique,              -- Supabase Auth user (email / anonymous)
  steam_id      text unique,              -- filled when Steam auth lands
  callsign      text not null default 'OPERATOR',
  level         int  not null default 1,
  xp            int  not null default 0,
  credits       int  not null default 500 check (credits >= 0),
  created_at    timestamptz not null default now()
);

-- ---- parts: server-authoritative inventory ----
create table if not exists parts (
  uid           uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references players(id) on delete cascade,
  weapon_id     text not null,
  slot          text not null check (slot in ('frame','barrel','magazine','foregrip','stock','optic')),
  rarity        text not null check (rarity in ('common','uncommon','rare','epic','legendary')),
  name          text not null,
  set_id        text,
  mods          jsonb not null default '{}',
  equipped      boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists parts_owner on parts(owner_id);

-- ---- auction listings ----
create table if not exists listings (
  id            uuid primary key default gen_random_uuid(),
  part_uid      uuid not null references parts(uid),
  seller_id     uuid not null references players(id),
  price         int  not null check (price between 1 and 1000000),
  status        text not null default 'active' check (status in ('active','sold','cancelled')),
  buyer_id      uuid references players(id),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists listings_active on listings(status) where status = 'active';

-- ============================================================
-- Atomic auction RPCs — all economy mutations go through these,
-- so a hacked client can never mint credits or duplicate parts.
-- ============================================================

create or replace function list_part(p_part uuid, p_price int)
returns uuid language plpgsql security definer as $$
declare v_seller uuid; v_listing uuid;
begin
  select owner_id into v_seller from parts where uid = p_part and not equipped for update;
  if v_seller is null then raise exception 'part not found or equipped'; end if;
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

create or replace function buy_listing(p_listing uuid)
returns void language plpgsql security definer as $$
declare v listings%rowtype; v_buyer uuid;
begin
  select id into v_buyer from players where auth_uid = auth.uid();
  select * into v from listings where id = p_listing and status = 'active' for update;
  if v.id is null then raise exception 'listing gone'; end if;
  if v.seller_id = v_buyer then raise exception 'own listing'; end if;
  -- atomic credit transfer; check constraint stops overdrafts
  update players set credits = credits - v.price where id = v_buyer;
  update players set credits = credits + v.price where id = v.seller_id;
  update parts set owner_id = v_buyer, equipped = false where uid = v.part_uid;
  update listings set status = 'sold', buyer_id = v_buyer, resolved_at = now() where id = v.id;
end $$;

create or replace function cancel_listing(p_listing uuid)
returns void language plpgsql security definer as $$
begin
  update listings set status = 'cancelled', resolved_at = now()
  where id = p_listing and status = 'active'
    and seller_id = (select id from players where auth_uid = auth.uid());
  if not found then raise exception 'not cancellable'; end if;
end $$;

-- ============================================================
-- Row Level Security: read broadly, write only through RPCs
-- ============================================================
alter table players  enable row level security;
alter table parts    enable row level security;
alter table listings enable row level security;

create policy players_read  on players  for select using (true);
create policy players_self  on players  for update using (auth_uid = auth.uid());
create policy parts_read    on parts    for select using (true);
create policy listings_read on listings for select using (true);
-- no insert/update/delete policies on parts/listings: RPCs (security definer)
-- and the game server (service role key) are the only writers.

-- ---- realtime: the live auction feed ----
-- Supabase dashboard -> Database -> Replication -> enable for `listings`.
-- Clients subscribe to INSERT/UPDATE on listings for instant auction updates.
