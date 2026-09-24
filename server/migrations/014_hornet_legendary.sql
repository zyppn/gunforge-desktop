-- ============================================================
-- 014: Hornet Swarm becomes a LEGENDARY set — bring existing pieces with it.
--
-- The set's rarity now reads 'legendary' in loadout-core, so every Hornet piece
-- that DROPS from here on is stamped legendary and its mods are rolled at the
-- legendary scale (4.0) instead of epic (3.0).
--
-- Pieces already in players' lockers were rolled at 3.0 and stored with those
-- numbers baked in - mods are a stored jsonb column, not derived at read time.
-- Without this migration an old Hornet Sting is strictly worse than a new one
-- while looking identical on the card, which is the most annoying possible way
-- to ship a buff.
--
-- So: bump the rarity AND rescale the mods by 4.0/3.0, matching exactly what
-- scaleMods() would have produced at legendary (it rounds to 3 decimals).
--
-- Safe to run before or after the client update; the two are independent. Run
-- it late and players briefly see epic-coloured Hornet pieces, nothing worse.
--
-- Idempotent: the rarity guard means a second run matches no rows.
-- Run in the Supabase SQL editor.
-- ============================================================

-- what is about to change
select count(*) as hornet_pieces_to_convert
  from parts where set_id = 'hornet' and rarity = 'epic';

update parts p
   set rarity = 'legendary',
       -- jsonb_object_agg over an empty mods object returns NULL, and mods is NOT
       -- NULL; coalesce keeps a modless part legal rather than failing the update.
       mods = coalesce((
         select jsonb_object_agg(k, to_jsonb(round(v::numeric * 4.0 / 3.0, 3)))
           from jsonb_each_text(p.mods) as e(k, v)
       ), '{}'::jsonb)
 where p.set_id = 'hornet'
   and p.rarity = 'epic';

-- should be: every Hornet piece legendary, none left epic
select rarity, count(*) from parts where set_id = 'hornet' group by rarity;

-- spot check the rescale: a legendary Hornet piece's mods should now sit at 4/3 of
-- what an epic roll of the same template would be
select name, rarity, mods from parts where set_id = 'hornet' order by created_at limit 5;
