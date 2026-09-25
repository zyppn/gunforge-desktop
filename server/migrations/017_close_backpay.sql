-- ============================================================
-- 017: close backpay_sellers() for real.
--
-- 011 ran `revoke execute ... from authenticated, anon` - but Postgres grants
-- EXECUTE on new functions to PUBLIC, and every role inherits PUBLIC, so the
-- revoke changed nothing: the privilege check on the live project still read
-- true/true for both. It is idempotent (it only pays sales still owed, and flips
-- them) so it could never mint credits, but it is an admin tool that returns every
-- seller's callsign and earnings to whoever calls it.
--
-- The lesson for every future server-only function: revoke from PUBLIC as well.
-- ============================================================
revoke execute on function backpay_sellers() from public, anon, authenticated;
grant  execute on function backpay_sellers() to service_role;
notify pgrst, 'reload schema';
