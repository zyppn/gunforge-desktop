-- ============================================================
-- 010: is 009 actually live, and what did the bug cost?
--
-- 009 diagnosed and fixed the auction destroying credits, but it is a file in
-- this repo, not a change to the database. It only takes effect when it is run
-- in the Supabase SQL editor. A purchase that completes with the seller unpaid
-- is proof it has NOT been run: with 009 in place that same purchase aborts
-- loudly with "seller credit touched 0 rows" and the client shows
-- PURCHASE FAILED, because buyListing surfaces the RPC error rather than
-- swallowing it.
--
-- READ-ONLY. Nothing here writes. Run it, read it, then decide.
-- ============================================================

-- 1. Is the fix live? Expect has_009 = true AFTER running 009.
select
  p.proname,
  pg_get_userbyid(p.proowner)                      as owner,
  p.prosecdef                                      as security_definer,
  p.prosrc like '%seller credit touched%'          as has_009
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('buy_listing','scrap_part','cancel_listing')
order by p.proname;

-- 2. Does players have FORCE ROW LEVEL SECURITY? That defeats SECURITY DEFINER
--    even for the table owner, and is the other way this breaks.
select relname, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class where relname = 'players';

-- 3. What the bug cost, per seller. Every sold listing owes its seller the price;
--    this is the total owed, which is also exactly the credits destroyed.
--    If 009 has been live for a while, the older rows here are already paid and
--    this OVERSTATES the debt - so read it together with the sold_at dates and
--    only count sales from before 009 was applied.
select
  l.seller_id,
  pl.callsign,
  count(*)                       as sales,
  sum(l.price)                   as credits_owed,
  min(l.resolved_at)             as first_sale,
  max(l.resolved_at)             as last_sale
from listings l
left join players pl on pl.id = l.seller_id
where l.status = 'sold'
group by l.seller_id, pl.callsign
order by credits_owed desc;

-- 4. The same thing as one number, for a quick read.
select count(*) as sold_listings, coalesce(sum(price), 0) as total_credits_at_stake
from listings where status = 'sold';
