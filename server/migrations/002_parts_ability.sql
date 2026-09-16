-- ============================================================
-- 002: add parts.ability
--
-- rollServerDrop now rolls abilities (and set pieces) the same way the
-- client's rollDrop always did. The client already reads r.ability in
-- partFromRow(), and grantReward() now sends it, so the column has to exist
-- or PostgREST rejects the insert with 400 / PGRST204.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

alter table parts add column if not exists ability text;

notify pgrst, 'reload schema';
