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
  created_at    timestamptz not null default now(),
  equipped        jsonb not null default '{}',   -- {weaponId:{slot:partUid}} - loadout, survives devices
  equipped_weapon text,                          -- currently selected weapon id
  stats           jsonb not null default '{}'    -- {kills,deaths,matches,wins}, written by add_progress
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
  ability       text,                             -- rolled on rare+ drops, null otherwise
  equipped      boolean not null default false,
  source        text not null default 'pvp',      -- where the drop came from ('pvp', 'quest', ...)
  bound         boolean not null default false,   -- soulbound: cannot be auctioned
  created_at    timestamptz not null default now()
);
create index if not exists parts_owner on parts(owner_id);

-- ---- auction listings ----
create table if not exists listings (
  id            uuid primary key default gen_random_uuid(),
  -- ON DELETE SET NULL, not the default NO ACTION: a sold listing is a receipt,
  -- and a receipt outlives the part. With NO ACTION the part could never be
  -- deleted again, so anything ever listed - or ever BOUGHT at auction - was
  -- permanently unscrappable. Not CASCADE: backpay_sellers() pays out of these
  -- rows, so cascading would erase an unpaid sale when someone tidies a locker.
  -- Nullable for the same reason. See migration 012.
  part_uid      uuid references parts(uid) on delete set null,
  -- CASCADE: the only reason to delete a player is that they asked to be erased,
  -- and their own listings are their data. Also forced: parts.owner_id cascades, so
  -- their parts go first, and the check below then refuses to leave an ACTIVE
  -- listing pointing at nothing. See migration 013.
  seller_id     uuid not null references players(id) on delete cascade,
  price         int  not null check (price between 1 and 1000000),
  status        text not null default 'active' check (status in ('active','sold','cancelled')),
  -- SET NULL, not cascade: a sale is not the BUYER's row to erase. The seller may
  -- still be owed credits on it, and this row is the only record it happened.
  buyer_id      uuid references players(id) on delete set null,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
-- SET NULL must never orphan a LIVE listing: it would sit on the board with no
-- part behind it and buy_listing would transfer nothing.
alter table listings drop constraint if exists listings_active_has_part;
alter table listings add constraint listings_active_has_part
  check (status <> 'active' or part_uid is not null);
create index if not exists listings_active on listings(status) where status = 'active';

-- ============================================================
-- Atomic auction RPCs — all economy mutations go through these,
-- so a hacked client can never mint credits or duplicate parts.
-- ============================================================

create or replace function list_part(p_part uuid, p_price int)
returns uuid language plpgsql security definer as $$
declare v_seller uuid; v_listing uuid;
begin
  select owner_id into v_seller from parts where uid = p_part and not equipped and not bound for update;
  if v_seller is null then raise exception 'part not found, equipped, or soulbound'; end if;
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
