-- ============================================================
-- 012: let a part that has listing HISTORY be scrapped.
--
-- The bug, exactly as the player sees it:
--
--   SCRAP FAILED - update or delete on table "parts" violates foreign key
--   constraint "listings_part_uid_fkey" on table "listings"
--
-- listings.part_uid is `references parts(uid)` with no ON DELETE clause, so it
-- defaults to NO ACTION: the part row cannot be deleted while ANY listing row
-- points at it. scrap_part only ever guarded against an ACTIVE listing:
--
--   if exists (select 1 from listings where part_uid = p_part and status = 'active')
--     then raise exception 'part is listed - cancel the listing first';
--
-- So 'active' gets a clean message and the other two statuses hit the raw
-- constraint. That means:
--
--   * List a part, cancel the listing -> that part can never be scrapped again.
--   * Buy a part at auction -> buy_listing moves owner_id to the buyer and
--     leaves the sold listing pointing at it, so EVERY part anyone has ever
--     bought at auction is permanently unscrappable for its new owner.
--
-- Neither is recoverable in-game and neither says anything useful; the player
-- just gets a Postgres error on a button that should work.
--
-- The fix is ON DELETE SET NULL, not ON DELETE CASCADE. Once a listing is sold
-- it stops being a pointer to a part and becomes a receipt - and 011's
-- backpay_sellers() walks exactly those rows:
--
--   select l.id, l.seller_id, l.price from listings l
--    where l.status = 'sold' and l.seller_paid = false
--
-- Cascading would delete unpaid sale rows as a side effect of someone tidying
-- their locker, and the seller would silently never be paid. Setting the
-- pointer null keeps the price, the seller, the buyer and seller_paid intact.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- STEP 1  a receipt may outlive the part it was for
-- ------------------------------------------------------------
alter table listings alter column part_uid drop not null;

alter table listings drop constraint if exists listings_part_uid_fkey;
alter table listings
  add constraint listings_part_uid_fkey
  foreign key (part_uid) references parts(uid) on delete set null;

-- ------------------------------------------------------------
-- STEP 2  but an ACTIVE listing must still point at something
-- ------------------------------------------------------------
-- Without this, SET NULL would happily orphan a live listing: it would sit on
-- the auction board with no part behind it, and buy_listing would transfer
-- nothing. scrap_part's guard already refuses that case with a readable
-- message - this is the backstop for any path that forgets to.
alter table listings drop constraint if exists listings_active_has_part;
alter table listings
  add constraint listings_active_has_part
  check (status <> 'active' or part_uid is not null);

-- ------------------------------------------------------------
-- STEP 3  diagnostics
-- ------------------------------------------------------------
-- Should print: delete_rule = SET NULL
select tc.constraint_name, rc.delete_rule
  from information_schema.table_constraints tc
  join information_schema.referential_constraints rc
    on rc.constraint_name = tc.constraint_name
 where tc.table_name = 'listings' and tc.constraint_name = 'listings_part_uid_fkey';

-- How many parts were stuck. Every one of these was unscrappable before this ran.
select count(*) as parts_that_were_unscrappable
  from parts p
 where exists (select 1 from listings l
                where l.part_uid = p.uid and l.status <> 'active');
