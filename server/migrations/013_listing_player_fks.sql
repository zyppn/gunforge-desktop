-- ============================================================
-- 013: say what happens to a listing when a player is deleted.
--
-- listings.seller_id and listings.buyer_id were both plain `references
-- players(id)` with no ON DELETE - the same omission that made every
-- auction-bought part unscrappable in 012, one level up. Dormant, because
-- nothing in this codebase deletes a player row and players.auth_uid is a bare
-- uuid with no link to auth.users, so deleting a Supabase auth account does not
-- reach these tables either. The day account deletion is added, it fails, and
-- the thing that fails is somebody's whole account rather than one part.
--
-- The two sides are not symmetric:
--
--   seller_id -> CASCADE. The only reason to delete a player is that they asked
--     to be erased, and their own listings are their data. It also has to be
--     cascade in practice: parts.owner_id already cascades, so their parts go
--     first, and 012's check constraint then refuses to leave an ACTIVE listing
--     pointing at nothing - the delete would abort halfway.
--
--   buyer_id -> SET NULL. A sale is not the buyer's row to erase. The seller may
--     still be owed credits on it (backpay_sellers reads status and seller_paid,
--     never buyer_id), and the listing is the only record the sale happened. The
--     column is already nullable, so this costs nothing.
--
-- Run in the Supabase SQL editor, after 012. Idempotent.
-- ============================================================

alter table listings drop constraint if exists listings_seller_id_fkey;
alter table listings
  add constraint listings_seller_id_fkey
  foreign key (seller_id) references players(id) on delete cascade;

alter table listings drop constraint if exists listings_buyer_id_fkey;
alter table listings
  add constraint listings_buyer_id_fkey
  foreign key (buyer_id) references players(id) on delete set null;

-- Should print three rows: part_uid SET NULL, seller_id CASCADE, buyer_id SET NULL.
select tc.constraint_name, rc.delete_rule
  from information_schema.table_constraints tc
  join information_schema.referential_constraints rc
    on rc.constraint_name = tc.constraint_name
 where tc.table_name = 'listings'
 order by tc.constraint_name;
